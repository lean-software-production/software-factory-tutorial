#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile as nodeWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildV2JudgePrompt, createV2Report, judgeV2TraceFromPrompt, probeV2JudgeCommandModel, v2JudgePass, type V2JudgeCommandPreflightResult, type V2JudgeResult } from "./v2/judge.js";
import { createEmptyV2SessionTrace, projectV2JudgeTrace } from "./v2/session.js";
import { deterministicV2Gate, runV2ScenarioSession, v2Scenarios, type V2GateResult, type V2Scenario } from "./v2/scenarios.js";
import { V2_ENGINE_EVAL_MARKERS, type EvaluationWorkspace, type V2EvalRunFailureStage, type V2EvalRunStatus, type V2JudgeTrace, type V2SessionTrace } from "./v2/types.js";
import { createEvaluationWorkspace } from "./v2/workspace.js";
import { loadWorkbook } from "../src/workbook/load.js";
import { preflightWorkbookModels, type WorkbookModelPreflightOptions, type WorkbookModelPreflightResult } from "../src/workbook/model-preflight.js";
import { PRACTICE_COACH_LOG_PROMPT_ENV } from "../src/workbook/practice-coach.js";
import { OPENCODE_API_KEY_ENV, WORKBOOK_TERMINAL_IMAGE, DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS, WORKBOOK_TERMINAL_AUTH_PUBLIC_ERROR, assertDockerDaemonAndImage, assertDockerPiAuthentication, dockerClientEnvironment, dockerRunArguments, dockerRunEnvironment, type DockerCommandRunner } from "../src/workbook/terminal.js";
import { createTutorialLogger, type TutorialLogger } from "../src/workbook/runtime-log.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reports = join(root, "evals/reports");

type StartedEvaluationServer = Awaited<ReturnType<EvaluationWorkspace["startServer"]>>;
type EvalWriteFile = (path: string, data: string) => Promise<void>;

export interface V2RunMetadata {
  namespace: typeof V2_ENGINE_EVAL_MARKERS.namespace;
  owner: typeof V2_ENGINE_EVAL_MARKERS.owner;
  suite: typeof V2_ENGINE_EVAL_MARKERS.suite;
  schemaVersion: typeof V2_ENGINE_EVAL_MARKERS.schemaVersion;
  runId: string;
  scenario: string;
  repetition: number;
  status: V2EvalRunStatus;
  failureStage?: V2EvalRunFailureStage;
  failure?: { name: string; message: string; detailsFile?: string; diagnosticStatus: "written" | "write-failed" };
  gitRevision: string;
  node: string;
  modelIdentities: { tutor: string; judge: string };
  timestamps: { started: string; ended?: string };
  lifecycle: {
    workspace: "not-started" | "created" | "failed" | "closed";
    server: "not-started" | "started" | "failed" | "closed";
    session: "not-started" | "started" | "completed" | "failed";
    deterministicGate: "not-run" | "passed" | "failed";
    judge: "not-run" | "input-written" | "completed" | "failed";
    report: "not-written" | "written";
    cleanup: "not-started" | "completed" | "failed";
  };
  identifiers: { sessionId?: string; workspaceIds?: string[] };
  files: Record<string, string>;
}

export interface V2EvalRunResult {
  scenario: string;
  runId: string;
  repetition: number;
  passed: boolean;
  percentage?: number;
  directory: string;
  reportDirectory: string;
  metadataFile?: string;
  reportFile?: string;
  status: V2EvalRunStatus;
  failureStage?: V2EvalRunFailureStage;
  error?: string;
}

export type V2LatestRunResult = Omit<V2EvalRunResult, "directory">;

export interface V2LatestReport {
  namespace: typeof V2_ENGINE_EVAL_MARKERS.namespace;
  owner: typeof V2_ENGINE_EVAL_MARKERS.owner;
  suite: typeof V2_ENGINE_EVAL_MARKERS.suite;
  schemaVersion: typeof V2_ENGINE_EVAL_MARKERS.schemaVersion;
  generatedAt: string;
  results: Array<{ scenario: string; runs: V2LatestRunResult[] }>;
}

export interface V2EvalRunnerDependencies {
  createEvaluationWorkspace?: typeof createEvaluationWorkspace;
  runV2ScenarioSession?: typeof runV2ScenarioSession;
  deterministicV2Gate?: typeof deterministicV2Gate;
  projectV2JudgeTrace?: typeof projectV2JudgeTrace;
  judgeV2TraceFromPrompt?: typeof judgeV2TraceFromPrompt;
  createV2Report?: typeof createV2Report;
  now?: () => Date;
  gitRevision?: () => string;
  runNonce?: () => string;
  writeFile?: EvalWriteFile;
}

