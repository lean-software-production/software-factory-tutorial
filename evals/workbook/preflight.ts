import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS,
  OPENCODE_API_KEY_ENV,
  WORKBOOK_TERMINAL_IMAGE,
  dockerClientEnvironment,
  dockerDaemonProbeArguments,
  dockerImageProbeArguments,
  validatedDockerContainerUser,
  dockerRunEnvironment,
  requireOpenCodeApiKey,
  type DockerCommandSyncOptions
} from "../../tutorial-engine/src/workbook/terminal.js";
import { TUTOR_MODEL_ENV, type WorkbookModelEnvironment } from "../../tutorial-engine/src/workbook/model.js";
import { probePiWorkbookRoleModel, type WorkbookModelIdentity } from "../../tutorial-engine/src/workbook/model-preflight.js";
import { DefaultMainWorkbookTutor, type MainWorkbookTutorOptions } from "../../tutorial-engine/src/workbook/tutor.js";
import { trustRuntimeProvision, type TrustedRuntimeProvision } from "../../tutorial-engine/src/workbook/runtime-provision.js";
import { probeV2JudgeCommandModel, type JudgeCommandLabel, type V2JudgeCommandPreflightResult } from "../../tutorial-engine/evals/v2/judge.js";
import { createAuthoredCommandStubs, type AuthoredCommandStubHandle } from "./command-stubs.js";
import { AUTHORED_WORKBOOK_SCENARIOS, type AuthoredWorkbookScenarioDescriptor, type AuthoredWorkbookScenarioId } from "./scenarios.js";

export { OPENCODE_API_KEY_ENV, WORKBOOK_TERMINAL_IMAGE, dockerClientEnvironment } from "../../tutorial-engine/src/workbook/terminal.js";

export const SUPPORTED_NODE_RANGE = ">=24.2.0 <25";
export const SUPPORTED_NPM_RANGE = ">=11.0.0";
export const EVAL_JUDGE_MODEL_ENV = "EVAL_JUDGE_MODEL";
export const EVAL_JUDGE_COMMAND_ENV = "EVAL_JUDGE_COMMAND";
export const AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL = 2_000;

export type AuthoredWorkbookEvalRoleKey = "mainTutor" | "judge";
export type AuthoredWorkbookEvalRoleLabel = "Main Tutor" | "Judge";
export type AuthoredWorkbookEvalPreflightPhase =
  | "arguments"
  | "budget"
  | "runtime"
  | "dockerReady"
  | "terminal"
  | "terminalReadiness"
  | "terminalAuth"
  | "cleanup"
  | "mainTutor"
  | "judge";

export interface AuthoredWorkbookEvalRoleDefinition {
  key: AuthoredWorkbookEvalRoleKey;
  label: AuthoredWorkbookEvalRoleLabel;
  env: typeof TUTOR_MODEL_ENV | typeof EVAL_JUDGE_MODEL_ENV;
}

export const WORKBOOK_EVAL_ROLES = Object.freeze([
  Object.freeze({ key: "mainTutor", label: "Main Tutor", env: TUTOR_MODEL_ENV }),
  Object.freeze({ key: "judge", label: "Judge", env: EVAL_JUDGE_MODEL_ENV })
] satisfies AuthoredWorkbookEvalRoleDefinition[]);

export interface PublicModelIdentity {
  provider: string;
  id: string;
}

export interface AuthoredWorkbookEvalRoleModel extends PublicModelIdentity {
  identity: string;
}

export type AuthoredWorkbookEvalModels = Record<AuthoredWorkbookEvalRoleKey, AuthoredWorkbookEvalRoleModel>;
export type AuthoredWorkbookEvalExpectedModelCalls = Readonly<Record<AuthoredWorkbookEvalRoleKey, number> & { total: number }>;

export interface AuthoredWorkbookEvalScenario {
  id: string;
  expectedModelCalls: AuthoredWorkbookEvalExpectedModelCalls;
  expectedBudgetFlags?: Record<string, boolean>;
  expectedCapabilityFlags?: Record<string, boolean>;
}

/** Test-only parser/unit seam. Production preflight resolves IDs from AUTHORED_WORKBOOK_SCENARIOS. */
export type AuthoredWorkbookEvalScenarioCatalogForTest = readonly AuthoredWorkbookEvalScenario[];

export interface AuthoredWorkbookEvalCostBudgetInput {
  maxPaidModelCalls: number;
  maxEstimatedTokens: number;
  estimatedTokensPerPaidCall?: number;
}

export interface AuthoredWorkbookEvalCostBudget {
  maxPaidModelCalls: number;
  maxEstimatedTokens: number;
  estimatedTokensPerPaidCall: number;
}

export interface AuthoredWorkbookEvalPreflightRequestInput {
  scenarioIds: readonly (AuthoredWorkbookScenarioId | string)[];
  repeat?: number;
  costBudget: AuthoredWorkbookEvalCostBudgetInput;
  models?: Partial<Record<AuthoredWorkbookEvalRoleKey, string>>;
  environment?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
  nodeRange?: string;
  npmRange?: string;
}

export type AuthoredWorkbookEvalEnvironment = Readonly<Record<string, string>>;

export interface AuthoredWorkbookEvalPreflightRequest {
  scenarios: readonly Required<Pick<AuthoredWorkbookEvalScenario, "id" | "expectedBudgetFlags" | "expectedCapabilityFlags" | "expectedModelCalls">>[];
  repeat: number;
  costBudget: AuthoredWorkbookEvalCostBudget;
  expectedCosts: AuthoredWorkbookEvalExpectedCosts;
  models: Readonly<AuthoredWorkbookEvalModels>;
  environment: AuthoredWorkbookEvalEnvironment;
  repositoryRoot: string;
  nodeRange: string;
  npmRange: string;
  workbookTerminalImage: typeof WORKBOOK_TERMINAL_IMAGE;
  opencodeApiKeyEnv: typeof OPENCODE_API_KEY_ENV;
  judgeCommandEnv: typeof EVAL_JUDGE_COMMAND_ENV;
}

export interface AuthoredWorkbookEvalExpectedCosts {
  paidPreflightCallsByRole: Record<AuthoredWorkbookEvalRoleLabel, number>;
  paidReleaseCallsByRole: Record<AuthoredWorkbookEvalRoleLabel, number>;
  expectedPaidPreflightCalls: 2;
  expectedPaidReleaseCalls: number;
  expectedPaidModelCallsTotal: number;
  estimatedTokensPerPaidCall: number;
  expectedEstimatedTokensTotal: number;
  releaseScenarioCount: number;
  releaseRunCount: number;
}

export interface AuthoredWorkbookEvalPartialFixtureLease {
  root: string;
  commandStubs?: AuthoredWorkbookEvalCommandStubFixture;
  close(): Promise<void>;
}

export interface AuthoredWorkbookEvalOperationInput {
  request: AuthoredWorkbookEvalPreflightRequest;
  timeoutMs: number;
  signal?: AbortSignal;
  registerPartialFixtureLease?: (lease: AuthoredWorkbookEvalPartialFixtureLease) => void;
}
export interface AuthoredWorkbookEvalPaidRoleInput extends AuthoredWorkbookEvalOperationInput { role: AuthoredWorkbookEvalRoleKey; roleLabel: AuthoredWorkbookEvalRoleLabel; model: AuthoredWorkbookEvalRoleModel }
export interface AuthoredWorkbookEvalPaidRoleResult { selectedModel: PublicModelIdentity }
export interface AuthoredWorkbookEvalJudgeResult { commandLabel: JudgeCommandLabel; model: string; capabilities: { jsonObject: true } }

