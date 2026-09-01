#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";
import { createAuthoredCommandStubs, type AuthoredCommandStubHandle } from "./command-stubs.js";
import { AuthoredWorkbookDriver } from "./driver.js";
import { createAuthoredWorkbookScenarioGateEvidenceCollector } from "./gate-evidence.js";
import {
  authoredWorkbookJudgeVerdict,
  buildAuthoredWorkbookJudgePrompt,
  invokeAuthoredWorkbookJudgeCommand,
  verifyAuthoredWorkbookJudgeResult,
  type AuthoredWorkbookEvalGateResult,
  type AuthoredWorkbookEvalJudgeResult,
  type AuthoredWorkbookEvalScenarioPublicDescriptor
} from "./judge.js";
import {
  AUTHORED_WORKBOOK_DETERMINISTIC_REPORT_FILENAMES,
  AUTHORED_WORKBOOK_REPORT_FILENAMES,
  createAuthoredWorkbookEvalLatestEnvelope,
  createAuthoredWorkbookEvalLatestRunEntry,
  writeAuthoredWorkbookEvalCleanupFailureDiagnostic,
  writeAuthoredWorkbookEvalFailureDiagnostic,
  writeAuthoredWorkbookEvalGateDiagnostic,
  writeAuthoredWorkbookEvalLatestEnvelope,
  writeAuthoredWorkbookEvalReportBundle,
  writeAuthoredWorkbookEvalFailureMetadata,
  authoredWorkbookEvalLocalDiagnosticText,
  authoredWorkbookEvalStabilityPassed,
  type AuthoredWorkbookEvalEvaluationMode,
  type AuthoredWorkbookEvalInvocationScope,
  type AuthoredWorkbookEvalLatestRunEntry,
  type AuthoredWorkbookEvalModelIdentities,
  type AuthoredWorkbookEvalRunLifecycleStatus
} from "./reports.js";
import { AUTHORED_WORKBOOK_SCENARIOS, authoredWorkbookScenarioById, authoredWorkbookScenarioPublicDescriptorById, type AuthoredWorkbookScenarioDescriptor, type AuthoredWorkbookScenarioId } from "./scenarios.js";
import { createEmptyAuthoredWorkbookEvalSessionTrace, type AuthoredWorkbookEvalSessionTrace, type AuthoredWorkbookEvalTrace } from "./public-trace.js";
import {
  AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL,
  createAuthoredWorkbookRunnerModelConfiguration,
  runAuthoredWorkbookEvalPreflight,
  validateAuthoredWorkbookEvalPreflightRequest,
  type AuthoredWorkbookEvalPreflightRequest,
  type AuthoredWorkbookEvalPreflightRequestInput,
  type AuthoredWorkbookEvalPublicSummary
} from "./preflight.js";
import { createAuthoredCurriculumSliceWorkspace, type AuthoredCurriculumSliceWorkspace } from "./workspace.js";
import type { TutorialSessionPaths } from "../../tutorial-engine/src/session-workspace.js";
import type { StartedWorkbookServer } from "../../tutorial-engine/src/workbook/server.js";

export const AUTHORED_WORKBOOK_EVAL_REPORTS_ROOT = resolve(import.meta.dirname, "reports");
export const AUTHORED_WORKBOOK_RUN_USAGE = `Usage: npm run eval:workbook -- <scope> [preflight flags]

Scopes (choose exactly one):
  --list
  --scenario <exact-id>
  --all --yes
  --release

Options:
  --repeat <1|2|3>                         Scenario/all only; default 1.
  --keep-workspace                         One --scenario run, repeat 1, non-release only.
  --tutor-model <provider/model>           Main Tutor model identity.
  --judge-model <provider/model>           Judge model identity for judged selections.
  --max-paid-model-calls <integer>         Required for scenario/all; release derives the exact catalog budget when omitted.
  --max-estimated-tokens <integer>         Required for scenario/all; release derives at least 2000 tokens per call when omitted.

Release runs the authored catalog once, in order. Explicit release budgets are accepted only when they meet or exceed the derived release budget. Live evals spend model tokens.`;

const PREFLIGHT_VALUE_FLAGS = new Set(["--tutor-model", "--judge-model", "--max-paid-model-calls", "--max-estimated-tokens"]);
const ALL_VALUE_FLAGS = new Set([...PREFLIGHT_VALUE_FLAGS, "--scenario", "--repeat"]);
const BOOLEAN_FLAGS = new Set(["--list", "--all", "--yes", "--release", "--keep-workspace"]);

export type AuthoredWorkbookRunScope = "list" | "scenario" | "all" | "release";

export interface ParsedAuthoredWorkbookRunArgs {
  scope: AuthoredWorkbookRunScope;
  scenarioIds: AuthoredWorkbookScenarioId[];
  repeat: 1 | 2 | 3;
  keepWorkspace: boolean;
  preflightArgv: string[];
}

export interface AuthoredWorkbookRunInvocation {
  scope: Exclude<AuthoredWorkbookRunScope, "list">;
  scenarioIds: AuthoredWorkbookScenarioId[];
  repeat: 1 | 2 | 3;
  keepWorkspace: boolean;
  preflightInput: AuthoredWorkbookEvalPreflightRequestInput;
  preflightRequest: AuthoredWorkbookEvalPreflightRequest;
  preflightSummary: AuthoredWorkbookEvalPublicSummary;
}