export interface V2EvalPreflightFixture {
  contentRoot: string;
  workspaceRoot: string;
  close(): Promise<void>;
}

export interface V2EvalTerminalPreflightResult {
  image: typeof WORKBOOK_TERMINAL_IMAGE;
  capabilities: { dockerInfo: true; imageInspect: true; containerStart: true; piAuthentication: true };
}

export interface V2EvalPreflightResult {
  fixture: { title: string };
  terminal: V2EvalTerminalPreflightResult;
  workbookModels: WorkbookModelPreflightResult[];
  judge: V2JudgeCommandPreflightResult;
}

export interface V2EvalPreflightDependencies {
  createDisposableFixture?: (engineRoot: string) => Promise<V2EvalPreflightFixture>;
  assertTerminalReady?: (fixture: V2EvalPreflightFixture, environment: NodeJS.ProcessEnv) => Promise<V2EvalTerminalPreflightResult>;
  preflightWorkbookModels?: (options: WorkbookModelPreflightOptions) => Promise<WorkbookModelPreflightResult[]>;
  probeJudgeCommandModel?: (environment: NodeJS.ProcessEnv) => Promise<V2JudgeCommandPreflightResult>;
  dockerCommandRunner?: DockerCommandRunner;
  logger?: TutorialLogger;
}