export interface AuthoredWorkbookEvalCommandStubFixture {
  hostBinDir: string;
  hostStateDir: string;
  hostEvidencePath: string;
  hostConfigPath: string;
  hostContainerConfigPath: string;
  workspaceRelativeBinPath: string;
  containerBinPath: string;
  containerStateDir: string;
  containerEvidencePath: string;
  containerConfigPath: string;
  runId: string;
  containerShellActivation: string;
  hostEnv: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export interface AuthoredWorkbookEvalDisposableFixture {
  root: string;
  workspaceRoot: string;
  /** Docker named volume used only by the terminal preflight; safe, generated, non-secret name. */
  workspaceVolumeName: string;
  trustedNodeModulesHostPath: string;
  commandStubs: AuthoredWorkbookEvalCommandStubFixture;
}

export interface AuthoredWorkbookEvalTerminalInput extends AuthoredWorkbookEvalOperationInput {
  name: string;
  fixture: AuthoredWorkbookEvalDisposableFixture;
  runtimeProvision: TrustedRuntimeProvision;
}

export interface AuthoredWorkbookEvalExternalOperations {
  npmVersion(input: AuthoredWorkbookEvalOperationInput): Promise<string>;
  dockerReady(input: AuthoredWorkbookEvalOperationInput): Promise<void>;
  createDisposablePreflightFixture(input: AuthoredWorkbookEvalOperationInput): Promise<AuthoredWorkbookEvalDisposableFixture>;
  dockerRunTerminal(input: AuthoredWorkbookEvalTerminalInput): Promise<void>;
  dockerMountReadiness(input: AuthoredWorkbookEvalTerminalInput): Promise<void>;
  dockerPiAuthentication(input: AuthoredWorkbookEvalTerminalInput): Promise<void>;
  dockerRemoveTerminal(input: AuthoredWorkbookEvalTerminalInput): Promise<void>;
  removeDisposablePreflightFixture(input: AuthoredWorkbookEvalTerminalInput): Promise<void>;
  probeMainTutor(input: AuthoredWorkbookEvalPaidRoleInput): Promise<AuthoredWorkbookEvalPaidRoleResult>;
  probeJudge(input: AuthoredWorkbookEvalPaidRoleInput): Promise<AuthoredWorkbookEvalJudgeResult>;
}

export interface AuthoredWorkbookEvalPreflightTimeouts {
  npmVersion: number;
  dockerReady: number;
  terminalStart: number;
  terminalReadiness: number;
  terminalAuth: number;
  terminalCleanup: number;
  mainTutor: number;
  judge: number;
  fixture: number;
  fixtureCleanup: number;
}


export type AuthoredWorkbookEvalAsyncDockerCommandRunner = (file: string, args: string[], options: DockerCommandSyncOptions) => Promise<unknown>;

export interface AuthoredWorkbookEvalDefaultOperationDependencies {
  authoredDockerCommandRunner?: AuthoredWorkbookEvalAsyncDockerCommandRunner;
  judgeCommandProbe?: JudgeCommandModelProbe;
}
export interface AuthoredWorkbookEvalPreflightOptions {
  operations?: Partial<AuthoredWorkbookEvalExternalOperations>;
  timeoutsMs?: Partial<AuthoredWorkbookEvalPreflightTimeouts>;
  signal?: AbortSignal;
}

export interface AuthoredWorkbookEvalCallCounts {
  npmVersionChecks: number;
  dockerReadyChecks: number;
  disposableFixturesCreated: number;
  terminalContainerStarts: number;
  terminalReadinessChecks: number;
  terminalAuthChecks: number;
  terminalCleanupChecks: number;
  paidPreflightCallsByRole: Record<AuthoredWorkbookEvalRoleLabel, number>;
}

export interface AuthoredWorkbookEvalPublicSummary {
  scenarioIds: string[];
  repeat: number;
  configuredModelIdentities: Array<{ role: AuthoredWorkbookEvalRoleLabel } & PublicModelIdentity>;
  selectedModelIdentities: Array<{ role: AuthoredWorkbookEvalRoleLabel } & PublicModelIdentity>;
  judge: { commandLabel: JudgeCommandLabel; model: string; capabilities: { jsonObject: true } };
  counts: AuthoredWorkbookEvalCallCounts & AuthoredWorkbookEvalExpectedCosts;
  expectedBudgetFlags: Record<string, boolean>;
  expectedCapabilityFlags: Record<string, boolean>;
  warnings: string[];
}

const DOCKER_PRIVATE_STDIN_MAX_BYTES = 64 * 1024;
const DOCKER_PRIVATE_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;
const DOCKER_EXEC_STDIN_ARGS = ["exec", "-i"] as const;
const PREFLIGHT_DOCKER_VOLUME_PATTERN = /^authored-workbook-preflight-[0-9a-f-]{36}$/;

const DEFAULT_TIMEOUTS_MS: AuthoredWorkbookEvalPreflightTimeouts = Object.freeze({
  npmVersion: 10_000,
  dockerReady: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.info + DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.imageInspect,
  terminalStart: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.containerStart,
  terminalReadiness: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.piAuthentication,
  terminalAuth: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.piAuthentication,
  terminalCleanup: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.cleanup,
  mainTutor: 70_000,
  judge: 130_000,
  fixture: 10_000,
  fixtureCleanup: 10_000
});

const PUBLIC_FAILURE_MESSAGES: Readonly<Record<AuthoredWorkbookEvalPreflightPhase, string>> = Object.freeze({
  arguments: "Invalid authored workbook eval preflight arguments.",
  budget: "Invalid authored workbook eval cost budget.",
  runtime: "Unsupported local runtime for authored workbook evals.",
  dockerReady: "Docker daemon or workbook terminal image preflight failed.",
  terminal: "Workbook terminal container preflight failed.",
  terminalReadiness: "Workbook terminal readiness preflight failed.",
  terminalAuth: "Workbook terminal authentication preflight failed.",
  cleanup: "Authored workbook eval preflight cleanup failed.",
  mainTutor: "Main Tutor paid preflight failed.",
  judge: "Judge paid preflight failed."
});

export class AuthoredWorkbookEvalPreflightError extends Error {
  readonly phase: AuthoredWorkbookEvalPreflightPhase;
  readonly code: string;
  readonly role?: AuthoredWorkbookEvalRoleLabel;
  readonly model?: PublicModelIdentity;

  constructor(phase: AuthoredWorkbookEvalPreflightPhase, details: { code?: string; role?: AuthoredWorkbookEvalRoleLabel; model?: PublicModelIdentity } = {}) {
    const message = PUBLIC_FAILURE_MESSAGES[phase];
    super(message);
    this.name = "AuthoredWorkbookEvalPreflightError";
    this.phase = phase;
    this.code = details.code ?? `authored_workbook_eval_preflight_${phase}`;
    this.role = details.role;
    this.model = details.model === undefined ? undefined : { provider: details.model.provider, id: details.model.id };
    Object.defineProperty(this, "stack", { value: `${this.name}: ${message}`, writable: true, configurable: true });
  }
}

export function formatAuthoredWorkbookEvalPreflightHelp(): string {
  return [
    "Authored workbook eval preflight API helper (not the final eval:workbook CLI).",
    "",
    "Required model identity options for future CLI wiring:",
    "  --tutor-model <provider/model>             Also accepted from TUTOR_MODEL.",
    "  --judge-model <provider/model>             Also accepted from EVAL_JUDGE_MODEL.",
    "  EVAL_JUDGE_COMMAND must name the judge command path/entry point.",
    "  OPENCODE_API_KEY must be present in the environment for the terminal auth path.",
    "",
    "Required bounded budget options:",
    "  --max-paid-model-calls <integer>",
    "  --max-estimated-tokens <integer>",
    "  --repeat <1|2|3>                         Optional; defaults to 1. The final release CLI will force 1.",
    "",
    "The parser only validates arguments. It does not create reports, session workspaces, curriculum slices, Docker containers, or model sessions."
  ].join("\n");
}

export type ParsedAuthoredWorkbookEvalPreflightArgs =
  | { kind: "help"; text: string }
  | { kind: "request"; request: AuthoredWorkbookEvalPreflightRequestInput };

export function parseAuthoredWorkbookEvalPreflightArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  scenarioCatalogForTest?: AuthoredWorkbookEvalScenarioCatalogForTest
): ParsedAuthoredWorkbookEvalPreflightArgs {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { kind: "help", text: formatAuthoredWorkbookEvalPreflightHelp() };

  const scenarioIds: string[] = [];
  const models: Partial<Record<AuthoredWorkbookEvalRoleKey, string>> = {};
  const costBudget: Partial<AuthoredWorkbookEvalCostBudgetInput> = {};
  let repeat: number | undefined;
  const singletonFlags = new Set<string>();
  const recordSingleton = (flag: string) => {
    if (singletonFlags.has(flag)) throw validationError();
    singletonFlags.add(flag);
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) throw validationError();
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw validationError();
    index += 1;
    if (flag === "--scenario") scenarioIds.push(value);
    else if (flag === "--tutor-model") { recordSingleton(flag); models.mainTutor = value; }
    else if (flag === "--judge-model") { recordSingleton(flag); models.judge = value; }
    else if (flag === "--max-paid-model-calls") { recordSingleton(flag); costBudget.maxPaidModelCalls = parsePositiveInteger(value); }
    else if (flag === "--max-estimated-tokens") { recordSingleton(flag); costBudget.maxEstimatedTokens = parsePositiveInteger(value); }
    else if (flag === "--repeat") { recordSingleton(flag); repeat = parseRepeat(value); }
    else throw validationError();
  }

  const resolvedScenarioIds = resolveScenarioIdsForParser(scenarioIds, scenarioCatalogForTest);
  for (const role of WORKBOOK_EVAL_ROLES) models[role.key] ??= environment[role.env];
  const request = Object.freeze({ scenarioIds: Object.freeze([...resolvedScenarioIds]), repeat: repeat ?? 1, models: Object.freeze({ ...models }), costBudget: Object.freeze({ ...costBudget }) as AuthoredWorkbookEvalCostBudgetInput, environment });
  validateAuthoredWorkbookEvalPreflightRequestInternal(request, scenarioCatalogForTest ?? AUTHORED_WORKBOOK_SCENARIOS);
  return { kind: "request", request };
}

export function validateAuthoredWorkbookEvalPreflightRequest(input: AuthoredWorkbookEvalPreflightRequestInput): AuthoredWorkbookEvalPreflightRequest {
  return validateAuthoredWorkbookEvalPreflightRequestInternal(input, AUTHORED_WORKBOOK_SCENARIOS);
}