export type AuthoredWorkbookRunSuccessBundle =
  | {
    evaluationMode: "judged";
    scenario: AuthoredWorkbookEvalScenarioPublicDescriptor;
    trace: AuthoredWorkbookEvalTrace;
    gate: AuthoredWorkbookEvalGateResult;
    judgeInput: string;
    judge: AuthoredWorkbookEvalJudgeResult;
  }
  | {
    evaluationMode: "deterministic-only";
    scenario: AuthoredWorkbookEvalScenarioPublicDescriptor;
    trace: AuthoredWorkbookEvalTrace;
    gate: AuthoredWorkbookEvalGateResult;
  };

export interface AuthoredWorkbookRunAttemptResult {
  runId: string;
  scenarioId: AuthoredWorkbookScenarioId;
  repetition: 1 | 2 | 3;
  status: AuthoredWorkbookEvalRunLifecycleStatus;
  passed: boolean;
  reportDirectory?: string;
  latestEntry?: AuthoredWorkbookEvalLatestRunEntry;
  reported: boolean;
}

export interface AuthoredWorkbookRunPrimitives {
  runPreflight: typeof runAuthoredWorkbookEvalPreflight;
  validatePreflightRequest: typeof validateAuthoredWorkbookEvalPreflightRequest;
  createWorkspace: typeof createAuthoredCurriculumSliceWorkspace;
  Driver: typeof AuthoredWorkbookDriver;
  createCommandStubs: typeof createAuthoredCommandStubs;
  createGateEvidenceCollector: typeof createAuthoredWorkbookScenarioGateEvidenceCollector;
  createRunnerModelConfiguration: typeof createAuthoredWorkbookRunnerModelConfiguration;
  buildJudgePrompt: typeof buildAuthoredWorkbookJudgePrompt;
  invokeJudgeCommand: typeof invokeAuthoredWorkbookJudgeCommand;
  verifyJudgeResult: typeof verifyAuthoredWorkbookJudgeResult;
  writeReportBundle: typeof writeAuthoredWorkbookEvalReportBundle;
  writeFailureMetadata: typeof writeAuthoredWorkbookEvalFailureMetadata;
  createLatestEnvelope: typeof createAuthoredWorkbookEvalLatestEnvelope;
  writeLatestEnvelope: typeof writeAuthoredWorkbookEvalLatestEnvelope;
  writeGateDiagnostic: typeof writeAuthoredWorkbookEvalGateDiagnostic;
  writeFailureDiagnostic: typeof writeAuthoredWorkbookEvalFailureDiagnostic;
  writeCleanupDiagnostic: typeof writeAuthoredWorkbookEvalCleanupFailureDiagnostic;
  randomUUID: typeof randomUUID;
  log(line: string): void;
  error(line: string): void;
}

export const defaultAuthoredWorkbookRunPrimitives: AuthoredWorkbookRunPrimitives = Object.freeze({
  runPreflight: runAuthoredWorkbookEvalPreflight,
  validatePreflightRequest: validateAuthoredWorkbookEvalPreflightRequest,
  createWorkspace: createAuthoredCurriculumSliceWorkspace,
  Driver: AuthoredWorkbookDriver,
  createCommandStubs: createAuthoredCommandStubs,
  createGateEvidenceCollector: createAuthoredWorkbookScenarioGateEvidenceCollector,
  createRunnerModelConfiguration: createAuthoredWorkbookRunnerModelConfiguration,
  buildJudgePrompt: buildAuthoredWorkbookJudgePrompt,
  invokeJudgeCommand: invokeAuthoredWorkbookJudgeCommand,
  verifyJudgeResult: verifyAuthoredWorkbookJudgeResult,
  writeReportBundle: writeAuthoredWorkbookEvalReportBundle,
  writeFailureMetadata: writeAuthoredWorkbookEvalFailureMetadata,
  createLatestEnvelope: createAuthoredWorkbookEvalLatestEnvelope,
  writeLatestEnvelope: writeAuthoredWorkbookEvalLatestEnvelope,
  writeGateDiagnostic: writeAuthoredWorkbookEvalGateDiagnostic,
  writeFailureDiagnostic: writeAuthoredWorkbookEvalFailureDiagnostic,
  writeCleanupDiagnostic: writeAuthoredWorkbookEvalCleanupFailureDiagnostic,
  randomUUID,
  log: (line: string) => console.log(line),
  error: (line: string) => console.error(line)
});