export interface V2EvalCliOptions extends V2EvalRunOptions {
  preflightDependencies?: V2EvalPreflightDependencies;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

export interface V2EvalRunOptions {
  reportsRoot?: string;
  engineRoot?: string;
  dependencies?: V2EvalRunnerDependencies;
}

export function v2EvalUsageText(): string {
  return `Live synthetic tutorial-engine mechanics evals (real tutor and judge model calls; not part of npm test)

Usage from tutorial-engine/:
  npm run eval -- --scenario v2-exact-command-success
  npm run eval -- --all --yes
  npm run eval -- --scenario v2-exact-command-success --repeat 3
  npm run eval -- --release
  npm run eval:release

Usage from the repository root:
  npm run eval:engine -- --scenario v2-exact-command-success
  npm run eval:release
  npm run eval -- --scenario v2-exact-command-success  # temporary compatibility alias

A scope is required. --release runs the bounded six-scenario release profile once per scenario. EVAL_JUDGE_MODEL selects the judge model and is mandatory. TUTOR_MODEL and PRACTICE_COACH_MODEL optionally select the workbook role models. Before any report directory, workspace, tutor session, or judge session is created, the runner fail-fast checks scope/confirmation, judge model, disabled private prompt logging, disposable fixture validity, Docker/workbook-terminal readiness, Tutor and Practice Coach connectivity, and judge command connectivity. Reports are written under tutorial-engine/evals/reports/.`;
}

export type V2EvalScope = "scenario" | "all" | "release";

export interface V2EvalCliPlan {
  scope: V2EvalScope;
  scenarios: V2Scenario[];
  repeat: number;
  requiresAllConfirmation: boolean;
}

export const v2ReleaseScenarioIds = [
  "v2-exact-command-success",
  "v2-editor-feedback-locked",
  "v2-editor-unlocked",
  "v2-clue-only-task",
  "v2-reflection-follow-up",
  "v2-transition-completion"
] as const;

function v2ScenarioById(id: string): V2Scenario {
  const scenario = v2Scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown v2 scenario '${id}'.`);
  return scenario;
}

function optionPositions(args: string[], option: string): number[] {
  return args.flatMap((arg, index) => arg === option ? [index] : []);
}

function requiredOptionValues(args: string[], positions: number[], missingMessage: string): string[] {
  return positions.map((position) => {
    const value = args[position + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(missingMessage);
    return value;
  });
}

export function parseV2EvalArgs(args: string[]): V2EvalCliPlan | undefined {
  const scenarioPositions = optionPositions(args, "--scenario");
  const repeatPositions = optionPositions(args, "--repeat");
  const hasAll = args.includes("--all");
  const hasRelease = args.includes("--release");

  const selectedScenarioIds = requiredOptionValues(args, scenarioPositions, "--scenario requires a scenario id.");
  const repeatValues = requiredOptionValues(args, repeatPositions, "--repeat requires a value.");

  const scopeCount = (hasAll ? 1 : 0) + (hasRelease ? 1 : 0) + (scenarioPositions.length > 0 ? 1 : 0);
  if (scopeCount > 1) throw new Error("Choose exactly one eval scope: --release, --all, or --scenario <id>.");
  if (scopeCount === 0) return undefined;

  if (hasRelease && repeatPositions.length > 0) throw new Error("--release always runs each scenario once; do not combine it with --repeat.");
  if (scenarioPositions.length > 1) throw new Error("Specify --scenario at most once.");
  if (repeatPositions.length > 1) throw new Error("Specify --repeat at most once.");

  let repeat = 1;
  if (repeatPositions.length === 1) {
    repeat = Number(repeatValues[0]);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("--repeat must be 1, 2, or 3.");
  }

  if (hasRelease) {
    return { scope: "release", scenarios: v2ReleaseScenarioIds.map(v2ScenarioById), repeat: 1, requiresAllConfirmation: false };
  }
  if (hasAll) {
    return { scope: "all", scenarios: v2Scenarios, repeat, requiresAllConfirmation: !args.includes("--yes") };
  }
  return { scope: "scenario", scenarios: [v2ScenarioById(selectedScenarioIds[0]!)], repeat, requiresAllConfirmation: false };
}

export function selectV2Scenarios(args: string[]): V2Scenario[] {
  return parseV2EvalArgs(args)?.scenarios ?? [];
}

export function prepareV2EvalCliRun(args: string[], env: NodeJS.ProcessEnv = process.env): V2EvalCliPlan | undefined {
  const plan = parseV2EvalArgs(args);
  if (!plan) return undefined;
  if (plan.requiresAllConfirmation) throw new Error(`--all can spend model tokens across ${v2Scenarios.length} live scenarios. Re-run with --yes to confirm.`);
  if (!env.EVAL_JUDGE_MODEL?.trim()) throw new Error("Set EVAL_JUDGE_MODEL before running paid live evals.");
  return plan;
}

export function assertV2EvalPrivatePromptLoggingDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[PRACTICE_COACH_LOG_PROMPT_ENV] === "1") throw new Error(`Unset ${PRACTICE_COACH_LOG_PROMPT_ENV} before running live evals; private prompt logging is forbidden.`);
}

export async function createDisposableV2EvalPreflightFixture(engineRoot = root): Promise<V2EvalPreflightFixture> {
  const disposableRoot = await mkdtemp(join(tmpdir(), "v2-eval-preflight-"));
  const contentRoot = join(disposableRoot, "tutorial");
  const workspaceRoot = join(disposableRoot, "workspace");
  try {
    await cp(join(engineRoot, "evals/workbook"), contentRoot, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await loadWorkbook(contentRoot);
  } catch (error) {
    await rm(disposableRoot, { recursive: true, force: true });
    throw error;
  }
  return { contentRoot, workspaceRoot, close: async () => { await rm(disposableRoot, { recursive: true, force: true }); } };
}

const V2_EVAL_TERMINAL_CLEANUP_PUBLIC_ERROR = "Live eval preflight failed while cleaning up the disposable workbook terminal container.";
const V2_EVAL_TERMINAL_STARTUP_PUBLIC_ERROR = "Could not start isolated terminal container for the workbook terminal preflight.";
const V2_EVAL_TERMINAL_STARTUP_CLEANUP_PUBLIC_ERROR = "Could not start isolated terminal container for the workbook terminal preflight, and cleanup could not be confirmed.";
const V2_EVAL_TERMINAL_AUTH_CLEANUP_PUBLIC_ERROR = `Could not authenticate Pi with ${OPENCODE_API_KEY_ENV} inside the workbook terminal preflight, and cleanup could not be confirmed.`;

function runDockerCommand(commandRunner: DockerCommandRunner | undefined, args: string[], options: Parameters<DockerCommandRunner>[2]): void {
  if (commandRunner) commandRunner("docker", args, options);
  else execFileSync("docker", args, options);
}

export async function assertV2EvalTerminalReady(fixture: V2EvalPreflightFixture, environment: NodeJS.ProcessEnv = process.env, commandRunner?: DockerCommandRunner): Promise<V2EvalTerminalPreflightResult> {
  const apiKey = environment[OPENCODE_API_KEY_ENV]?.trim();
  if (!apiKey) throw new Error(`Embedded terminal requires ${OPENCODE_API_KEY_ENV}.`);
  const name = `workbook-terminal-preflight-${randomUUID()}`;
  assertDockerDaemonAndImage(commandRunner, environment);
  const args = dockerRunArguments({ workspace: fixture.workspaceRoot, name });
  args.push(WORKBOOK_TERMINAL_IMAGE, "sleep", "infinity");
  let stage: "startup" | "auth" | undefined;
  let stageError: Error | undefined;
  let cleanupFailed = false;
  let runAttempted = false;
  try {
    runAttempted = true;
    try { runDockerCommand(commandRunner, args, { stdio: "ignore", env: dockerRunEnvironment(apiKey, environment), timeout: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.containerStart }); }
    catch { stage = "startup"; stageError = new Error(V2_EVAL_TERMINAL_STARTUP_PUBLIC_ERROR); }
    if (!stageError) {
      try { assertDockerPiAuthentication(name, commandRunner, environment); }
      catch { stage = "auth"; stageError = new Error(WORKBOOK_TERMINAL_AUTH_PUBLIC_ERROR); }
    }
  } finally {
    if (runAttempted) {
      try { runDockerCommand(commandRunner, ["rm", "-f", name], { stdio: "ignore", env: dockerClientEnvironment(environment), timeout: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.cleanup }); }
      catch { cleanupFailed = true; }
    }
  }
  if (stageError) {
    if (cleanupFailed && stage === "startup") throw new Error(V2_EVAL_TERMINAL_STARTUP_CLEANUP_PUBLIC_ERROR);
    if (cleanupFailed && stage === "auth") throw new Error(V2_EVAL_TERMINAL_AUTH_CLEANUP_PUBLIC_ERROR);
    throw stageError;
  }
  if (cleanupFailed) throw new Error(V2_EVAL_TERMINAL_CLEANUP_PUBLIC_ERROR);
  return { image: WORKBOOK_TERMINAL_IMAGE, capabilities: { dockerInfo: true, imageInspect: true, containerStart: true, piAuthentication: true } };
}

async function safeV2EvalPreflightStage<T>(action: () => Promise<T>, publicMessage: string): Promise<T> {
  try { return await action(); }
  catch { throw new Error(publicMessage); }
}

export async function preflightV2EvalLiveEngine(options: { plan: V2EvalCliPlan; engineRoot?: string; environment?: NodeJS.ProcessEnv; dependencies?: V2EvalPreflightDependencies }): Promise<V2EvalPreflightResult> {
  void options.plan;
  const environment = options.environment ?? process.env;
  const deps = options.dependencies ?? {};
  const logger = deps.logger ?? createTutorialLogger();
  assertV2EvalPrivatePromptLoggingDisabled(environment);
  const fixture = await safeV2EvalPreflightStage(
    () => (deps.createDisposableFixture ?? createDisposableV2EvalPreflightFixture)(options.engineRoot ?? root),
    "Live eval preflight failed while validating the disposable evaluator fixture."
  );
  let preflightError: unknown;
  try {
    const workbook = await safeV2EvalPreflightStage(
      () => loadWorkbook(fixture.contentRoot),
      "Live eval preflight failed while validating the disposable evaluator fixture."
    );
    const terminal = await safeV2EvalPreflightStage(
      () => deps.assertTerminalReady ? deps.assertTerminalReady(fixture, environment) : assertV2EvalTerminalReady(fixture, environment, deps.dockerCommandRunner),
      "Live eval preflight failed while checking Docker and workbook terminal readiness."
    );
    const workbookModels = await safeV2EvalPreflightStage(
      () => (deps.preflightWorkbookModels ?? preflightWorkbookModels)({ contentRoot: fixture.contentRoot, workspaceRoot: fixture.workspaceRoot, logger, environment }),
      "Live eval preflight failed while checking Tutor and Practice Coach model connectivity."
    );
    const judge = await safeV2EvalPreflightStage(
      () => (deps.probeJudgeCommandModel ?? probeV2JudgeCommandModel)(environment),
      "Live eval preflight failed while checking judge command/model connectivity."
    );
    return { fixture: { title: workbook.identity.title }, terminal, workbookModels, judge };
  } catch (error) {
    preflightError = error;
    throw error;
  } finally {
    try { await fixture.close(); }
    catch {
      if (!preflightError) throw new Error("Live eval preflight failed while cleaning up the disposable preflight fixture.");
    }
  }
}

function modelIdentities(environment: NodeJS.ProcessEnv = process.env): { tutor: string; judge: string } {
  return { tutor: environment.TUTOR_MODEL ?? "tutorial default", judge: environment.EVAL_JUDGE_MODEL ?? "unset" };
}

function unixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function defaultGitRevision(engineRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: engineRoot }).toString().trim();
}

function safeNowIso(now: () => Date): string {
  try { return now().toISOString(); }
  catch { return new Date().toISOString(); }
}

function safeRunNonce(nonce: () => string): string {
  try { return nonce(); }
  catch { return randomUUID().slice(0, 8); }
}

function safeLatestSession(workspace: EvaluationWorkspace | undefined): ReturnType<EvaluationWorkspace["latestSession"]> | undefined {
  if (!workspace) return undefined;
  try { return workspace.latestSession(); }
  catch { return undefined; }
}

function diagnosticResourceLocations(workspace: EvaluationWorkspace | undefined, server: StartedEvaluationServer | undefined): string {
  const lines: string[] = [];
  if (server) lines.push(`serverUrl: ${server.url}`);
  if (workspace) {
    lines.push(`repositoryRoot: ${workspace.repositoryRoot}`);
    lines.push(`contentRoot: ${workspace.root}`);
    lines.push(`webRoot: ${workspace.webRoot}`);
  }
  const session = safeLatestSession(workspace);
  if (session) {
    lines.push(`sessionRoot: ${session.sessionRoot}`);
    lines.push(`workspacesRoot: ${session.workspacesRoot}`);
    for (const [workspaceId, workspaceRoot] of Object.entries(session.workspaceRoots).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`workspaceRoot.${workspaceId}: ${workspaceRoot}`);
    }
  }
  return lines.length ? `\n\nLeaked-resource locations (diagnostic-only; do not publish blindly):\n${lines.join("\n")}\n` : "";
}

function publicFailureMessage(stage: V2EvalRunFailureStage): string {
  switch (stage) {
    case "workspace-creation": return "Evaluation failed while creating the disposable workspace; diagnostic status is recorded in metadata.";
    case "server-startup": return "Evaluation failed while starting the workbook server; diagnostic status is recorded in metadata.";
    case "session": return "Evaluation failed while driving the scenario session; diagnostic status is recorded in metadata.";
    case "deterministic-gate": return "Deterministic gate failed before judge invocation; diagnostic status is recorded in metadata.";
    case "judge": return "Evaluation failed during judge invocation or judge verdict; diagnostic status is recorded in metadata.";
    case "report": return "Evaluation failed while writing report artifacts; diagnostic status is recorded in metadata.";
    case "cleanup": return "Evaluation failed during cleanup; diagnostic status is recorded in metadata.";
    case "metadata": return "Evaluation completed but per-run metadata could not be written.";
    case "unexpected": return "Evaluation failed unexpectedly; diagnostic status is recorded in metadata.";
  }
}

function createRunMetadata(options: {
  scenario: V2Scenario;
  repetition: number;
  runId: string;
  status: V2EvalRunStatus;
  failureStage?: V2EvalRunFailureStage;
  failure?: { name: string; message: string; detailsFile?: string; diagnosticStatus: "written" | "write-failed" };
  started: string;
  ended?: string;
  gitRevision: string;
  lifecycle: V2RunMetadata["lifecycle"];
  workspace?: EvaluationWorkspace;
  files: Record<string, string>;
  environment?: NodeJS.ProcessEnv;
}): V2RunMetadata {
  const session = safeLatestSession(options.workspace);
  return {
    ...V2_ENGINE_EVAL_MARKERS,
    runId: options.runId,
    scenario: options.scenario.id,
    repetition: options.repetition,
    status: options.status,
    ...(options.failureStage === undefined ? {} : { failureStage: options.failureStage }),
    ...(options.failure === undefined ? {} : { failure: options.failure }),
    gitRevision: options.gitRevision,
    node: process.version,
    modelIdentities: modelIdentities(options.environment),
    timestamps: options.ended === undefined ? { started: options.started } : { started: options.started, ended: options.ended },
    lifecycle: options.lifecycle,
    identifiers: {
      ...(session?.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      ...(session?.workspaceRoots === undefined ? {} : { workspaceIds: Object.keys(session.workspaceRoots).sort() })
    },
    files: options.files
  };
}

async function writeJson(writeFile: EvalWriteFile, path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function tryWriteText(writeFile: EvalWriteFile, path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text);
    return true;
  } catch {
    return false;
  }
}

export function createV2LatestReport(results: Array<{ scenario: string; runs: V2EvalRunResult[] }>, generatedAt = new Date().toISOString()): V2LatestReport {
  return {
    ...V2_ENGINE_EVAL_MARKERS,
    generatedAt,
    results: results.map(({ scenario, runs }) => ({
      scenario,
      runs: runs.map((run) => ({
        scenario: run.scenario,
        runId: run.runId,
        repetition: run.repetition,
        passed: run.passed,
        ...(run.percentage === undefined ? {} : { percentage: run.percentage }),
        reportDirectory: run.reportDirectory,
        ...(run.metadataFile === undefined ? {} : { metadataFile: run.metadataFile }),
        ...(run.reportFile === undefined ? {} : { reportFile: run.reportFile }),
        status: run.status,
        ...(run.failureStage === undefined ? {} : { failureStage: run.failureStage }),
        ...(run.error === undefined ? {} : { error: run.error })
      }))
    }))
  };
}

export async function runV2EvalOnce(scenario: V2Scenario, repetition: number, options: V2EvalRunOptions = {}): Promise<V2EvalRunResult> {
  const deps = options.dependencies ?? {};
  const writeFile = deps.writeFile ?? nodeWriteFile;
  const now = deps.now ?? (() => new Date());
  const engineRoot = options.engineRoot ?? root;
  const reportsRoot = options.reportsRoot ?? reports;
  const environment = process.env;
  const started = safeNowIso(now);
  const runNonce = safeRunNonce(deps.runNonce ?? (() => randomUUID().slice(0, 8))).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "run";
  const runId = `${started.replace(/[:.]/g, "-")}-${scenario.id}-${repetition}-${runNonce}`;
  const directory = join(reportsRoot, runId);
  const reportDirectory = unixRelative(engineRoot, directory);
  const metadataFileName = "metadata.json";
  const lifecycle: V2RunMetadata["lifecycle"] = {
    workspace: "not-started",
    server: "not-started",
    session: "not-started",
    deterministicGate: "not-run",
    judge: "not-run",
    report: "not-written",
    cleanup: "not-started"
  };
  const files: Record<string, string> = {};
  let failureStage: V2EvalRunFailureStage = "workspace-creation";
  let workspace: EvaluationWorkspace | undefined;
  let server: StartedEvaluationServer | undefined;
  let trace: V2SessionTrace | undefined;
  let judgeTrace: V2JudgeTrace | undefined;
  let gate: V2GateResult | undefined;
  let judge: V2JudgeResult | undefined;
  let percentage: number | undefined;
  let status: V2EvalRunStatus = "failed";
  let errorMessage: string | undefined;
  let failureDiagnosticStatus: "written" | "write-failed" | undefined;

  await mkdir(directory, { recursive: true });
  let gitRevision = "unknown";
  try { gitRevision = (deps.gitRevision ?? (() => defaultGitRevision(engineRoot)))(); }
  catch { gitRevision = "unknown"; }

  try {
    lifecycle.workspace = "not-started";
    workspace = await (deps.createEvaluationWorkspace ?? createEvaluationWorkspace)();
    lifecycle.workspace = "created";

    failureStage = "server-startup";
    server = await workspace.startServer();
    lifecycle.server = "started";
    lifecycle.session = "started";

    failureStage = "session";
    trace = createEmptyV2SessionTrace(scenario.id);
    await (deps.runV2ScenarioSession ?? runV2ScenarioSession)({ scenario, workspace, serverUrl: server.url, trace });
    lifecycle.session = "completed";

    failureStage = "deterministic-gate";
    gate = (deps.deterministicV2Gate ?? deterministicV2Gate)(scenario, trace);
    lifecycle.deterministicGate = gate.passed ? "passed" : "failed";
    failureStage = "report";
    judgeTrace = (deps.projectV2JudgeTrace ?? projectV2JudgeTrace)(trace);
    const traceFiles = { trace: "trace.json", gate: "gate.json", artifacts: "artifacts.json" };
    await Promise.all([
      writeJson(writeFile, join(directory, traceFiles.trace), judgeTrace),
      writeJson(writeFile, join(directory, traceFiles.gate), gate),
      writeJson(writeFile, join(directory, traceFiles.artifacts), judgeTrace.artifacts)
    ]);
    Object.assign(files, traceFiles);
    if (!gate.passed) {
      failureStage = "deterministic-gate";
      lifecycle.deterministicGate = "failed";
      files.failure = "failure.txt";
      const failures = gate.assertions.filter((assertion) => !assertion.passed).map((assertion) => `${assertion.name}: ${assertion.detail}`).join("\n");
      failureDiagnosticStatus = await tryWriteText(writeFile, join(directory, files.failure), `Deterministic gate failed before judge invocation.\n${failures}\n`) ? "written" : "write-failed";
      if (failureDiagnosticStatus === "write-failed") delete files.failure;
      errorMessage = publicFailureMessage(failureStage);
    } else {
      lifecycle.deterministicGate = "passed";

      failureStage = "judge";
      const judgeInput = buildV2JudgePrompt(scenario, judgeTrace, gate);
      await writeFile(join(directory, "judge-input.txt"), judgeInput);
      files.judgeInput = "judge-input.txt";
      lifecycle.judge = "input-written";
      judge = await (deps.judgeV2TraceFromPrompt ?? judgeV2TraceFromPrompt)(judgeInput, judgeTrace);
      lifecycle.judge = "completed";
      const verdict = v2JudgePass(judge);
      percentage = verdict.percentage;

      failureStage = "report";
      const report = (deps.createV2Report ?? createV2Report)({
        scenario,
        trace: judgeTrace,
        gate,
        judgeInput,
        judge,
        tutorModel: modelIdentities(environment).tutor,
        judgeModel: modelIdentities(environment).judge
      });
      await writeJson(writeFile, join(directory, "judge.json"), judge);
      files.judge = "judge.json";
      await writeFile(join(directory, "summary.md"), `# ${scenario.id}\n\nDeterministic gate: **pass**\n\nJudge: **${Math.round(verdict.percentage * 100)}%** (${verdict.passed ? "pass" : "fail"})\n\n${judge.summary}\n`);
      files.summary = "summary.md";
      await writeJson(writeFile, join(directory, "report.json"), report);
      files.report = "report.json";
      lifecycle.report = "written";
      status = verdict.passed ? "passed" : "failed";
      if (!verdict.passed) {
        files.failure = "failure.txt";
        failureDiagnosticStatus = await tryWriteText(writeFile, join(directory, files.failure), `Judge verdict failed.\n\nSummary: ${judge.summary}\n`) ? "written" : "write-failed";
        if (failureDiagnosticStatus === "write-failed") delete files.failure;
        failureStage = "judge";
        errorMessage = publicFailureMessage(failureStage);
      }
    }
  } catch (error) {
    errorMessage = publicFailureMessage(failureStage);
    files.failure = "failure.txt";
    if (failureStage === "workspace-creation") lifecycle.workspace = "failed";
    else if (failureStage === "server-startup") lifecycle.server = "failed";
    else if (failureStage === "session") lifecycle.session = "failed";
    else if (failureStage === "deterministic-gate") lifecycle.deterministicGate = "failed";
    else if (failureStage === "judge") lifecycle.judge = "failed";
    failureDiagnosticStatus = await tryWriteText(writeFile, join(directory, files.failure), error instanceof Error ? error.stack ?? error.message : String(error)) ? "written" : "write-failed";
    if (failureDiagnosticStatus === "write-failed") delete files.failure;
  }

  const cleanupErrors: unknown[] = [];
  lifecycle.cleanup = "not-started";
  try {
    if (server) await server.close();
    if (lifecycle.server === "started") lifecycle.server = "closed";
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await workspace?.close();
    if (lifecycle.workspace === "created") lifecycle.workspace = "closed";
  } catch (error) {
    cleanupErrors.push(error);
  }

  lifecycle.cleanup = cleanupErrors.length > 0 ? "failed" : "completed";

  if (cleanupErrors.length > 0) {
    const cleanupText = `${cleanupErrors.map((error) => error instanceof Error ? error.stack ?? error.message : String(error)).join("\n\n")}${diagnosticResourceLocations(workspace, server)}`;
    if (status === "passed") {
      status = "failed";
      failureStage = "cleanup";
      errorMessage = publicFailureMessage(failureStage);
      files.failure = "failure.txt";
      failureDiagnosticStatus = await tryWriteText(writeFile, join(directory, files.failure), cleanupText) ? "written" : "write-failed";
      if (failureDiagnosticStatus === "write-failed") delete files.failure;
    } else {
      files.cleanupFailure = "cleanup-failure.txt";
      if (!await tryWriteText(writeFile, join(directory, files.cleanupFailure), cleanupText)) delete files.cleanupFailure;
    }
  }

  const ended = safeNowIso(now);
  files.metadata = metadataFileName;
  const metadata = createRunMetadata({
    scenario,
    repetition,
    runId,
    status,
    failureStage: status === "passed" ? undefined : failureStage,
    failure: status === "passed" ? undefined : {
      name: "Error",
      message: errorMessage ?? publicFailureMessage("unexpected"),
      ...(files.failure === undefined ? {} : { detailsFile: files.failure }),
      diagnosticStatus: failureDiagnosticStatus ?? "write-failed"
    },
    started,
    ended,
    gitRevision,
    lifecycle,
    workspace,
    files,
    environment
  });
  let metadataWritten = true;
  try {
    await writeJson(writeFile, join(directory, metadataFileName), metadata);
  } catch {
    metadataWritten = false;
    delete files.metadata;
    status = "failed";
    failureStage = "metadata";
    errorMessage = publicFailureMessage(failureStage);
  }

  return {
    scenario: scenario.id,
    runId,
    repetition,
    passed: status === "passed",
    ...(percentage === undefined ? {} : { percentage }),
    directory,
    reportDirectory,
    ...(metadataWritten ? { metadataFile: metadataFileName } : {}),
    ...(files.report === undefined ? {} : { reportFile: files.report }),
    status,
    ...(status === "passed" ? {} : { failureStage }),
    ...(errorMessage === undefined ? {} : { error: errorMessage })
  };
}

