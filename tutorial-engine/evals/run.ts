#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile as nodeWriteFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildV2JudgePrompt, createV2Report, judgeV2TraceFromPrompt, v2JudgePass, type V2JudgeResult } from "./v2/judge.js";
import { createEmptyV2SessionTrace, projectV2JudgeTrace } from "./v2/session.js";
import { deterministicV2Gate, runV2ScenarioSession, v2Scenarios, type V2GateResult, type V2Scenario } from "./v2/scenarios.js";
import { V2_ENGINE_EVAL_MARKERS, type EvaluationWorkspace, type V2EvalRunFailureStage, type V2EvalRunStatus, type V2JudgeTrace, type V2SessionTrace } from "./v2/types.js";
import { createEvaluationWorkspace } from "./v2/workspace.js";

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

export interface V2EvalRunOptions {
  reportsRoot?: string;
  engineRoot?: string;
  dependencies?: V2EvalRunnerDependencies;
}

function usage(): void {
  console.log(`Live synthetic tutorial-engine mechanics evals (real tutor and judge model calls; not part of npm test)

Usage from tutorial-engine/:
  npm run eval -- --scenario v2-exact-command-success
  npm run eval -- --all --yes
  npm run eval -- --scenario v2-exact-command-success --repeat 3

Usage from the repository root:
  npm run eval:engine -- --scenario v2-exact-command-success
  npm run eval -- --scenario v2-exact-command-success  # temporary compatibility alias

A scope is required. EVAL_JUDGE_MODEL selects the judge model. TUTOR_MODEL optionally selects the tutor model used by the workbook tutor. Reports are written under tutorial-engine/evals/reports/.`);
}

export function selectV2Scenarios(args: string[]): V2Scenario[] {
  const scenarioIndex = args.indexOf("--scenario");
  if (args.includes("--all")) return v2Scenarios;
  if (scenarioIndex >= 0 && args[scenarioIndex + 1]) {
    const id = args[scenarioIndex + 1]!;
    const scenario = v2Scenarios.find((item) => item.id === id);
    if (!scenario) throw new Error(`Unknown v2 scenario '${id}'.`);
    return [scenario];
  }
  return [];
}

function modelIdentities(): { tutor: string; judge: string } {
  return { tutor: process.env.TUTOR_MODEL ?? "tutorial default", judge: process.env.EVAL_JUDGE_MODEL ?? "unset" };
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
    modelIdentities: modelIdentities(),
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
        tutorModel: modelIdentities().tutor,
        judgeModel: modelIdentities().judge
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
    files
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { usage(); return; }
  const chosen = selectV2Scenarios(args);
  if (!chosen.length) { usage(); process.exitCode = 1; return; }
  const repeatIndex = args.indexOf("--repeat");
  const repeat = repeatIndex >= 0 ? Number(args[repeatIndex + 1]) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error("--repeat must be 1, 2, or 3.");
  if (!process.env.EVAL_JUDGE_MODEL) throw new Error("Set EVAL_JUDGE_MODEL before running paid live evals.");
  if (args.includes("--all") && !args.includes("--yes")) throw new Error(`--all can spend model tokens across ${v2Scenarios.length} live scenarios. Re-run with --yes to confirm.`);

  await mkdir(reports, { recursive: true });
  console.log(`Selected: ${chosen.map((item) => item.id).join(", ")}\nTutor: ${process.env.TUTOR_MODEL ?? "tutorial default"}\nJudge: ${process.env.EVAL_JUDGE_MODEL}`);
  const results: Array<{ scenario: string; runs: V2EvalRunResult[] }> = [];
  for (const scenario of chosen) {
    const runs = [];
    for (let attempt = 0; attempt < repeat; attempt++) {
      const result = await runV2EvalOnce(scenario, attempt + 1);
      runs.push(result);
      console.log(`${scenario.id}: ${result.passed ? "PASS" : "FAIL"} — ${result.directory}`);
    }
    results.push({ scenario: scenario.id, runs });
  }
  await writeJson(nodeWriteFile, join(reports, "latest.json"), createV2LatestReport(results));
  const stable = results.every(({ runs }) => repeat === 1 ? runs[0]?.passed === true : runs.filter((run) => run.passed).length >= 2);
  if (!stable) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