/** Test-only catalog seam for parser/unit validation. Production code must call validateAuthoredWorkbookEvalPreflightRequest(). */
export function validateAuthoredWorkbookEvalPreflightRequestForTest(input: AuthoredWorkbookEvalPreflightRequestInput, catalog: AuthoredWorkbookEvalScenarioCatalogForTest): AuthoredWorkbookEvalPreflightRequest {
  return validateAuthoredWorkbookEvalPreflightRequestInternal(input, catalog);
}

function validateAuthoredWorkbookEvalPreflightRequestInternal(input: AuthoredWorkbookEvalPreflightRequestInput, catalog: readonly (AuthoredWorkbookEvalScenario | AuthoredWorkbookScenarioDescriptor)[]): AuthoredWorkbookEvalPreflightRequest {
  if (!input || typeof input !== "object" || Object.hasOwn(input, "scenarios")) throw validationError();
  const environment = snapshotAuthoredWorkbookEvalEnvironment(input.environment ?? process.env, input.models);
  const scenarios = resolveScenariosFromCatalog(input.scenarioIds, catalog);
  const repeat = validateRepeat(input.repeat);
  const models = validateModels(input.models, environment);
  const repositoryRoot = input.repositoryRoot === undefined ? process.cwd() : validateHostPath(input.repositoryRoot);
  const nodeRange = input.nodeRange ?? SUPPORTED_NODE_RANGE;
  const npmRange = input.npmRange ?? SUPPORTED_NPM_RANGE;

  assertRequiredEnvironment(environment);
  if (!satisfiesVersionRange(process.version, nodeRange)) throw new AuthoredWorkbookEvalPreflightError("runtime", { code: "unsupported_node_version" });

  const costBudget = validateCostBudget(input.costBudget);
  const expectedCosts = expectedCostsFor(scenarios, costBudget, repeat);
  if (costBudget.maxPaidModelCalls < expectedCosts.expectedPaidModelCallsTotal) throw new AuthoredWorkbookEvalPreflightError("budget", { code: "paid_model_call_budget_too_low" });
  if (costBudget.maxEstimatedTokens < expectedCosts.expectedEstimatedTokensTotal) throw new AuthoredWorkbookEvalPreflightError("budget", { code: "estimated_token_budget_too_low" });

  return deepFreezePlain({
    scenarios,
    repeat,
    costBudget,
    expectedCosts,
    models,
    environment,
    repositoryRoot,
    nodeRange,
    npmRange,
    workbookTerminalImage: WORKBOOK_TERMINAL_IMAGE,
    opencodeApiKeyEnv: OPENCODE_API_KEY_ENV,
    judgeCommandEnv: EVAL_JUDGE_COMMAND_ENV
  });
}

export async function runAuthoredWorkbookEvalPreflight(input: AuthoredWorkbookEvalPreflightRequestInput, options: AuthoredWorkbookEvalPreflightOptions = {}): Promise<AuthoredWorkbookEvalPublicSummary> {
  const request = validateAuthoredWorkbookEvalPreflightRequest(input);
  const operations: AuthoredWorkbookEvalExternalOperations = { ...defaultPreflightOperations(), ...options.operations };
  const timeouts = { ...DEFAULT_TIMEOUTS_MS, ...options.timeoutsMs };
  const callCounts = emptyCallCounts();
  const externalSignal = options.signal;
  throwPreflightIfAborted(externalSignal, "runtime");

  callCounts.npmVersionChecks += 1;
  const npmVersion = await sanitizeStage("runtime", "unsupported_npm_version", () => withAbortableTimeout((signal) => operations.npmVersion({ request, timeoutMs: timeouts.npmVersion, signal }), timeouts.npmVersion, undefined, externalSignal));
  if (!satisfiesVersionRange(npmVersion, request.npmRange)) throw new AuthoredWorkbookEvalPreflightError("runtime", { code: "unsupported_npm_version" });
  throwPreflightIfAborted(externalSignal, "runtime");

  callCounts.dockerReadyChecks += 1;
  await sanitizeStage("dockerReady", "docker_ready_preflight_failed", () => withAbortableTimeout((signal) => operations.dockerReady({ request, timeoutMs: timeouts.dockerReady, signal }), timeouts.dockerReady, undefined, externalSignal));
  throwPreflightIfAborted(externalSignal, "dockerReady");

  await runDisposableTerminalPreflight(request, operations, callCounts, timeouts, externalSignal);
  throwPreflightIfAborted(externalSignal, "terminal");

  const selectedModels: Array<{ role: AuthoredWorkbookEvalRoleLabel } & PublicModelIdentity> = [];
  const mainTutor = WORKBOOK_EVAL_ROLES[0]!;
  const judge = WORKBOOK_EVAL_ROLES[1]!;

  selectedModels.push(await runPaidRole("mainTutor", mainTutor, request, operations, callCounts, timeouts.mainTutor, externalSignal));
  throwPreflightIfAborted(externalSignal, "mainTutor");
  const judgeResult = await runPaidJudge(judge, request, operations, callCounts, timeouts.judge, externalSignal);
  selectedModels.push({ role: judge.label, ...request.models.judge });

  return publicPreflightSummary(request, selectedModels, judgeResult, callCounts);
}

async function runDisposableTerminalPreflight(
  request: AuthoredWorkbookEvalPreflightRequest,
  operations: AuthoredWorkbookEvalExternalOperations,
  callCounts: AuthoredWorkbookEvalCallCounts,
  timeouts: AuthoredWorkbookEvalPreflightTimeouts,
  externalSignal?: AbortSignal
): Promise<void> {
  let fixture: AuthoredWorkbookEvalDisposableFixture | undefined;
  let terminalInput: AuthoredWorkbookEvalTerminalInput | undefined;
  let primaryFailure: AuthoredWorkbookEvalPreflightError | undefined;
  let cleanupFailure = false;

  try {
    fixture = await sanitizeStage("terminal", "terminal_fixture_failed", () => createFixtureWithAbortableLease(request, operations, timeouts.fixture, externalSignal));
    callCounts.disposableFixturesCreated += 1;
    assertSafePreflightDockerVolumeName(fixture.workspaceVolumeName);
    const runtimeProvision = trustRuntimeProvision();
    const preparedTerminalInput: AuthoredWorkbookEvalTerminalInput = { request, timeoutMs: timeouts.terminalStart, signal: neverAbortedSignal(), name: `workbook-terminal-preflight-${randomUUID()}`, fixture, runtimeProvision };
    terminalInput = preparedTerminalInput;

    callCounts.terminalContainerStarts += 1;
    await sanitizeStage("terminal", "terminal_start_failed", () => withAbortableTimeout((signal) => operations.dockerRunTerminal({ ...preparedTerminalInput, timeoutMs: timeouts.terminalStart, signal }), timeouts.terminalStart, undefined, externalSignal));

    callCounts.terminalReadinessChecks += 1;
    await sanitizeStage("terminalReadiness", "terminal_readiness_failed", () => withAbortableTimeout((signal) => operations.dockerMountReadiness({ ...preparedTerminalInput, timeoutMs: timeouts.terminalReadiness, signal }), timeouts.terminalReadiness, undefined, externalSignal));

    callCounts.terminalAuthChecks += 1;
    await sanitizeStage("terminalAuth", "terminal_auth_failed", () => withAbortableTimeout((signal) => operations.dockerPiAuthentication({ ...preparedTerminalInput, timeoutMs: timeouts.terminalAuth, signal }), timeouts.terminalAuth, undefined, externalSignal));
  } catch (error) {
    primaryFailure = error instanceof AuthoredWorkbookEvalPreflightError ? error : new AuthoredWorkbookEvalPreflightError("terminal", { code: "terminal_preflight_failed" });
  } finally {
    const cleanupTerminalInput = terminalInput;
    if (cleanupTerminalInput) {
      callCounts.terminalCleanupChecks += 1;
      try { await withAbortableTimeout((signal) => operations.dockerRemoveTerminal({ ...cleanupTerminalInput, timeoutMs: timeouts.terminalCleanup, signal }), timeouts.terminalCleanup); }
      catch { cleanupFailure = true; }
      try { await withAbortableTimeout((signal) => operations.removeDisposablePreflightFixture({ ...cleanupTerminalInput, timeoutMs: timeouts.fixtureCleanup, signal }), timeouts.fixtureCleanup); }
      catch { cleanupFailure = true; }
    } else if (fixture) {
      const cleanupInput: AuthoredWorkbookEvalTerminalInput = { request, timeoutMs: timeouts.fixtureCleanup, signal: neverAbortedSignal(), name: "not-started", fixture, runtimeProvision: trustRuntimeProvision() };
      try { await withAbortableTimeout((signal) => operations.removeDisposablePreflightFixture({ ...cleanupInput, signal }), timeouts.fixtureCleanup); }
      catch { cleanupFailure = true; }
    }
  }
  if (cleanupFailure) throw new AuthoredWorkbookEvalPreflightError("cleanup", { code: "preflight_cleanup_failed" });
  if (primaryFailure) throw primaryFailure;
}