function writeStream(stream: Pick<NodeJS.WriteStream, "write">, text: string): void {
  stream.write(text);
}

function modelIdentityLabel(result: WorkbookModelPreflightResult): string {
  const selected = result.selectedModel ? `${result.selectedModel.provider}/${result.selectedModel.id}` : "unknown selected model";
  return `${result.role}: ${selected}`;
}

export async function runV2EvalCli(args: string[], options: V2EvalCliOptions = {}): Promise<number> {
  const environment = process.env;
  const stdout = options.stdout ?? process.stdout;
  const engineRoot = options.engineRoot ?? root;
  const reportsRoot = options.reportsRoot ?? reports;
  if (args.includes("--help")) { writeStream(stdout, v2EvalUsageText()); writeStream(stdout, "\n"); return 0; }
  const plan = prepareV2EvalCliRun(args, environment);
  if (!plan) { writeStream(stdout, v2EvalUsageText()); writeStream(stdout, "\n"); return 1; }
  const preflight = await preflightV2EvalLiveEngine({ plan, engineRoot, environment, dependencies: options.preflightDependencies });
  const chosen = plan.scenarios;
  const repeat = plan.repeat;

  await mkdir(reportsRoot, { recursive: true });
  writeStream(stdout, `Selected: ${chosen.map((item) => item.id).join(", ")}\nScope: ${plan.scope}\nRuns per scenario: ${repeat}\nTutor: ${environment.TUTOR_MODEL ?? "tutorial default"}\nJudge: ${environment.EVAL_JUDGE_MODEL}\nPreflight: fixture '${preflight.fixture.title}', terminal ${preflight.terminal.image}, ${preflight.workbookModels.map(modelIdentityLabel).join(", ")}, judge ${preflight.judge.commandLabel}/${preflight.judge.model}\n`);
  const results: Array<{ scenario: string; runs: V2EvalRunResult[] }> = [];
  for (const scenario of chosen) {
    const runs = [];
    for (let attempt = 0; attempt < repeat; attempt++) {
      const result = await runV2EvalOnce(scenario, attempt + 1, { reportsRoot, engineRoot, dependencies: options.dependencies });
      runs.push(result);
      writeStream(stdout, `${scenario.id}: ${result.passed ? "PASS" : "FAIL"} — ${result.directory}\n`);
    }
    results.push({ scenario: scenario.id, runs });
  }
  await writeJson(nodeWriteFile, join(reportsRoot, "latest.json"), createV2LatestReport(results));
  const stable = results.every(({ runs }) => repeat === 1 ? runs[0]?.passed === true : runs.filter((run) => run.passed).length >= 2);
  return stable ? 0 : 1;
}

async function main(): Promise<void> {
  process.exitCode = await runV2EvalCli(process.argv.slice(2));
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