export interface AuthoredWorkbookRunDependencies {
  preflight(input: AuthoredWorkbookEvalPreflightRequestInput, signal: AbortSignal): Promise<AuthoredWorkbookEvalPublicSummary>;
  validatePreflightRequest(input: AuthoredWorkbookEvalPreflightRequestInput): AuthoredWorkbookEvalPreflightRequest;
  createWorkspace(input: { scenario: AuthoredWorkbookScenarioDescriptor; keepWorkspace: boolean; signal: AbortSignal }): Promise<AuthoredCurriculumSliceWorkspace>;
  startServer(input: { workspace: AuthoredCurriculumSliceWorkspace; request: AuthoredWorkbookEvalPreflightRequest; summary: AuthoredWorkbookEvalPublicSummary; signal: AbortSignal }): Promise<StartedWorkbookServer>;
  createDriver(input: { serverUrl: string; trace: AuthoredWorkbookEvalSessionTrace; signal: AbortSignal; privateTerminalShellPrefix?: string }): AuthoredWorkbookDriver;
  createCommandStubs(input: { scenario: AuthoredWorkbookScenarioDescriptor; session: TutorialSessionPaths; signal: AbortSignal }): Promise<AuthoredCommandStubHandle | undefined>;
  createGateEvidenceCollector(input: { scenario: AuthoredWorkbookScenarioDescriptor; workspace: AuthoredCurriculumSliceWorkspace; session: TutorialSessionPaths; trace: AuthoredWorkbookEvalSessionTrace; commandStubHandle?: AuthoredCommandStubHandle; signal: AbortSignal }): ReturnType<typeof createAuthoredWorkbookScenarioGateEvidenceCollector>;
  judge(input: { scenario: AuthoredWorkbookEvalScenarioPublicDescriptor; trace: AuthoredWorkbookRunSuccessBundle["trace"]; gate: AuthoredWorkbookEvalGateResult; request: AuthoredWorkbookEvalPreflightRequest; signal: AbortSignal }): Promise<{ judgeInput: string; judge: AuthoredWorkbookEvalJudgeResult }>;
  writeSuccess(input: { runId: string; reportsRoot: string; bundle: AuthoredWorkbookRunSuccessBundle; modelIdentities: AuthoredWorkbookEvalModelIdentities; repetition: 1 | 2 | 3 }): Promise<{ directory: string }>;
  writeFailure(input: { runId: string; reportsRoot: string; scenarioId: string; status: Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">; evaluationMode?: AuthoredWorkbookEvalEvaluationMode; modelIdentities: AuthoredWorkbookEvalModelIdentities; repetition: 1 | 2 | 3 }): Promise<{ directory: string }>;
  writeLatest(input: { reportsRoot: string; invocation: { scope: AuthoredWorkbookEvalInvocationScope; scenarioIds: string[]; repeat: 1 | 2 | 3 }; runs: AuthoredWorkbookEvalLatestRunEntry[] }): Promise<void>;
  writeGateDiagnostic(directory: string, gate: AuthoredWorkbookEvalGateResult): Promise<void>;
  writeFailureDiagnostic(directory: string, error: unknown): Promise<void>;
  writeCleanupDiagnostic(directory: string, error: unknown): Promise<void>;
  nowRunId(scenarioId: string, repetition: number): string;
  onKeptWorkspace?(path: string): void;
  log(line: string): void;
  error(line: string): void;
}

export interface InvokeAuthoredWorkbookCliOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  dependencies?: Partial<AuthoredWorkbookRunDependencies>;
  reportsRoot?: string;
  installSignalHandlers?: boolean;
}

export function formatAuthoredWorkbookRunUsage(): string {
  return AUTHORED_WORKBOOK_RUN_USAGE;
}

export function parseAuthoredWorkbookRunArgs(argv: readonly string[]): ParsedAuthoredWorkbookRunArgs {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) throw new CliUsageRequested();
  const seen = new Set<string>();
  const scenarioIds: string[] = [];
  let scope: AuthoredWorkbookRunScope | undefined;
  let repeat: 1 | 2 | 3 = 1;
  let keepWorkspace = false;
  let yes = false;
  const preflightArgv: string[] = [];

  const setScope = (next: AuthoredWorkbookRunScope) => {
    if (scope !== undefined) throw cliValidationError();
    scope = next;
  };
  const requireValue = (flag: string, index: number): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw cliValidationError();
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) throw cliValidationError();
    if (!BOOLEAN_FLAGS.has(flag) && !ALL_VALUE_FLAGS.has(flag)) throw cliValidationError();
    if (seen.has(flag)) throw cliValidationError();
    seen.add(flag);

    if (flag === "--list") setScope("list");
    else if (flag === "--all") setScope("all");
    else if (flag === "--release") setScope("release");
    else if (flag === "--yes") yes = true;
    else if (flag === "--keep-workspace") keepWorkspace = true;
    else {
      const value = requireValue(flag, index);
      index += 1;
      if (flag === "--scenario") {
        setScope("scenario");
        scenarioIds.push(value);
      } else if (flag === "--repeat") {
        repeat = parseRepeat(value);
      } else if (PREFLIGHT_VALUE_FLAGS.has(flag)) {
        preflightArgv.push(flag, value);
      } else {
        throw cliValidationError();
      }
    }
  }

  if (scope === undefined) throw cliValidationError();
  if (scope === "list") {
    if (args.length !== 1) throw cliValidationError();
    return { scope, scenarioIds: [], repeat: 1, keepWorkspace: false, preflightArgv: [] };
  }
  if (scope === "scenario" && scenarioIds.length !== 1) throw cliValidationError();
  if (scope === "all" && (!yes || scenarioIds.length !== 0)) throw cliValidationError();
  if ((scope === "scenario" || scope === "release") && yes) throw cliValidationError();
  if (scope === "release" && (repeat !== 1 || keepWorkspace || scenarioIds.length !== 0)) throw cliValidationError();
  if (keepWorkspace && !(scope === "scenario" && repeat === 1)) throw cliValidationError();

  const resolvedIds = scope === "scenario" ? [scenarioIdOrThrow(scenarioIds[0]!)] : AUTHORED_WORKBOOK_SCENARIOS.map((scenario) => scenario.id);
  return { scope, scenarioIds: resolvedIds, repeat, keepWorkspace, preflightArgv };
}