async function runPaidRole(
  operation: "mainTutor",
  role: AuthoredWorkbookEvalRoleDefinition,
  request: AuthoredWorkbookEvalPreflightRequest,
  operations: AuthoredWorkbookEvalExternalOperations,
  callCounts: AuthoredWorkbookEvalCallCounts,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<{ role: AuthoredWorkbookEvalRoleLabel } & PublicModelIdentity> {
  const model = request.models[role.key];
  callCounts.paidPreflightCallsByRole[role.label] += 1;
  const result = await sanitizeStage(operation, `${operation}_paid_preflight_failed`, () => withAbortableTimeout(
    (signal) => operations.probeMainTutor({ request, timeoutMs, signal, role: role.key, roleLabel: role.label, model }),
    timeoutMs,
    undefined,
    externalSignal
  ), role.label, model);
  return { role: role.label, ...validatePublicModelIdentity(result.selectedModel) };
}

async function runPaidJudge(
  role: AuthoredWorkbookEvalRoleDefinition,
  request: AuthoredWorkbookEvalPreflightRequest,
  operations: AuthoredWorkbookEvalExternalOperations,
  callCounts: AuthoredWorkbookEvalCallCounts,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<AuthoredWorkbookEvalJudgeResult> {
  const model = request.models.judge;
  callCounts.paidPreflightCallsByRole[role.label] += 1;
  const result = await sanitizeStage("judge", "judge_paid_preflight_failed", () => withAbortableTimeout(
    (signal) => operations.probeJudge({ request, timeoutMs, signal, role: role.key, roleLabel: role.label, model }),
    timeoutMs,
    undefined,
    externalSignal
  ), role.label, model);
  if (result.model !== model.identity || result.capabilities.jsonObject !== true) throw new AuthoredWorkbookEvalPreflightError("judge", { code: "judge_model_mismatch", role: role.label, model });
  return { commandLabel: result.commandLabel, model: result.model, capabilities: { jsonObject: true } };
}

export function publicPreflightSummary(
  request: AuthoredWorkbookEvalPreflightRequest,
  selectedModels: Array<{ role: AuthoredWorkbookEvalRoleLabel } & PublicModelIdentity>,
  judgeResult: AuthoredWorkbookEvalJudgeResult,
  callCounts: AuthoredWorkbookEvalCallCounts = emptyCallCounts()
): AuthoredWorkbookEvalPublicSummary {
  return deepFreezePlain({
    scenarioIds: request.scenarios.map((scenario) => scenario.id),
    repeat: request.repeat,
    configuredModelIdentities: WORKBOOK_EVAL_ROLES.map((role) => ({ role: role.label, provider: request.models[role.key].provider, id: request.models[role.key].id })),
    selectedModelIdentities: selectedModels.map((model) => ({ role: model.role, provider: model.provider, id: model.id })),
    judge: { commandLabel: judgeResult.commandLabel, model: judgeResult.model, capabilities: { jsonObject: true } },
    counts: { ...cloneCallCounts(callCounts), ...request.expectedCosts },
    expectedBudgetFlags: mergeScenarioFlags(request.scenarios, "expectedBudgetFlags"),
    expectedCapabilityFlags: mergeScenarioFlags(request.scenarios, "expectedCapabilityFlags"),
    warnings: [`Paid model-token checks are enabled for Main Tutor and Judge. Budget allows ${request.costBudget.maxPaidModelCalls} paid calls and ${request.costBudget.maxEstimatedTokens} estimated tokens.`]
  });
}

export interface AuthoredWorkbookRunnerModelConfiguration {
  createMainTutor(options: Omit<MainWorkbookTutorOptions, "environment">): DefaultMainWorkbookTutor;
}

/**
 * Runner API note: the future authored runner should call this after a successful preflight and pass
 * the returned factory into workbook server construction, so the live tutor role uses the
 * private least-privilege model environment derived from preflight. The public summary is accepted
 * here to make any runner handoff prove it is using the matching preflight result, without exposing credentials.
 */
export function createAuthoredWorkbookRunnerModelConfiguration(
  request: AuthoredWorkbookEvalPreflightRequest,
  summary: Pick<AuthoredWorkbookEvalPublicSummary, "configuredModelIdentities" | "repeat" | "scenarioIds">
): AuthoredWorkbookRunnerModelConfiguration {
  assertRunnerSummaryMatchesRequest(request, summary);
  const environment = createAuthoredWorkbookRunnerRoleEnvironment(request);
  return Object.freeze({
    createMainTutor: (options: Omit<MainWorkbookTutorOptions, "environment">) => new DefaultMainWorkbookTutor({ ...options, environment })
  });
}

function createAuthoredWorkbookRunnerRoleEnvironment(request: AuthoredWorkbookEvalPreflightRequest): WorkbookModelEnvironment {
  const environment: Record<string, string> = {
    [TUTOR_MODEL_ENV]: request.models.mainTutor.identity
  };
  return Object.freeze(environment);
}

function assertRunnerSummaryMatchesRequest(
  request: AuthoredWorkbookEvalPreflightRequest,
  summary: Pick<AuthoredWorkbookEvalPublicSummary, "configuredModelIdentities" | "repeat" | "scenarioIds">
): void {
  if (summary.repeat !== request.repeat) throw validationError();
  if (JSON.stringify(summary.scenarioIds) !== JSON.stringify(request.scenarios.map((scenario) => scenario.id))) throw validationError();
  const expected = WORKBOOK_EVAL_ROLES.map((role) => ({ role: role.label, provider: request.models[role.key].provider, id: request.models[role.key].id }));
  if (JSON.stringify(summary.configuredModelIdentities) !== JSON.stringify(expected)) throw validationError();
}

export function defaultPreflightOperations(dependencies: AuthoredWorkbookEvalDefaultOperationDependencies = {}): AuthoredWorkbookEvalExternalOperations {
  const dockerRunner = dependencies.authoredDockerCommandRunner ?? defaultDockerCommandRunner;
  return {
    npmVersion: async ({ request, timeoutMs, signal }) => (await execFileText("npm", ["--version"], request.environment, timeoutMs, signal)).trim(),
    dockerReady: async ({ request, signal }) => {
      const env = dockerClientEnvironment(request.environment);
      await dockerRunner("docker", dockerDaemonProbeArguments(), { stdio: "ignore", env, timeout: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.info, signal });
      await dockerRunner("docker", dockerImageProbeArguments(request.workbookTerminalImage), { stdio: "ignore", env, timeout: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.imageInspect, signal });
    },
    createDisposablePreflightFixture: defaultCreateDisposablePreflightFixture,
    dockerRunTerminal: async (input) => {
      const apiKey = requireOpenCodeApiKey(input.request.environment);
      await dockerRunner("docker", dockerVolumeCreateArguments(input.fixture.workspaceVolumeName), { stdio: "ignore", env: dockerClientEnvironment(input.request.environment), timeout: input.timeoutMs, signal: input.signal });
      await dockerRunner("docker", dockerPopulateVolumeArguments(input.fixture.workspaceVolumeName, input.request.workbookTerminalImage), { stdio: "ignore", env: dockerClientEnvironment(input.request.environment), timeout: input.timeoutMs, signal: input.signal, privateStdin: await buildBoundedWorkspaceTar(input.fixture.workspaceRoot) });
      const args = authoredTerminalDockerRunArguments(input);
      await dockerRunner("docker", args, { stdio: "ignore", env: dockerRunEnvironment(apiKey, input.request.environment), timeout: input.timeoutMs, signal: input.signal });
    },
    dockerMountReadiness: async (input) => {
      await dockerRunner("docker", dockerExecShStdinArguments(input.name), { stdio: "ignore", env: dockerClientEnvironment(input.request.environment), timeout: input.timeoutMs, signal: input.signal, privateStdin: boundedDockerPrivateStdin(terminalReadinessShell(input.fixture.commandStubs)) });
    },
    dockerPiAuthentication: async (input) => {
      await dockerRunner("docker", dockerExecShStdinArguments(input.name), { stdio: "ignore", env: dockerClientEnvironment(input.request.environment), timeout: input.timeoutMs, signal: input.signal, privateStdin: boundedDockerPrivateStdin(dockerPiAuthenticationShell()) });
    },
    dockerRemoveTerminal: async (input) => {
      let failure: unknown;
      try { await dockerRunner("docker", ["rm", "-f", input.name], { stdio: "ignore", env: dockerClientEnvironment(input.request.environment), timeout: input.timeoutMs, signal: input.signal }); }
      catch (error) { failure = error; }
      try { await dockerRunner("docker", dockerVolumeRemoveArguments(input.fixture.workspaceVolumeName), { stdio: "ignore", env: dockerClientEnvironment(input.request.environment), timeout: input.timeoutMs, signal: input.signal }); }
      catch (error) { failure ??= error; }
      if (failure) throw new Error("Docker terminal cleanup failed.");
    },
    removeDisposablePreflightFixture: defaultRemoveDisposablePreflightFixture,
    probeMainTutor: createDefaultWorkbookRoleProbe("Main Tutor"),
    probeJudge: createDefaultJudgeProbe(dependencies.judgeCommandProbe)
  };
}

const defaultDockerCommandRunner: AuthoredWorkbookEvalAsyncDockerCommandRunner = (file: string, args: string[], options: DockerCommandSyncOptions): Promise<unknown> => runBoundedProcess(file, args, options);

export function authoredTerminalDockerRunArguments(input: AuthoredWorkbookEvalTerminalInput): string[] {
  const containerUser = validatedDockerContainerUser();
  return ["run", "-d", "--rm", "--name", input.name, "--label", "workbook-terminal=true", "--user", containerUser.user, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=768m", "--cpus=1", "--network=bridge", "--init", "--env", OPENCODE_API_KEY_ENV, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--tmpfs", `/home/learner/.pi/agent:uid=${containerUser.uid},gid=${containerUser.gid},mode=0700`, "--mount", dockerWorkspaceVolumeMount(input.fixture.workspaceVolumeName), "--workdir", "/workspace", input.request.workbookTerminalImage, "sleep", "infinity"];
}

export function createDefaultWorkbookRoleProbe(role: "Main Tutor"): (input: AuthoredWorkbookEvalPaidRoleInput) => Promise<AuthoredWorkbookEvalPaidRoleResult> {
  return async ({ request, timeoutMs, signal }) => {
    const envVar = TUTOR_MODEL_ENV;
    throwIfAborted(signal);
    const result = await withAbortableTimeout(() => probePiWorkbookRoleModel({
      role,
      envVar,
      contentRoot: request.repositoryRoot,
      workspaceRoot: request.repositoryRoot,
      logger: noopLogger(),
      environment: request.environment,
      signal
    }), timeoutMs, undefined, signal);
    throwIfAborted(signal);
    return { selectedModel: validatePublicModelIdentity(result.selectedModel ?? result.requestedModel ?? modelIdentityFromEnvironment(request)) };
  };
}

export type JudgeCommandModelProbe = (environment: NodeJS.ProcessEnv, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<V2JudgeCommandPreflightResult>;

export function createDefaultJudgeProbe(commandProbe: JudgeCommandModelProbe = probeV2JudgeCommandModel): (input: AuthoredWorkbookEvalPaidRoleInput) => Promise<AuthoredWorkbookEvalJudgeResult> {
  return async ({ request, timeoutMs, signal }) => {
    throwIfAborted(signal);
    const result = await commandProbe(request.environment, { timeoutMs, signal });
    throwIfAborted(signal);
    return { commandLabel: result.commandLabel, model: result.model, capabilities: { jsonObject: true } };
  };
}

export async function defaultCreateDisposablePreflightFixture({ request, signal, registerPartialFixtureLease }: AuthoredWorkbookEvalOperationInput): Promise<AuthoredWorkbookEvalDisposableFixture> {
  const abortSignal = signal ?? neverAbortedSignal();
  let root = "";
  let commandStubs: AuthoredWorkbookEvalCommandStubFixture | undefined;
  try {
    throwIfAborted(abortSignal);
    root = await mkdtemp(resolve(tmpdir(), "authored-workbook-preflight-"));
    const workspaceRoot = resolve(root, "workspace");
    const workspaceVolumeName = safePreflightDockerVolumeName();
    const trustedNodeModulesHostPath = resolve(root, "node_modules");
    const lease: AuthoredWorkbookEvalPartialFixtureLease = {
      root,
      get commandStubs() { return commandStubs; },
      close: async () => {
        const closeError = await cleanupFixtureRoot(root, commandStubs);
        if (closeError) throw closeError;
      }
    };
    registerPartialFixtureLease?.(lease);
    throwIfAborted(abortSignal);
    const sourceCalculator = resolve(request.repositoryRoot, "tutorial/workspaces/refactor-line/calculator");
    await mkdirChecked(workspaceRoot, abortSignal);
    await mkdirChecked(trustedNodeModulesHostPath, abortSignal);
    await copyCanonicalCalculator(sourceCalculator, resolve(workspaceRoot, "calculator"), abortSignal);
    await mkdirChecked(resolve(workspaceRoot, "factory/refactor/.tmp"), abortSignal);
    await writeFileChecked(resolve(workspaceRoot, "factory/refactor/success.md"), [
      "# Success",
      "",
      "- passes its tests",
      "- reveals intention",
      "- no duplication",
      "- fewest elements",
      ""
    ].join("\n"), abortSignal);
    throwIfAborted(abortSignal);
    commandStubs = toDisposableCommandStubFixture(await createAuthoredCommandStubs({ lessonNumber: 4, workspaceRoot, scenarioId: "authored-preflight" }));
    throwIfAborted(abortSignal);
    return { root, workspaceRoot, workspaceVolumeName, trustedNodeModulesHostPath, commandStubs };
  } catch (error) {
    if (root) await cleanupFixtureRoot(root, commandStubs).catch(() => undefined);
    throw error;
  }
}

const FIXTURE_COPY_EXCLUDED_SEGMENTS = new Set([".git", "node_modules", ".tmp", "dist", "coverage"]);

async function mkdirChecked(path: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await mkdir(path, { recursive: true });
  throwIfAborted(signal);
}

async function writeFileChecked(path: string, content: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await writeFile(path, content, "utf8");
  throwIfAborted(signal);
}

async function copyCanonicalCalculator(sourceCalculator: string, destinationCalculator: string, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const sourceRoot = await realpath(sourceCalculator);
  throwIfAborted(signal);
  await cp(sourceRoot, destinationCalculator, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => {
      throwIfAborted(signal);
      const rel = relative(sourceRoot, source);
      if (!rel) return true;
      return !rel.split(sep).some((segment) => FIXTURE_COPY_EXCLUDED_SEGMENTS.has(segment));
    }
  });
  throwIfAborted(signal);
}

function toDisposableCommandStubFixture(handle: AuthoredCommandStubHandle): AuthoredWorkbookEvalCommandStubFixture {
  return {
    hostBinDir: handle.hostBinDir,
    hostStateDir: handle.hostStateDir,
    hostEvidencePath: handle.hostEvidencePath,
    hostConfigPath: handle.hostConfigPath,
    hostContainerConfigPath: handle.hostContainerConfigPath,
    workspaceRelativeBinPath: handle.workspaceRelativeBinPath,
    containerBinPath: handle.containerBinPath,
    containerStateDir: handle.containerStateDir,
    containerEvidencePath: handle.containerEvidencePath,
    containerConfigPath: handle.containerConfigPath,
    runId: handle.runId,
    containerShellActivation: handle.containerShellActivation,
    hostEnv: handle.hostEnv,
    close: handle.close
  };
}

export async function defaultRemoveDisposablePreflightFixture({ fixture }: AuthoredWorkbookEvalTerminalInput): Promise<void> {
  const cleanupError = await cleanupFixtureRoot(fixture.root, fixture.commandStubs);
  if (cleanupError) throw new Error("fixture cleanup failed");
}

async function cleanupFixtureRoot(root: string, commandStubs: AuthoredWorkbookEvalCommandStubFixture | undefined): Promise<unknown> {
  let cleanupError: unknown;
  try { await commandStubs?.close(); }
  catch (error) { cleanupError = error; }
  try { await rm(root, { recursive: true, force: true }); }
  catch (error) { cleanupError ??= error; }
  return cleanupError;
}

function safePreflightDockerVolumeName(): string {
  return `authored-workbook-preflight-${randomUUID()}`;
}

function assertSafePreflightDockerVolumeName(name: string): string {
  if (!PREFLIGHT_DOCKER_VOLUME_PATTERN.test(name)) throw new Error("Unsafe preflight Docker volume name.");
  return name;
}

export function dockerWorkspaceVolumeMount(volumeName: string): string {
  return `type=volume,src=${assertSafePreflightDockerVolumeName(volumeName)},dst=/workspace`;
}

export function dockerVolumeCreateArguments(volumeName: string): string[] {
  return ["volume", "create", assertSafePreflightDockerVolumeName(volumeName)];
}

export function dockerVolumeRemoveArguments(volumeName: string): string[] {
  return ["volume", "rm", "-f", assertSafePreflightDockerVolumeName(volumeName)];
}

export function dockerPopulateVolumeArguments(volumeName: string, image: string): string[] {
  return ["run", "--rm", "-i", "--network", "none", "--mount", dockerWorkspaceVolumeMount(volumeName), image, "tar", "--same-owner", "-x", "-f", "-", "-C", "/workspace"];
}

function dockerExecShStdinArguments(name: string): string[] {
  return [...DOCKER_EXEC_STDIN_ARGS, name, "sh"];
}

function boundedDockerPrivateStdin(script: string): string {
  const payload = script.endsWith("\n") ? script : `${script}\n`;
  if (Buffer.byteLength(payload, "utf8") > DOCKER_PRIVATE_STDIN_MAX_BYTES) throw new Error("Docker private stdin payload exceeds the authored preflight limit.");
  return payload;
}

function dockerPiAuthenticationShell(): string {
  const script = [
    "const { execFile } = await import('node:child_process');",
    "const globalRoot = await new Promise((resolve, reject) => execFile('npm', ['root', '--global'], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));",
    "const { ModelRuntime } = await import(`${globalRoot}/@earendil-works/pi-coding-agent/dist/index.js`);",
    "if ((await ModelRuntime.create().then((runtime) => runtime.getAvailable())).length === 0) process.exit(1);"
  ].join(" ");
  return `node --input-type=module <<'NODE'\n${script}\nNODE`;
}

function terminalReadinessShell(stubs: AuthoredWorkbookEvalCommandStubFixture): string {
  const validatorPrompt = "Findings reported by: authored preflight.\n- calculator/src/index.ts duplicated operator branch parser\n";
  return [
    "set -eu",
    "test -d /workspace",
    "test -w /workspace",
    "test -d /workspace/calculator",
    "test -f /workspace/calculator/package.json",
    "test -d /workspace/factory/.tmp",
    exactStubLayoutCheck(stubs),
    "command -v jq >/dev/null",
    stubs.containerShellActivation,
    `test \"$(command -v pi)\" = ${shellQuote(stubs.containerBinPath + "/pi")}`,
    `cd /workspace/calculator && printf %s ${shellQuote(validatorPrompt)} | pi --no-session --tools read,grep,find,ls,bash -p >/tmp/authored-preflight-validator.out`,
    structuralEvidenceCheck(stubs)
  ].join(" && ");
}

function exactStubLayoutCheck(stubs: AuthoredWorkbookEvalCommandStubFixture): string {
  const script = [
    "import { lstatSync, readFileSync } from 'node:fs';",
    `const bin = ${JSON.stringify(stubs.containerBinPath + "/pi")};`,
    `const cfg = ${JSON.stringify(stubs.containerConfigPath)};`,
    "const binStat = lstatSync(bin);",
    "if (!binStat.isFile() || binStat.isSymbolicLink() || (binStat.mode & 0o111) === 0) process.exit(1);",
    "const cfgStat = lstatSync(cfg);",
    "if (!cfgStat.isFile() || cfgStat.isSymbolicLink()) process.exit(1);",
    "const config = JSON.parse(readFileSync(cfg, 'utf8'));",
    "if (config.runtime !== 'container' || config.workspaceRoot !== '/workspace') process.exit(1);",
    "if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.runId)) process.exit(1);",
    `if (config.runId !== ${JSON.stringify(stubs.runId)}) process.exit(1);`,
    `if (config.stateDir !== ${JSON.stringify(stubs.containerStateDir)} || config.evidencePath !== ${JSON.stringify(stubs.containerEvidencePath)}) process.exit(1);`
  ].join(" ");
  return `node --input-type=module -e ${shellQuote(script)}`;
}

function structuralEvidenceCheck(stubs: AuthoredWorkbookEvalCommandStubFixture): string {
  const script = [
    "import { readFileSync } from 'node:fs';",
    `const evidencePath = ${JSON.stringify(stubs.containerEvidencePath)};`,
    "const lines = readFileSync(evidencePath, 'utf8').trim().split('\\n').filter(Boolean);",
    "if (lines.length !== 1) process.exit(1);",
    "const entry = JSON.parse(lines[0]);",
    `if (entry.runId !== ${JSON.stringify(stubs.runId)}) process.exit(1);`,
    "if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.runId)) process.exit(1);",
    "if (entry.kind !== 'pi' || entry.accepted !== true || entry.cwd !== 'calculator') process.exit(1);",
    "if (entry.mode !== 'text' || entry.tools !== 'read,grep,find,ls,bash' || entry.station !== 'validator') process.exit(1);",
    "if (!entry.output || typeof entry.output.sha256 !== 'string' || typeof entry.output.bytes !== 'number') process.exit(1);",
    "if (!Array.isArray(entry.output.eventClasses) || !entry.output.eventClasses.includes('text')) process.exit(1);"
  ].join(" ");
  return `node --input-type=module -e ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function buildBoundedWorkspaceTar(root: string): Promise<Buffer> {
  const containerUser = validatedDockerContainerUser();
  const realRoot = await realpath(root);
  const chunks: Buffer[] = [];
  let total = 0;
  const push = (chunk: Buffer) => {
    total += chunk.length;
    if (total > DOCKER_PRIVATE_ARCHIVE_MAX_BYTES) throw new Error("Docker private archive exceeds the authored preflight limit.");
    chunks.push(chunk);
  };
  const pushHeader = (name: string, mode: number, size: number, typeflag: "0" | "5"): void => {
    push(tarHeader(name, mode, containerUser.uid, containerUser.gid, size, typeflag));
  };
  const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!/^[A-Za-z0-9._/-]+$/.test(relativePath) || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Unsafe archive entry path.");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        throw new Error("Unsafe archive entry symlink.");
      } else if (stat.isDirectory()) {
        if (!insideRoot(realRoot, await realpath(path))) throw new Error("Unsafe archive entry outside workspace.");
        pushHeader(`${relativePath}/`, learnerWritableDirectoryMode(stat.mode), 0, "5");
        await visit(path, relativePath);
      } else if (stat.isFile()) {
        if (stat.nlink > 1) throw new Error("Unsafe archive entry hardlink.");
        if (!insideRoot(realRoot, await realpath(path))) throw new Error("Unsafe archive entry outside workspace.");
        const content = await readFile(path);
        pushHeader(relativePath, learnerWritableFileMode(stat.mode), content.length, "0");
        push(content);
        const padding = (512 - (content.length % 512)) % 512;
        if (padding) push(Buffer.alloc(padding));
      }
    }
  };
  const rootStat = await lstat(realRoot);
  if (!rootStat.isDirectory()) throw new Error("Workspace archive root must be a directory.");
  // The leading ./ entry lets tar --same-owner chown the fresh named-volume mount point itself,
  // not just its children, before the hardened terminal runs as the non-root learner identity.
  pushHeader("./", learnerWritableDirectoryMode(rootStat.mode), 0, "5");
  await visit(realRoot);
  push(Buffer.alloc(1024));
  return Buffer.concat(chunks, total);
}

function learnerWritableDirectoryMode(mode: number): number {
  return (mode & 0o777) | 0o700;
}

function learnerWritableFileMode(mode: number): number {
  return (mode & 0o777) | 0o600;
}

function tarHeader(name: string, mode: number, uid: number, gid: number, size: number, typeflag: "0" | "2" | "5", linkname = ""): Buffer {
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(linkname) > 100) throw new Error("Archive entry path exceeds the authored preflight limit.");
  const header = Buffer.alloc(512, 0);
  const writeString = (value: string, offset: number, length: number) => header.write(value.slice(0, length), offset, length, "utf8");
  const writeOctal = (value: number, offset: number, length: number) => {
    const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
    header.write(text, offset, length - 1, "ascii");
    header[offset + length - 1] = 0;
  };
  writeString(name, 0, 100);
  writeOctal(mode & 0o777, 100, 8);
  writeOctal(uid, 108, 8);
  writeOctal(gid, 116, 8);
  writeOctal(size, 124, 12);
  writeOctal(0, 136, 12);
  header.fill(0x20, 148, 156);
  writeString(typeflag, 156, 1);
  writeString(linkname, 157, 100);
  writeString("ustar", 257, 6);
  writeString("00", 263, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function execFileText(file: string, args: readonly string[], environment: AuthoredWorkbookEvalEnvironment, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  try {
    const result = await runBoundedProcess(file, [...args], { stdio: "ignore", env: hostCommandEnvironment(environment), timeout: timeoutMs, signal }, { stdoutMaxBytes: 1024 * 1024 });
    return result.stdout;
  } catch {
    throw new Error("external command failed");
  }
}

async function runBoundedProcess(file: string, args: string[], options: DockerCommandSyncOptions, capture: { stdoutMaxBytes?: number } = {}): Promise<{ stdout: string }> {
  const timeoutMs = options.timeout;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid process timeout.");
  const stdin = options.privateStdin;
  if (stdin !== undefined && Buffer.byteLength(stdin) > Math.max(DOCKER_PRIVATE_STDIN_MAX_BYTES, DOCKER_PRIVATE_ARCHIVE_MAX_BYTES)) throw new Error("Private stdin exceeds the authored preflight limit.");
  return await new Promise((resolvePromise, reject) => {
    let child!: ChildProcess;
    try {
      const spawnOptions: SpawnOptions = { env: options.env, stdio: [stdin === undefined ? "ignore" : "pipe", capture.stdoutMaxBytes ? "pipe" : "ignore", "ignore"], detached: true };
      child = spawn(file, args, spawnOptions);
    } catch {
      reject(new Error("external command failed"));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let exited = false;
    let cancelling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupAbort = () => undefined as void;
    const killChild = (signal: NodeJS.Signals): void => {
      if (child.pid && child.pid > 0) {
        try { process.kill(-child.pid, signal); } catch { /* ignore process-group kill races */ }
      }
      try { child.kill(signal); } catch { /* ignore kill races */ }
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      cleanupAbort();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stdin?.removeAllListeners();
      child.removeAllListeners("error");
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolvePromise({ stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8") });
    };
    const cancel = (message: string): void => {
      if (settled) return;
      cancelling = true;
      try { child.stdin?.end(); } catch { try { child.stdin?.destroy(); } catch { /* ignore */ } }
      killChild("SIGTERM");
      if (!exited) {
        killTimer = setTimeout(() => {
          if (exited) return;
          killTimer = undefined;
          killChild("SIGKILL");
        }, 500);
        killTimer.unref?.();
      }
      settle(new Error(message));
    };
    if (options.signal) {
      if (options.signal.aborted) { cancel("external command aborted"); return; }
      const abortListener = () => cancel("external command aborted");
      options.signal.addEventListener("abort", abortListener, { once: true });
      cleanupAbort = () => options.signal?.removeEventListener("abort", abortListener);
    }
    timer = setTimeout(() => cancel("external command timed out"), timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (capture.stdoutMaxBytes && stdoutBytes > capture.stdoutMaxBytes) {
        stdoutChunks.length = 0;
        cancel("external command output exceeded limit");
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stdout?.once("error", () => { if (!cancelling) settle(new Error("external command failed")); });
    child.stderr?.once("error", () => { if (!cancelling) settle(new Error("external command failed")); });
    child.once("error", () => { if (!cancelling) settle(new Error("external command failed")); });
    child.once("close", (code: number | null) => {
      exited = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (cancelling) return;
      settle(code === 0 ? undefined : new Error("external command failed"));
    });
    child.stdin?.once("error", () => { if (!cancelling) settle(new Error("external command failed")); });
    if (stdin !== undefined) {
      try { child.stdin?.end(stdin); }
      catch { settle(new Error("external command failed")); }
    }
  });
}

function hostCommandEnvironment(environment: AuthoredWorkbookEvalEnvironment): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "NO_COLOR"] as const) if (environment[name] !== undefined) out[name] = environment[name];
  return out;
}

async function sanitizeStage<T>(phase: AuthoredWorkbookEvalPreflightPhase, code: string, operation: () => Promise<T>, role?: AuthoredWorkbookEvalRoleLabel, model?: PublicModelIdentity): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof AuthoredWorkbookEvalPreflightError) throw error;
    throw new AuthoredWorkbookEvalPreflightError(phase, { code, role, model });
  }
}

async function createFixtureWithAbortableLease(
  request: AuthoredWorkbookEvalPreflightRequest,
  operations: AuthoredWorkbookEvalExternalOperations,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<AuthoredWorkbookEvalDisposableFixture> {
  const leases: AuthoredWorkbookEvalPartialFixtureLease[] = [];
  let completed = false;
  const fixture = await withAbortableTimeout((signal) => {
    const operation = operations.createDisposablePreflightFixture({
      request,
      timeoutMs,
      signal,
      registerPartialFixtureLease: (lease) => { leases.push(lease); }
    });
    operation.then(
      async (lateFixture) => {
        if (!completed && signal.aborted) await cleanupDetachedFixture(lateFixture).catch(() => undefined);
      },
      async () => {
        if (!completed && signal.aborted) await cleanupPartialFixtureLeases(leases).catch(() => undefined);
      }
    );
    return operation;
  }, timeoutMs, async () => cleanupPartialFixtureLeases(leases), externalSignal);
  completed = true;
  return fixture;
}

async function cleanupDetachedFixture(fixture: AuthoredWorkbookEvalDisposableFixture): Promise<void> {
  const error = await cleanupFixtureRoot(fixture.root, fixture.commandStubs);
  if (error) throw error;
}

async function cleanupPartialFixtureLeases(leases: readonly AuthoredWorkbookEvalPartialFixtureLease[]): Promise<void> {
  let cleanupError: unknown;
  for (const lease of [...leases].reverse()) {
    try { await lease.close(); }
    catch (error) { cleanupError ??= error; }
  }
  if (cleanupError) throw cleanupError;
}

async function withAbortableTimeout<T>(
  operationFactory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onAbort?: () => Promise<void>,
  externalSignal?: AbortSignal
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw validationError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let externallyAborted = false;
  let cleanupExternal = () => undefined as void;
  const abortController = (reason?: unknown) => { if (!controller.signal.aborted) controller.abort(reason); };
  if (externalSignal) {
    if (externalSignal.aborted) {
      externallyAborted = true;
      abortController(externalSignal.reason);
    } else {
      const listener = () => {
        externallyAborted = true;
        abortController(externalSignal.reason);
      };
      externalSignal.addEventListener("abort", listener, { once: true });
      cleanupExternal = () => externalSignal.removeEventListener("abort", listener);
    }
  }
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortController(new Error("bounded operation timed out"));
      reject(new Error("bounded operation timed out"));
    }, timeoutMs);
    timer.unref?.();
  });
  const abort = new Promise<T>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(new Error("bounded operation aborted"));
      return;
    }
    const listener = () => {
      controller.signal.removeEventListener("abort", listener);
      reject(new Error("bounded operation aborted"));
    };
    controller.signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operationFactory(controller.signal), timeout, abort]);
  } catch (error) {
    if (timedOut || externallyAborted) {
      try { await onAbort?.(); }
      catch { throw new AuthoredWorkbookEvalPreflightError("cleanup", { code: "preflight_cleanup_failed" }); }
    }
    throw error;
  } finally {
    cleanupExternal();
    if (timer) clearTimeout(timer);
  }
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

function throwPreflightIfAborted(signal: AbortSignal | undefined, phase: AuthoredWorkbookEvalPreflightPhase): void {
  if (signal?.aborted) throw new AuthoredWorkbookEvalPreflightError(phase, { code: "authored_workbook_eval_preflight_aborted" });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("operation aborted");
}

export function snapshotAuthoredWorkbookEvalEnvironment(environment: NodeJS.ProcessEnv, modelOverrides: Partial<Record<AuthoredWorkbookEvalRoleKey, string>> = {}): AuthoredWorkbookEvalEnvironment {
  const keys = new Set<string>([
    "PATH", "HOME", "NO_COLOR",
    "DOCKER_API_VERSION", "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_DEFAULT_PLATFORM", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
    OPENCODE_API_KEY_ENV, TUTOR_MODEL_ENV, EVAL_JUDGE_MODEL_ENV, EVAL_JUDGE_COMMAND_ENV
  ]);
  const snapshot: Record<string, string> = {};
  for (const key of keys) {
    const value = environment[key];
    if (typeof value === "string") snapshot[key] = value;
  }
  if (modelOverrides.mainTutor !== undefined) snapshot[TUTOR_MODEL_ENV] = modelOverrides.mainTutor;
  if (modelOverrides.judge !== undefined) snapshot[EVAL_JUDGE_MODEL_ENV] = modelOverrides.judge;
  return deepFreezePlain(snapshot);
}


function assertRequiredEnvironment(environment: AuthoredWorkbookEvalEnvironment): void {
  if (!hasNonEmptyEnvValue(environment, OPENCODE_API_KEY_ENV)) throw new AuthoredWorkbookEvalPreflightError("arguments", { code: "missing_opencode_api_key" });
  if (!hasNonEmptyEnvValue(environment, EVAL_JUDGE_COMMAND_ENV)) throw new AuthoredWorkbookEvalPreflightError("arguments", { code: "missing_eval_judge_command" });
}


function resolveScenarioIdsForParser(scenarioIds: readonly string[], catalogForTest: AuthoredWorkbookEvalScenarioCatalogForTest | undefined): string[] {
  const catalog = catalogForTest ?? AUTHORED_WORKBOOK_SCENARIOS;
  const resolved = resolveScenariosFromCatalog(scenarioIds, catalog);
  return resolved.map((scenario) => scenario.id);
}

type AuthoredWorkbookEvalScenarioCatalogEntry = AuthoredWorkbookEvalScenario | AuthoredWorkbookScenarioDescriptor;

function resolveScenariosFromCatalog(
  scenarioIds: readonly (AuthoredWorkbookScenarioId | string)[] | undefined,
  catalog: readonly AuthoredWorkbookEvalScenarioCatalogEntry[]
): AuthoredWorkbookEvalPreflightRequest["scenarios"] {
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0 || !Array.isArray(catalog) || catalog.length === 0) throw validationError();
  const wanted = validateScenarioIdList(scenarioIds);
  const catalogScenarios = sanitizeScenarioCatalog(catalog);
  const byId = new Map(catalogScenarios.map((scenario) => [scenario.id, scenario]));
  return wanted.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) throw validationError();
    return Object.freeze({
      id: scenario.id,
      expectedModelCalls: deepFreezePlain({ ...scenario.expectedModelCalls }),
      expectedBudgetFlags: sanitizeBooleanFlags(scenario.expectedBudgetFlags),
      expectedCapabilityFlags: sanitizeBooleanFlags(scenario.expectedCapabilityFlags)
    });
  });
}

function validateScenarioIdList(rawIds: readonly (AuthoredWorkbookScenarioId | string)[]): string[] {
  const seen = new Set<string>();
  return rawIds.map((id) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw validationError();
    if (seen.has(id)) throw validationError();
    seen.add(id);
    return id;
  });
}

function sanitizeScenarioCatalog(raw: readonly AuthoredWorkbookEvalScenarioCatalogEntry[]): AuthoredWorkbookEvalPreflightRequest["scenarios"] {
  const seen = new Set<string>();
  return raw.map((scenario) => {
    if (!scenario || typeof scenario !== "object") throw validationError();
    const { id } = scenario;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw validationError();
    if (seen.has(id)) throw validationError();
    seen.add(id);
    const expectedModelCalls = normalizeExpectedModelCalls(scenario.expectedModelCalls);
    const maybeFlags = scenario as AuthoredWorkbookEvalScenario;
    return Object.freeze({
      id,
      expectedModelCalls: deepFreezePlain({
        mainTutor: expectedModelCalls.byKey.mainTutor,
        judge: expectedModelCalls.byKey.judge,
        total: expectedModelCalls.total
      }),
      expectedBudgetFlags: sanitizeBooleanFlags(maybeFlags.expectedBudgetFlags),
      expectedCapabilityFlags: sanitizeBooleanFlags(maybeFlags.expectedCapabilityFlags)
    });
  });
}

function validateModels(raw: Partial<Record<AuthoredWorkbookEvalRoleKey, string>> | undefined, environment: AuthoredWorkbookEvalEnvironment): Readonly<AuthoredWorkbookEvalModels> {
  const models = {} as AuthoredWorkbookEvalModels;
  for (const role of WORKBOOK_EVAL_ROLES) {
    const identity = raw?.[role.key] ?? environment[role.env];
    if (typeof identity !== "string" || !identity.trim()) throw validationError();
    models[role.key] = parseModelIdentity(identity);
  }
  return deepFreezePlain(models);
}

function parseModelIdentity(value: string): AuthoredWorkbookEvalRoleModel {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) throw validationError();
  const provider = trimmed.slice(0, slash);
  const id = trimmed.slice(slash + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) throw validationError();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/.test(id)) throw validationError();
  return Object.freeze({ provider, id, identity: `${provider}/${id}` });
}

function modelIdentityFromEnvironment(request: AuthoredWorkbookEvalPreflightRequest): WorkbookModelIdentity {
  return { provider: request.models.mainTutor.provider, id: request.models.mainTutor.id };
}

function validatePublicModelIdentity(model: PublicModelIdentity | undefined): PublicModelIdentity {
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model.provider)) throw new Error("selected model identity was not public");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/.test(model.id)) throw new Error("selected model identity was not public");
  return { provider: model.provider, id: model.id };
}

function validateCostBudget(raw: AuthoredWorkbookEvalCostBudgetInput | undefined): AuthoredWorkbookEvalCostBudget {
  if (!raw || typeof raw !== "object") throw new AuthoredWorkbookEvalPreflightError("budget", { code: "missing_cost_budget" });
  const estimatedTokensPerPaidCall = raw.estimatedTokensPerPaidCall ?? AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL;
  if (!isPositiveInteger(raw.maxPaidModelCalls) || !isPositiveInteger(raw.maxEstimatedTokens) || !isPositiveInteger(estimatedTokensPerPaidCall) || estimatedTokensPerPaidCall < AUTHORED_PREFLIGHT_MIN_TOKENS_PER_PAID_CALL) throw new AuthoredWorkbookEvalPreflightError("budget", { code: "invalid_cost_budget" });
  return deepFreezePlain({ maxPaidModelCalls: raw.maxPaidModelCalls, maxEstimatedTokens: raw.maxEstimatedTokens, estimatedTokensPerPaidCall });
}

function expectedCostsFor(scenarios: AuthoredWorkbookEvalPreflightRequest["scenarios"], budget: AuthoredWorkbookEvalCostBudget, repeat: number): AuthoredWorkbookEvalExpectedCosts {
  const paidPreflightCallsByRole = emptyRoleCounts();
  const paidReleaseCallsByRole = emptyRoleCounts();
  for (const role of WORKBOOK_EVAL_ROLES) paidPreflightCallsByRole[role.label] = 1;
  let expectedPaidReleaseCalls = 0;
  for (const scenario of scenarios) {
    const counts = normalizeExpectedModelCalls(scenario.expectedModelCalls);
    expectedPaidReleaseCalls += counts.total * repeat;
    for (const role of WORKBOOK_EVAL_ROLES) paidReleaseCallsByRole[role.label] += counts.byRole[role.label] * repeat;
  }
  const expectedPaidPreflightCalls = 2 as const;
  const expectedPaidModelCallsTotal = expectedPaidPreflightCalls + expectedPaidReleaseCalls;
  return deepFreezePlain({
    paidPreflightCallsByRole,
    paidReleaseCallsByRole,
    expectedPaidPreflightCalls,
    expectedPaidReleaseCalls,
    expectedPaidModelCallsTotal,
    estimatedTokensPerPaidCall: budget.estimatedTokensPerPaidCall,
    expectedEstimatedTokensTotal: expectedPaidModelCallsTotal * budget.estimatedTokensPerPaidCall,
    releaseScenarioCount: scenarios.length,
    releaseRunCount: scenarios.length * repeat
  });
}

function normalizeExpectedModelCalls(raw: AuthoredWorkbookEvalScenario["expectedModelCalls"]): { byKey: Record<AuthoredWorkbookEvalRoleKey, number>; byRole: Record<AuthoredWorkbookEvalRoleLabel, number>; total: number } {
  if (!isPlainObject(raw)) throw validationError();
  const allowedKeys = new Set<string>(["mainTutor", "judge", "total"]);
  for (const key of Object.keys(raw)) if (!allowedKeys.has(key)) throw validationError();
  const byRole = emptyRoleCounts();
  const byKey: Record<AuthoredWorkbookEvalRoleKey, number> = { mainTutor: 0, judge: 0 };
  let roleSum = 0;
  for (const role of WORKBOOK_EVAL_ROLES) {
    const rawCount = raw[role.key];
    if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 0) throw validationError();
    if (role.key === "judge" && rawCount !== 1) throw validationError();
    byKey[role.key] = rawCount;
    byRole[role.label] = rawCount;
    roleSum += rawCount;
  }
  if (typeof raw.total !== "number" || !Number.isInteger(raw.total) || raw.total <= 0 || raw.total !== roleSum) throw validationError();
  return { byKey, byRole, total: raw.total };
}

function validateHostPath(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw validationError();
  const path = resolve(value);
  if (!isAbsolute(path)) throw validationError();
  return path;
}

function insideRoot(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

function validationError(): AuthoredWorkbookEvalPreflightError {
  return new AuthoredWorkbookEvalPreflightError("arguments", { code: "invalid_preflight_arguments" });
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) throw validationError();
  const parsed = Number(value);
  if (!isPositiveInteger(parsed)) throw validationError();
  return parsed;
}

function parseRepeat(value: string): number {
  if (!/^\d+$/.test(value)) throw validationError();
  return validateRepeat(Number(value));
}

function validateRepeat(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) throw validationError();
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function emptyCallCounts(): AuthoredWorkbookEvalCallCounts {
  return {
    npmVersionChecks: 0,
    dockerReadyChecks: 0,
    disposableFixturesCreated: 0,
    terminalContainerStarts: 0,
    terminalReadinessChecks: 0,
    terminalAuthChecks: 0,
    terminalCleanupChecks: 0,
    paidPreflightCallsByRole: emptyRoleCounts()
  };
}

function cloneCallCounts(counts: AuthoredWorkbookEvalCallCounts): AuthoredWorkbookEvalCallCounts {
  return { ...counts, paidPreflightCallsByRole: { ...counts.paidPreflightCallsByRole } };
}

function emptyRoleCounts(): Record<AuthoredWorkbookEvalRoleLabel, number> {
  return { "Main Tutor": 0, Judge: 0 };
}

function mergeScenarioFlags(scenarios: AuthoredWorkbookEvalPreflightRequest["scenarios"], key: "expectedBudgetFlags" | "expectedCapabilityFlags"): Record<string, boolean> {
  const merged: Record<string, boolean> = {};
  for (const scenario of scenarios) for (const [flag, value] of Object.entries(scenario[key])) merged[flag] = Boolean(merged[flag] || value);
  return merged;
}

function sanitizeBooleanFlags(raw: Record<string, boolean> | undefined): Record<string, boolean> {
  if (raw === undefined) return Object.freeze({});
  if (!isPlainObject(raw)) throw validationError();
  const clean: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(key) || typeof value !== "boolean") throw validationError();
    clean[key] = value;
  }
  return Object.freeze(clean);
}

function isPlainObject(value: unknown): value is Record<string, number> & { total?: number } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}


function hasNonEmptyEnvValue(environment: AuthoredWorkbookEvalEnvironment, name: string): boolean {
  return typeof environment[name] === "string" && Boolean(environment[name]?.trim());
}

function noopLogger() {
  return { info: (_message: string) => undefined, error: (_message: string) => undefined };
}

export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return range.split(/\s+/).filter(Boolean).every((constraint) => {
    const match = /^(>=|>|<=|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(constraint);
    if (!match) return false;
    const wanted = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)] as const;
    const cmp = compareVersion(parsed, wanted);
    switch (match[1] ?? "=") {
      case ">=": return cmp >= 0;
      case ">": return cmp > 0;
      case "<=": return cmp <= 0;
      case "<": return cmp < 0;
      case "=": return cmp === 0;
      default: return false;
    }
  });
}

function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersion(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    const leftPart = left[index]!;
    const rightPart = right[index]!;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function deepFreezePlain<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezePlain(child);
  return value;
}