export async function invokeAuthoredWorkbookCli(options: InvokeAuthoredWorkbookCliOptions = {}): Promise<number> {
  const dependencies = { ...createDefaultAuthoredWorkbookRunDependencies(), ...options.dependencies };
  const reportsRoot = options.reportsRoot ?? AUTHORED_WORKBOOK_EVAL_REPORTS_ROOT;
  const abort = new AbortController();
  const signalState = installSignalHandlers(abort, options.installSignalHandlers ?? true);
  try {
    const parsed = parseAuthoredWorkbookRunArgs(options.argv ?? process.argv.slice(2));
    if (parsed.scope === "list") {
      for (const scenario of AUTHORED_WORKBOOK_SCENARIOS) dependencies.log(`${scenario.id}\t${scenario.title}`);
      return 0;
    }
    const preflightInput = preflightInputFromParsed(parsed, options.env ?? process.env);
    let request: AuthoredWorkbookEvalPreflightRequest;
    try {
      request = dependencies.validatePreflightRequest(preflightInput);
    } catch (error) {
      dependencies.error(sanitizedRuntimeMessage(error));
      return abort.signal.aborted ? signalState.code() : 1;
    }
    let summary: AuthoredWorkbookEvalPublicSummary;
    try {
      summary = await dependencies.preflight(preflightInput, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return signalState.code();
      dependencies.error(sanitizedRuntimeMessage(error));
      return 1;
    }
    const invocation: AuthoredWorkbookRunInvocation = {
      scope: parsed.scope,
      scenarioIds: parsed.scenarioIds,
      repeat: parsed.repeat,
      keepWorkspace: parsed.keepWorkspace,
      preflightInput,
      preflightRequest: request,
      preflightSummary: summary
    };
    dependencies.log(`preflight ok: ${parsed.scenarioIds.join(",")} repeat=${parsed.repeat}`);
    const code = await runAuthoredWorkbookEvalBatch(invocation, { dependencies, reportsRoot, signal: abort.signal, signalCode: () => signalState.code() });
    return code;
  } catch (error) {
    if (error instanceof CliUsageRequested) {
      dependencies.log(formatAuthoredWorkbookRunUsage());
      return 0;
    }
    if (error instanceof CliValidationError) {
      dependencies.error(formatAuthoredWorkbookRunUsage());
      return 2;
    }
    dependencies.error(sanitizedRuntimeMessage(error));
    return abort.signal.aborted ? signalState.code() : 1;
  } finally {
    signalState.cleanup();
  }
}

export async function runAuthoredWorkbookEvalBatch(input: AuthoredWorkbookRunInvocation, options: { dependencies?: Partial<AuthoredWorkbookRunDependencies>; reportsRoot?: string; signal?: AbortSignal; signalCode?: () => number } = {}): Promise<number> {
  const dependencies = { ...createDefaultAuthoredWorkbookRunDependencies(), ...options.dependencies };
  const reportsRoot = options.reportsRoot ?? AUTHORED_WORKBOOK_EVAL_REPORTS_ROOT;
  const signal = options.signal ?? new AbortController().signal;
  const latestEntries: AuthoredWorkbookEvalLatestRunEntry[] = [];
  const resultsByScenario = new Map<string, AuthoredWorkbookRunAttemptResult[]>();
  const modelIdentities = modelIdentitiesFromPreflight(input.preflightRequest, input.preflightSummary);
  let interrupted = false;

  for (const scenarioId of input.scenarioIds) {
    for (let repetition = 1; repetition <= input.repeat; repetition += 1) {
      if (signal.aborted) { interrupted = true; break; }
      const scenario = authoredWorkbookScenarioById(scenarioId);
      const runId = dependencies.nowRunId(scenario.id, repetition);
      const result = await runOneAuthoredWorkbookScenario({ scenario, repetition: repetition as 1 | 2 | 3, runId, invocation: input, modelIdentities, reportsRoot, signal, dependencies });
      if (signal.aborted || result.status === "interrupted") interrupted = true;
      if (!interrupted && result.latestEntry) latestEntries.push(result.latestEntry);
      const scenarioResults = resultsByScenario.get(scenario.id) ?? [];
      scenarioResults.push(result);
      resultsByScenario.set(scenario.id, scenarioResults);
      dependencies.log(`${scenario.id}#${repetition}: ${result.status} ${result.passed ? "pass" : "fail"}${result.reportDirectory ? ` ${relativePath(resolve(process.cwd()), resolve(reportsRoot, result.reportDirectory))}` : " unreported"}`);
      if (interrupted) break;
    }
    if (interrupted) break;
  }

  if (interrupted) return options.signalCode?.() ?? 130;

  if (latestEntries.length > 0) {
    try {
      await dependencies.writeLatest({ reportsRoot, invocation: { scope: input.scope, scenarioIds: input.scenarioIds, repeat: input.repeat }, runs: latestEntries });
      dependencies.log(`${relativePath(resolve(process.cwd()), resolve(reportsRoot, "latest.json"))}`);
    } catch {
      dependencies.error("Unable to update authored workbook latest report.");
      return interrupted ? (options.signalCode?.() ?? 130) : 1;
    }
  }
  const stable = [...resultsByScenario.values()].every((runs) => authoredWorkbookEvalStabilityPassed(runs.map((run) => ({ passed: run.passed }))));
  const allReported = [...resultsByScenario.values()].flat().every((run) => run.reported);
  return stable && allReported ? 0 : 1;
}

async function runOneAuthoredWorkbookScenario(input: { scenario: AuthoredWorkbookScenarioDescriptor; repetition: 1 | 2 | 3; runId: string; invocation: AuthoredWorkbookRunInvocation; modelIdentities: AuthoredWorkbookEvalModelIdentities; reportsRoot: string; signal: AbortSignal; dependencies: AuthoredWorkbookRunDependencies }): Promise<AuthoredWorkbookRunAttemptResult> {
  const { scenario, repetition, runId, invocation, modelIdentities, reportsRoot, signal, dependencies } = input;
  const trace = createEmptyAuthoredWorkbookEvalSessionTrace(scenario.id);
  let workspace: AuthoredCurriculumSliceWorkspace | undefined;
  let server: StartedWorkbookServer | undefined;
  let stubs: AuthoredCommandStubHandle | undefined;
  let status: AuthoredWorkbookEvalRunLifecycleStatus = "setup";
  let gateForDiagnostic: AuthoredWorkbookEvalGateResult | undefined;
  let successBundle: AuthoredWorkbookRunSuccessBundle | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  let keepPath: string | undefined;
  const driverAbort = new AbortController();
  const combined = combineAbortSignals(signal, driverAbort.signal);

  try {
    throwIfAborted(signal);
    const createdWorkspace = await dependencies.createWorkspace({ scenario, keepWorkspace: invocation.keepWorkspace, signal });
    workspace = createdWorkspace;
    throwIfAborted(signal);
    keepPath = workspace.repositoryRoot;
    const startedServer = await dependencies.startServer({ workspace, request: invocation.preflightRequest, summary: invocation.preflightSummary, signal });
    server = startedServer;
    throwIfAborted(signal);
    const session = workspace.latestSession();
    const createdStubs = await dependencies.createCommandStubs({ scenario, session, signal });
    stubs = createdStubs;
    throwIfAborted(signal);
    if (invocation.keepWorkspace && keepPath) dependencies.onKeptWorkspace?.(keepPath);
    const collector = dependencies.createGateEvidenceCollector({ scenario, workspace, session, trace, commandStubHandle: stubs, signal });
    throwIfAborted(signal);
    await collector.captureBaseline();
    throwIfAborted(signal);
    status = "session";
    const driver = dependencies.createDriver({ serverUrl: server.url, trace, signal: combined.signal, privateTerminalShellPrefix: stubs?.containerShellActivation });
    await scenario.drive({ driver, captureGateCheckpoint: async (label) => { throwIfAborted(signal); await collector.captureGateCheckpoint(label); throwIfAborted(signal); } });
    throwIfAborted(signal);
    status = "gate";
    throwIfAborted(signal);
    const gateInput = await collector.collectGateInput();
    throwIfAborted(signal);
    const gate = scenario.gate(gateInput);
    gateForDiagnostic = { passed: gate.passed, assertions: gate.assertions.map((assertion) => ({ name: assertion.id, passed: assertion.passed, detail: assertion.privateDetail ?? assertion.message })) };
    if (gate.passed && gateForDiagnostic.assertions.some((assertion) => !assertion.passed)) throw new Error("Deterministic gate reported pass with failed assertions.");
    if (!gate.passed) throw new Error("Deterministic gate failed before judge invocation.");
    const scenarioPublic = publicScenarioDescriptor(scenario);
    if (scenario.judgePolicy.kind === "deterministic-only") {
      const expectedAssertionCount = scenario.judgePolicy.deterministicSuccess.requiredAssertionCount;
      if (gateForDiagnostic.assertions.length !== expectedAssertionCount) throw new Error(`Deterministic-only scenario gate produced ${gateForDiagnostic.assertions.length} assertions; expected ${expectedAssertionCount}.`);
      successBundle = { evaluationMode: "deterministic-only", scenario: scenarioPublic, trace: gateInput.trace, gate: gateForDiagnostic };
    } else {
      status = "judge";
      const judged = await dependencies.judge({ scenario: scenarioPublic, trace: gateInput.trace, gate: gateForDiagnostic, request: invocation.preflightRequest, signal });
      successBundle = { evaluationMode: "judged", scenario: scenarioPublic, trace: gateInput.trace, gate: gateForDiagnostic, judgeInput: judged.judgeInput, judge: judged.judge };
    }
    status = "cleanup";
  } catch (error) {
    primaryError = signal.aborted ? new InterruptedRunError() : error;
    status = signal.aborted ? "interrupted" : status;
  } finally {
    driverAbort.abort();
    combined.cleanup();
    const cleanupFailures: unknown[] = [];
    try { await stubs?.close(); } catch (error) { cleanupFailures.push(error); }
    try { await server?.close(); } catch (error) { cleanupFailures.push(error); }
    try { await workspace?.close(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) cleanupError = new AggregateError(cleanupFailures, "Authored workbook eval cleanup failed.");
  }

  if (signal.aborted) {
    primaryError ??= new InterruptedRunError();
    status = "interrupted";
    successBundle = undefined;
  }

  const finalStatus = finalStatusAfterCleanup(status, primaryError, cleanupError);
  const published = await publishAuthoredWorkbookRunReport({
    runId,
    reportsRoot,
    scenarioId: scenario.id,
    repetition,
    status: finalStatus,
    evaluationMode: scenario.judgePolicy.kind === "deterministic-only" ? "deterministic-only" : "judged",
    successBundle,
    modelIdentities,
    gateForDiagnostic,
    primaryError,
    cleanupError,
    dependencies
  });
  const passed = finalStatus === "completed" && successBundle !== undefined && published.status === "completed" && (successBundle.evaluationMode === "deterministic-only" || authoredWorkbookJudgeVerdict(successBundle.judge).passed);
  return { runId, scenarioId: scenario.id, repetition, status: published.status, passed, reportDirectory: published.reportDirectory, latestEntry: published.latestEntry, reported: published.reported };
}

async function publishAuthoredWorkbookRunReport(input: {
  runId: string;
  reportsRoot: string;
  scenarioId: string;
  repetition: 1 | 2 | 3;
  status: AuthoredWorkbookEvalRunLifecycleStatus;
  evaluationMode: AuthoredWorkbookEvalEvaluationMode;
  successBundle?: AuthoredWorkbookRunSuccessBundle;
  modelIdentities: AuthoredWorkbookEvalModelIdentities;
  gateForDiagnostic?: AuthoredWorkbookEvalGateResult;
  primaryError?: unknown;
  cleanupError?: unknown;
  dependencies: AuthoredWorkbookRunDependencies;
}): Promise<{ status: AuthoredWorkbookEvalRunLifecycleStatus; reported: boolean; reportDirectory?: string; latestEntry?: AuthoredWorkbookEvalLatestRunEntry }> {
  const { runId, reportsRoot, scenarioId, repetition, status, successBundle, modelIdentities, gateForDiagnostic, primaryError, cleanupError, dependencies } = input;
  const evaluationMode = successBundle?.evaluationMode ?? input.evaluationMode;
  const publicModelIdentities = modelIdentitiesForEvaluationMode(modelIdentities, evaluationMode);
  try {
    const report = status === "completed" && successBundle
      ? await dependencies.writeSuccess({ runId, reportsRoot, bundle: successBundle, modelIdentities: publicModelIdentities, repetition })
      : await dependencies.writeFailure({ runId, reportsRoot, scenarioId, status: status as Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">, evaluationMode, modelIdentities: publicModelIdentities, repetition });
    await writeOptionalDiagnostics({ directory: report.directory, gateForDiagnostic, primaryError, cleanupError, status, dependencies });
    const latestEntry = latestRunEntryFromMetadata({ runId, scenarioId, repetition, status, reportDirectory: runId, successBundle, evaluationMode });
    return { status, reported: true, reportDirectory: runId, latestEntry };
  } catch (error) {
    if (status !== "completed") return { status: "report", reported: false };
    try {
      const report = await dependencies.writeFailure({ runId, reportsRoot, scenarioId, status: "report", evaluationMode, modelIdentities: publicModelIdentities, repetition });
      await writeOptionalDiagnostics({ directory: report.directory, primaryError: error, status: "report", dependencies });
      const latestEntry = latestRunEntryFromMetadata({ runId, scenarioId, repetition, status: "report", reportDirectory: runId, evaluationMode });
      return { status: "report", reported: true, reportDirectory: runId, latestEntry };
    } catch {
      return { status: "report", reported: false };
    }
  }
}

async function writeOptionalDiagnostics(input: { directory: string; gateForDiagnostic?: AuthoredWorkbookEvalGateResult; primaryError?: unknown; cleanupError?: unknown; status: AuthoredWorkbookEvalRunLifecycleStatus; dependencies: AuthoredWorkbookRunDependencies }): Promise<void> {
  const { directory, gateForDiagnostic, primaryError, cleanupError, status, dependencies } = input;
  try { if (gateForDiagnostic) await dependencies.writeGateDiagnostic(directory, gateForDiagnostic); } catch { /* diagnostics are private best-effort files. */ }
  try { if (primaryError && (status !== "gate" || gateForDiagnostic === undefined)) await dependencies.writeFailureDiagnostic(directory, primaryError); } catch { /* diagnostics are private best-effort files. */ }
  try { if (cleanupError) await dependencies.writeCleanupDiagnostic(directory, cleanupError); } catch { /* diagnostics are private best-effort files. */ }
}

export function createAuthoredWorkbookRunDependencies(primitives: AuthoredWorkbookRunPrimitives = defaultAuthoredWorkbookRunPrimitives): AuthoredWorkbookRunDependencies {
  return {
    preflight: (input, signal) => primitives.runPreflight({ ...input, environment: input.environment }, { signal }).then((summary) => { throwIfAborted(signal); return summary; }),
    validatePreflightRequest: (input) => primitives.validatePreflightRequest(input),
    createWorkspace: async ({ scenario, keepWorkspace, signal }) => {
      throwIfAborted(signal);
      const workspace = await primitives.createWorkspace({ selection: scenario.selection, prerequisiteOverlays: scenario.prerequisiteOverlay ? [scenario.prerequisiteOverlay] : [], keepWorkspace });
      if (signal.aborted) {
        await workspace.close().catch(() => undefined);
        throwIfAborted(signal);
      }
      return workspace;
    },
    startServer: async ({ workspace, request, summary, signal }) => {
      throwIfAborted(signal);
      const models = primitives.createRunnerModelConfiguration(request, summary);
      throwIfAborted(signal);
      const mainTutor = models.createMainTutor({ workspace: workspace.repositoryRoot });
      try {
        throwIfAborted(signal);
        const server = await workspace.startServer({
          watchContent: false,
          embeddedTerminal: true,
          mainTutor
        });
        if (signal.aborted) {
          await server.close().catch(() => undefined);
          throwIfAborted(signal);
        }
        return server;
      } catch (error) {
        mainTutor.dispose();
        throw error;
      }
    },
    createDriver: ({ serverUrl, trace, signal, privateTerminalShellPrefix }) => new primitives.Driver({ serverUrl, trace, signal, privateTerminalShellPrefix }),
    createCommandStubs: async ({ scenario, session, signal }) => {
      throwIfAborted(signal);
      if (scenario.stubLessonNumber === undefined) return undefined;
      const workspaceRoot = session.workspaceRoots["refactor-line"] ?? Object.values(session.workspaceRoots)[0];
      if (!workspaceRoot) throw new Error("Selected scenario does not expose a learner workspace for command stubs.");
      const stubs = await primitives.createCommandStubs({ lessonNumber: scenario.stubLessonNumber, workspaceRoot, scenarioId: scenario.id });
      if (signal.aborted) {
        await stubs.close().catch(() => undefined);
        throwIfAborted(signal);
      }
      return stubs;
    },
    createGateEvidenceCollector: ({ scenario, workspace, session, trace, commandStubHandle, signal }) => {
      throwIfAborted(signal);
      const collector = primitives.createGateEvidenceCollector({ scenario, workspace, session, trace, commandStubHandle, signal });
      throwIfAborted(signal);
      return collector;
    },
    judge: async ({ scenario, trace, gate, request, signal }) => {
      throwIfAborted(signal);
      if (!request.models.judge) throw new Error("Judge model was not preflighted for a judged authored workbook scenario.");
      const judgeInput = primitives.buildJudgePrompt(scenario, trace, gate);
      const raw = await primitives.invokeJudgeCommand({ prompt: judgeInput, model: request.models.judge.identity, environment: request.environment, signal });
      throwIfAborted(signal);
      return { judgeInput, judge: primitives.verifyJudgeResult(raw, scenario, trace) };
    },
    writeSuccess: async ({ runId, reportsRoot, bundle, modelIdentities, repetition }) => {
      const written = bundle.evaluationMode === "deterministic-only"
        ? await primitives.writeReportBundle({ runId, reportsRoot, scenario: bundle.scenario, trace: bundle.trace, gate: bundle.gate, evaluationMode: "deterministic-only", modelIdentities, repetition })
        : await primitives.writeReportBundle({ runId, reportsRoot, scenario: bundle.scenario, trace: bundle.trace, gate: bundle.gate, evaluationMode: "judged", judgeInput: bundle.judgeInput, judge: bundle.judge, modelIdentities, repetition });
      return { directory: written.directory };
    },
    writeFailure: async ({ runId, reportsRoot, scenarioId, status, evaluationMode, modelIdentities, repetition }) => {
      const written = await primitives.writeFailureMetadata({ runId, reportsRoot, scenarioId, status, evaluationMode, modelIdentities, repetition });
      return { directory: written.directory };
    },
    writeLatest: async ({ reportsRoot, invocation, runs }) => {
      const envelope = primitives.createLatestEnvelope({ invocation, runs });
      await primitives.writeLatestEnvelope(reportsRoot, envelope);
    },
    writeGateDiagnostic: async (directory, gate) => { await primitives.writeGateDiagnostic(directory, gate); },
    writeFailureDiagnostic: async (directory, error) => { await primitives.writeFailureDiagnostic(directory, authoredWorkbookEvalLocalDiagnosticText(`${sanitizedRuntimeMessage(error)}\n`)); },
    writeCleanupDiagnostic: async (directory, error) => { await primitives.writeCleanupDiagnostic(directory, authoredWorkbookEvalLocalDiagnosticText(`${sanitizedRuntimeMessage(error)}\n`)); },
    nowRunId: (scenarioId, repetition) => `${scenarioId}-${repetition}-${primitives.randomUUID()}`,
    onKeptWorkspace: () => undefined,
    log: (line) => primitives.log(line),
    error: (line) => primitives.error(line)
  };
}

export function createDefaultAuthoredWorkbookRunDependencies(): AuthoredWorkbookRunDependencies {
  return createAuthoredWorkbookRunDependencies(defaultAuthoredWorkbookRunPrimitives);
}

export function authoredWorkbookReleaseBudget(scenarios: readonly Pick<AuthoredWorkbookScenarioDescriptor, "expectedModelCalls">[] = AUTHORED_WORKBOOK_SCENARIOS): Readonly<AuthoredWorkbookEvalPreflightRequestInput["costBudget"]> {
  const releaseCalls = scenarios.reduce((total, scenario) => total + scenario.expectedModelCalls.total, 0);
  const preflightCalls = 1 + (scenarios.some((scenario) => scenario.expectedModelCalls.judge > 0) ? 1 : 0);
  const maxPaidModelCalls = releaseCalls + preflightCalls;
  return Object.freeze({
    maxPaidModelCalls,
    maxEstimatedTokens: maxPaidModelCalls * AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL
  });
}

function preflightInputFromParsed(parsed: ParsedAuthoredWorkbookRunArgs, environment: NodeJS.ProcessEnv): AuthoredWorkbookEvalPreflightRequestInput {
  const models: Record<string, string> = {};
  const costBudget: Record<string, number> = {};
  for (let index = 0; index < parsed.preflightArgv.length; index += 2) {
    const flag = parsed.preflightArgv[index]!;
    const value = parsed.preflightArgv[index + 1]!;
    if (flag === "--tutor-model") models.mainTutor = value;
    else if (flag === "--judge-model") models.judge = value;
    else if (flag === "--max-paid-model-calls") costBudget.maxPaidModelCalls = positiveInteger(value);
    else if (flag === "--max-estimated-tokens") costBudget.maxEstimatedTokens = positiveInteger(value);
  }
  if (parsed.scope === "release") applyReleaseBudget(costBudget);
  return { scenarioIds: parsed.scenarioIds, repeat: parsed.repeat, models, costBudget: costBudget as unknown as AuthoredWorkbookEvalPreflightRequestInput["costBudget"], environment };
}

function applyReleaseBudget(costBudget: Record<string, number>): void {
  const derived = authoredWorkbookReleaseBudget();
  costBudget.maxPaidModelCalls ??= derived.maxPaidModelCalls;
  costBudget.maxEstimatedTokens ??= Math.max(derived.maxEstimatedTokens, costBudget.maxPaidModelCalls * AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL);
  if (costBudget.maxPaidModelCalls < derived.maxPaidModelCalls) throw cliValidationError();
  if (costBudget.maxEstimatedTokens < derived.maxEstimatedTokens) throw cliValidationError();
  if (costBudget.maxEstimatedTokens < costBudget.maxPaidModelCalls * AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL) throw cliValidationError();
}

function modelIdentitiesFromPreflight(request: AuthoredWorkbookEvalPreflightRequest, summary: AuthoredWorkbookEvalPublicSummary): AuthoredWorkbookEvalModelIdentities {
  const selected = new Map(summary.selectedModelIdentities.map((entry) => [entry.role, `${entry.provider}/${entry.id}`]));
  const requested = new Map(summary.configuredModelIdentities.map((entry) => [entry.role, `${entry.provider}/${entry.id}`]));
  const mainTutor = { requested: requested.get("Main Tutor") ?? request.models.mainTutor.identity, selected: selected.get("Main Tutor") ?? request.models.mainTutor.identity };
  if (!request.models.judge) return { "Main Tutor": mainTutor };
  return { "Main Tutor": mainTutor, Judge: { requested: requested.get("Judge") ?? request.models.judge.identity, selected: selected.get("Judge") ?? request.models.judge.identity } };
}

function modelIdentitiesForEvaluationMode(modelIdentities: AuthoredWorkbookEvalModelIdentities, evaluationMode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookEvalModelIdentities {
  if (evaluationMode === "deterministic-only") return { "Main Tutor": modelIdentities["Main Tutor"] };
  if (!modelIdentities.Judge) throw new Error("Judged authored workbook runs require a Judge model identity.");
  return modelIdentities;
}

function publicScenarioDescriptor(scenario: AuthoredWorkbookScenarioDescriptor): AuthoredWorkbookEvalScenarioPublicDescriptor {
  return authoredWorkbookScenarioPublicDescriptorById(scenario.id);
}

function finalStatusAfterCleanup(status: AuthoredWorkbookEvalRunLifecycleStatus, primaryError: unknown, cleanupError: unknown): AuthoredWorkbookEvalRunLifecycleStatus {
  if (primaryError) return status;
  if (cleanupError) return "cleanup";
  return "completed";
}

function latestRunEntryFromMetadata(input: { runId: string; scenarioId: string; repetition: 1 | 2 | 3; status: AuthoredWorkbookEvalRunLifecycleStatus; evaluationMode: AuthoredWorkbookEvalEvaluationMode; reportDirectory: string; successBundle?: AuthoredWorkbookRunSuccessBundle }): AuthoredWorkbookEvalLatestRunEntry {
  if (input.status !== "completed") {
    return createAuthoredWorkbookEvalLatestRunEntry({
      scenario: input.scenarioId,
      repetition: input.repetition,
      status: input.status,
      evaluationMode: input.evaluationMode,
      verdict: { passed: false, percentage: 0, rule: "not-judged" },
      reportDirectory: input.reportDirectory,
      files: { metadata: AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata }
    });
  }
  if (!input.successBundle) throw new Error("Cannot create a completed latest entry without a success bundle.");
  if (input.successBundle.evaluationMode === "deterministic-only") {
    return createAuthoredWorkbookEvalLatestRunEntry({ scenario: input.scenarioId, repetition: input.repetition, status: "completed", evaluationMode: "deterministic-only", verdict: { passed: true, rule: "deterministic-gate-only" }, reportDirectory: input.reportDirectory, files: AUTHORED_WORKBOOK_DETERMINISTIC_REPORT_FILENAMES });
  }
  const verdict = authoredWorkbookJudgeVerdict(input.successBundle.judge);
  return createAuthoredWorkbookEvalLatestRunEntry({ scenario: input.scenarioId, repetition: input.repetition, status: "completed", evaluationMode: "judged", verdict, reportDirectory: input.reportDirectory, files: AUTHORED_WORKBOOK_REPORT_FILENAMES });
}

function scenarioIdOrThrow(value: string): AuthoredWorkbookScenarioId {
  if (!AUTHORED_WORKBOOK_SCENARIOS.some((scenario) => scenario.id === value)) throw cliValidationError();
  return value as AuthoredWorkbookScenarioId;
}

function parseRepeat(value: string): 1 | 2 | 3 {
  const parsed = positiveInteger(value);
  if (parsed !== 1 && parsed !== 2 && parsed !== 3) throw cliValidationError();
  return parsed;
}

function positiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw cliValidationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw cliValidationError();
  return parsed;
}

function relativePath(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join("/");
  return rel && !rel.startsWith("..") ? rel : path.split(sep).join("/");
}

function sanitizedRuntimeMessage(error: unknown): string {
  if (error instanceof InterruptedRunError) return "Authored workbook eval interrupted.";
  if (error instanceof Error && error.message.trim()) return error.message.replace(/\/[^\s]+/g, "[path]").slice(0, 240);
  return "Authored workbook eval failed.";
}

function installSignalHandlers(abort: AbortController, enabled: boolean): { code(): number; cleanup(): void } {
  let code = 130;
  if (!enabled) return { code: () => code, cleanup: () => undefined };
  const onSigint = () => { code = 130; abort.abort(); };
  const onSigterm = () => { code = 143; abort.abort(); };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return { code: () => code, cleanup: () => { process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm); } };
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) controller.abort();
    const listener = () => controller.abort();
    signal.addEventListener("abort", listener, { once: true });
    listeners.push(() => signal.removeEventListener("abort", listener));
  }
  return { signal: controller.signal, cleanup: () => listeners.splice(0).forEach((listener) => listener()) };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new InterruptedRunError();
}

class CliValidationError extends Error {}
class CliUsageRequested extends Error {}
class InterruptedRunError extends Error { constructor() { super("Authored workbook eval interrupted."); } }
function cliValidationError(): CliValidationError { return new CliValidationError("Invalid authored workbook eval arguments."); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  invokeAuthoredWorkbookCli({
    dependencies: {
      onKeptWorkspace: (path) => console.error(`PRIVATE DEBUG: --keep-workspace left disposable authored eval workspace at ${path}. Do not paste this path into reports or latest.`)
    }
  }).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
