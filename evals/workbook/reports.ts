import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AUTHORED_WORKBOOK_EVAL_MARKERS, type AuthoredWorkbookEvalMarkers } from "./types.js";
import { copyAuthoredWorkbookEvalJudgePublicState, copyAuthoredWorkbookEvalTrace, enumerateAuthoredWorkbookEvalJudgeCitations, projectAuthoredWorkbookEvalTraceForJudge, type AuthoredWorkbookEvalJudgeTrace, type AuthoredWorkbookEvalTrace } from "./public-trace.js";
import {
  authoredWorkbookJudgeVerdict,
  buildAuthoredWorkbookJudgePrompt,
  buildAuthoredWorkbookJudgePromptFromProjectedTrace,
  copyAuthoredWorkbookEvalScenarioPublicDescriptor,
  projectAuthoredWorkbookGateForPublicReport,
  verifyAuthoredWorkbookJudgeResult,
  type AuthoredWorkbookEvalGateResult,
  type AuthoredWorkbookEvalJudgeCriterionScore,
  type AuthoredWorkbookEvalJudgeResult,
  type AuthoredWorkbookEvalPublicGateResult,
  type AuthoredWorkbookEvalScenarioPublicDescriptor,
  type AuthoredWorkbookEvalVerdict
} from "./judge.js";
import { AUTHORED_WORKBOOK_DETERMINISTIC_ONLY_REPORT_POLICY, authoredWorkbookScenarioPublicDescriptorById } from "./scenarios.js";

const MAX_CURATED_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_TEXT_BYTES = 4 * 1024 * 1024;
const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MODEL_IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+ -]{0,127}$/;
const SCENARIO_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const REPORT_FS_WRITE_ERROR_MESSAGE = "Unable to write authored workbook report artifacts.";
const REPORT_FS_LATEST_ERROR_MESSAGE = "Unable to update authored workbook latest report.";
const REPORT_FS_DIRECTORY_ERROR_MESSAGE = "Unable to prepare authored workbook report directory.";
const AUTHORED_WORKBOOK_RUN_STATUSES = ["setup", "session", "gate", "judge", "report", "cleanup", "interrupted", "completed"] as const;

export const AUTHORED_WORKBOOK_REPORT_FILENAMES = deepFreeze({
  trace: "trace.json",
  judgeInput: "judge-input.json",
  judge: "judge.json",
  report: "report.json",
  summary: "summary.md",
  metadata: "metadata.json"
} as const);

export const AUTHORED_WORKBOOK_DETERMINISTIC_REPORT_FILENAMES = deepFreeze({
  trace: AUTHORED_WORKBOOK_REPORT_FILENAMES.trace,
  report: AUTHORED_WORKBOOK_REPORT_FILENAMES.report,
  summary: AUTHORED_WORKBOOK_REPORT_FILENAMES.summary,
  metadata: AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata
} as const);

export const AUTHORED_WORKBOOK_LATEST_FILENAME = "latest.json" as const;
export const AUTHORED_WORKBOOK_DETERMINISTIC_ONLY_SUCCESS_ASSERTION_COUNT = AUTHORED_WORKBOOK_DETERMINISTIC_ONLY_REPORT_POLICY.requiredAssertionCount;

export const AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES = deepFreeze({
  gate: "gate.json",
  failure: "failure.txt",
  cleanupFailure: "cleanup-failure.txt"
} as const);

export type AuthoredWorkbookEvalRunLifecycleStatus =
  | "setup"
  | "session"
  | "gate"
  | "judge"
  | "report"
  | "cleanup"
  | "interrupted"
  | "completed";

export type AuthoredWorkbookEvalRunOutcome = "passed" | "failed" | "interrupted";
export type AuthoredWorkbookEvalInvocationScope = "scenario" | "all" | "release";
export type AuthoredWorkbookEvalDiagnosticWriteStatus = "written" | "write-failed";
export type AuthoredWorkbookEvalEvaluationMode = "judged" | "deterministic-only";

export interface AuthoredWorkbookEvalModelIdentity {
  requested: string;
  selected: string;
}

export interface AuthoredWorkbookEvalJudgedModelIdentities {
  "Main Tutor": AuthoredWorkbookEvalModelIdentity;
  Judge: AuthoredWorkbookEvalModelIdentity;
}

export interface AuthoredWorkbookEvalDeterministicOnlyModelIdentities {
  "Main Tutor": AuthoredWorkbookEvalModelIdentity;
  Judge?: never;
}

export type AuthoredWorkbookEvalModelIdentities = AuthoredWorkbookEvalJudgedModelIdentities | AuthoredWorkbookEvalDeterministicOnlyModelIdentities;

export interface AuthoredWorkbookTraceEnvelope extends AuthoredWorkbookEvalMarkers {
  trace: AuthoredWorkbookEvalJudgeTrace;
}

export interface AuthoredWorkbookJudgeInputEnvelope extends AuthoredWorkbookEvalMarkers {
  scenario: string;
  traceFile: typeof AUTHORED_WORKBOOK_REPORT_FILENAMES.trace;
  prompt: string;
}

export interface AuthoredWorkbookJudgeEnvelope extends AuthoredWorkbookEvalMarkers {
  judge: AuthoredWorkbookEvalJudgeResult;
  verdict: AuthoredWorkbookEvalVerdict;
}

export type AuthoredWorkbookEvalJudgeRunSummary =
  | { policy: "scenario-specific"; expectedCalls: 1; status: "completed" }
  | { policy: "deterministic-only"; expectedCalls: 0; status: "not-run" };

interface AuthoredWorkbookBaseReportEnvelope extends AuthoredWorkbookEvalMarkers {
  runId: string;
  scenario: AuthoredWorkbookEvalScenarioPublicDescriptor;
  gate: AuthoredWorkbookEvalPublicGateResult;
}

export interface AuthoredWorkbookJudgedReportEnvelope extends AuthoredWorkbookBaseReportEnvelope {
  evaluationMode: "judged";
  modelIdentities: AuthoredWorkbookEvalJudgedModelIdentities;
  judge: Extract<AuthoredWorkbookEvalJudgeRunSummary, { policy: "scenario-specific" }>;
  verdict: AuthoredWorkbookJudgedLifecycleVerdict;
  files: AuthoredWorkbookJudgedSuccessFiles;
}

export interface AuthoredWorkbookDeterministicOnlyReportEnvelope extends AuthoredWorkbookBaseReportEnvelope {
  evaluationMode: "deterministic-only";
  modelIdentities: AuthoredWorkbookEvalDeterministicOnlyModelIdentities;
  judge: Extract<AuthoredWorkbookEvalJudgeRunSummary, { policy: "deterministic-only" }>;
  verdict: AuthoredWorkbookDeterministicOnlySuccessVerdict;
  files: AuthoredWorkbookDeterministicSuccessFiles;
}

export type AuthoredWorkbookReportEnvelope = AuthoredWorkbookJudgedReportEnvelope | AuthoredWorkbookDeterministicOnlyReportEnvelope;

export interface AuthoredWorkbookEvalLifecycle {
  setup: "not-started" | "completed" | "failed";
  session: "not-started" | "completed" | "failed" | "interrupted";
  gate: "not-run" | "passed" | "failed";
  judge: "not-run" | "input-written" | "completed" | "failed" | "not-applicable";
  report: "not-written" | "written" | "failed";
  cleanup: "not-started" | "completed" | "failed";
  interrupted: "no" | "yes";
  completed: "no" | "yes";
}

export interface AuthoredWorkbookEvalFailureSummary {
  stage: Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">;
  message: string;
  diagnosticPolicy: "local-diagnostics-are-not-curated-or-advertised";
}

export type AuthoredWorkbookJudgedSuccessFiles = typeof AUTHORED_WORKBOOK_REPORT_FILENAMES;
export type AuthoredWorkbookDeterministicSuccessFiles = typeof AUTHORED_WORKBOOK_DETERMINISTIC_REPORT_FILENAMES;
export type AuthoredWorkbookMetadataOnlyFiles = Pick<typeof AUTHORED_WORKBOOK_REPORT_FILENAMES, "metadata">;
export type AuthoredWorkbookSuccessCuratedFiles = AuthoredWorkbookJudgedSuccessFiles | AuthoredWorkbookDeterministicSuccessFiles;
export type AuthoredWorkbookCuratedFiles = AuthoredWorkbookSuccessCuratedFiles | AuthoredWorkbookMetadataOnlyFiles;

export interface AuthoredWorkbookJudgedLifecycleVerdict {
  passed: boolean;
  percentage: number;
  rule: AuthoredWorkbookEvalVerdict["rule"];
}

export interface AuthoredWorkbookDeterministicOnlySuccessVerdict {
  passed: true;
  rule: "deterministic-gate-only";
  percentage?: never;
}

export interface AuthoredWorkbookNotJudgedVerdict {
  passed: false;
  percentage: 0;
  rule: "not-judged";
}

export type AuthoredWorkbookEvalLifecycleVerdict = AuthoredWorkbookJudgedLifecycleVerdict | AuthoredWorkbookDeterministicOnlySuccessVerdict | AuthoredWorkbookNotJudgedVerdict;
export type AuthoredWorkbookEvalFailureStatus = Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">;
export type AuthoredWorkbookEvalDeterministicFailureStatus = Exclude<AuthoredWorkbookEvalFailureStatus, "judge">;

interface AuthoredWorkbookBaseMetadataEnvelope extends AuthoredWorkbookEvalMarkers {
  runId: string;
  scenario: string;
  repetition: number;
  outcome: AuthoredWorkbookEvalRunOutcome;
  lifecycle: AuthoredWorkbookEvalLifecycle;
}

export interface AuthoredWorkbookJudgedSuccessMetadataEnvelope extends AuthoredWorkbookBaseMetadataEnvelope {
  status: "completed";
  outcome: "passed" | "failed";
  evaluationMode: "judged";
  verdict: AuthoredWorkbookJudgedLifecycleVerdict;
  modelIdentities: AuthoredWorkbookEvalJudgedModelIdentities;
  files: AuthoredWorkbookJudgedSuccessFiles;
  failure?: never;
}

export interface AuthoredWorkbookDeterministicOnlySuccessMetadataEnvelope extends AuthoredWorkbookBaseMetadataEnvelope {
  status: "completed";
  outcome: "passed";
  evaluationMode: "deterministic-only";
  verdict: AuthoredWorkbookDeterministicOnlySuccessVerdict;
  modelIdentities: AuthoredWorkbookEvalDeterministicOnlyModelIdentities;
  files: AuthoredWorkbookDeterministicSuccessFiles;
  failure?: never;
}

export interface AuthoredWorkbookJudgedFailureMetadataEnvelope extends AuthoredWorkbookBaseMetadataEnvelope {
  status: AuthoredWorkbookEvalFailureStatus;
  outcome: "failed" | "interrupted";
  evaluationMode: "judged";
  verdict: AuthoredWorkbookNotJudgedVerdict;
  modelIdentities: AuthoredWorkbookEvalJudgedModelIdentities;
  files: AuthoredWorkbookMetadataOnlyFiles;
  failure: AuthoredWorkbookEvalFailureSummary;
}

export interface AuthoredWorkbookDeterministicOnlyFailureMetadataEnvelope extends AuthoredWorkbookBaseMetadataEnvelope {
  status: AuthoredWorkbookEvalDeterministicFailureStatus;
  outcome: "failed" | "interrupted";
  evaluationMode: "deterministic-only";
  verdict: AuthoredWorkbookNotJudgedVerdict;
  modelIdentities: AuthoredWorkbookEvalDeterministicOnlyModelIdentities;
  files: AuthoredWorkbookMetadataOnlyFiles;
  failure: AuthoredWorkbookEvalFailureSummary;
}

export type AuthoredWorkbookMetadataEnvelope =
  | AuthoredWorkbookJudgedSuccessMetadataEnvelope
  | AuthoredWorkbookDeterministicOnlySuccessMetadataEnvelope
  | AuthoredWorkbookJudgedFailureMetadataEnvelope
  | AuthoredWorkbookDeterministicOnlyFailureMetadataEnvelope;

export interface AuthoredWorkbookReportBundleObjects {
  traceEnvelope: AuthoredWorkbookTraceEnvelope;
  judgeInputEnvelope?: AuthoredWorkbookJudgeInputEnvelope;
  judgeInput?: string;
  judgeEnvelope?: AuthoredWorkbookJudgeEnvelope;
  report: AuthoredWorkbookReportEnvelope;
  summary: string;
  metadata: AuthoredWorkbookMetadataEnvelope;
}

interface CreateAuthoredWorkbookBaseReportOptions {
  runId: string;
  scenario: AuthoredWorkbookEvalScenarioPublicDescriptor;
  trace: AuthoredWorkbookEvalTrace;
  gate: AuthoredWorkbookEvalGateResult;
  modelIdentities: AuthoredWorkbookEvalModelIdentities | Record<string, unknown>;
  repetition?: number;
}

export interface CreateAuthoredWorkbookJudgedReportOptions extends CreateAuthoredWorkbookBaseReportOptions {
  evaluationMode?: "judged";
  judgeInput: string;
  judge: AuthoredWorkbookEvalJudgeResult;
}

export interface CreateAuthoredWorkbookDeterministicReportOptions extends CreateAuthoredWorkbookBaseReportOptions {
  evaluationMode: "deterministic-only";
  judgeInput?: never;
  judge?: never;
}

export type CreateAuthoredWorkbookReportOptions = CreateAuthoredWorkbookJudgedReportOptions | CreateAuthoredWorkbookDeterministicReportOptions;

export type WriteAuthoredWorkbookReportBundleOptions = CreateAuthoredWorkbookReportOptions & {
  reportsRoot: string;
  writeText?: (path: string, data: string) => Promise<void>;
};

export interface CreateAuthoredWorkbookFailureMetadataOptions {
  runId: string;
  scenarioId: string;
  repetition?: number;
  status: Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">;
  evaluationMode?: AuthoredWorkbookEvalEvaluationMode;
  modelIdentities: AuthoredWorkbookEvalModelIdentities | Record<string, unknown>;
}

export interface WriteAuthoredWorkbookFailureMetadataOptions extends CreateAuthoredWorkbookFailureMetadataOptions {
  reportsRoot: string;
  writeText?: (path: string, data: string) => Promise<void>;
}

interface AuthoredWorkbookBaseLatestRunEntry extends AuthoredWorkbookEvalMarkers {
  scenario: string;
  repetition: number;
  reportDirectory: string;
}

export interface AuthoredWorkbookJudgedSuccessLatestRunEntry extends AuthoredWorkbookBaseLatestRunEntry {
  status: "completed";
  evaluationMode: "judged";
  verdict: AuthoredWorkbookJudgedLifecycleVerdict;
  files: AuthoredWorkbookJudgedSuccessFiles;
}

export interface AuthoredWorkbookDeterministicOnlySuccessLatestRunEntry extends AuthoredWorkbookBaseLatestRunEntry {
  status: "completed";
  evaluationMode: "deterministic-only";
  verdict: AuthoredWorkbookDeterministicOnlySuccessVerdict;
  files: AuthoredWorkbookDeterministicSuccessFiles;
}

export interface AuthoredWorkbookJudgedFailureLatestRunEntry extends AuthoredWorkbookBaseLatestRunEntry {
  status: AuthoredWorkbookEvalFailureStatus;
  evaluationMode: "judged";
  verdict: AuthoredWorkbookNotJudgedVerdict;
  files: AuthoredWorkbookMetadataOnlyFiles;
}

export interface AuthoredWorkbookDeterministicOnlyFailureLatestRunEntry extends AuthoredWorkbookBaseLatestRunEntry {
  status: AuthoredWorkbookEvalDeterministicFailureStatus;
  evaluationMode: "deterministic-only";
  verdict: AuthoredWorkbookNotJudgedVerdict;
  files: AuthoredWorkbookMetadataOnlyFiles;
}

export type AuthoredWorkbookEvalLatestRunEntry =
  | AuthoredWorkbookJudgedSuccessLatestRunEntry
  | AuthoredWorkbookDeterministicOnlySuccessLatestRunEntry
  | AuthoredWorkbookJudgedFailureLatestRunEntry
  | AuthoredWorkbookDeterministicOnlyFailureLatestRunEntry;

export interface AuthoredWorkbookEvalLatestEnvelope extends AuthoredWorkbookEvalMarkers {
  generatedAt: string;
  invocation: {
    scope: AuthoredWorkbookEvalInvocationScope;
    scenarioIds: string[];
    repeat: 1 | 2 | 3;
  };
  runs: AuthoredWorkbookEvalLatestRunEntry[];
}

export interface CreateAuthoredWorkbookEvalLatestEnvelopeOptions {
  generatedAt?: string;
  invocation: {
    scope: AuthoredWorkbookEvalInvocationScope;
    scenarioIds: readonly string[];
    repeat: 1 | 2 | 3;
  };
  runs: readonly AuthoredWorkbookEvalLatestRunEntry[];
}

export interface AuthoredWorkbookEvalLocalDiagnosticText {
  readonly __authoredWorkbookEvalLocalDiagnosticText: "local-diagnostic-only";
  readonly text: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return Object.freeze(value);
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds the authored workbook report length limit.`);
  return value;
}

function safeRunId(runId: unknown): string {
  const value = boundedString(runId, "authored workbook report run id", 128);
  if (!RUN_ID_PATTERN.test(value) || value.includes("..")) throw new Error("Invalid authored workbook report run id.");
  return value;
}

function safeScenarioId(scenarioId: unknown): string {
  const value = boundedString(scenarioId, "authored workbook scenario id", 128);
  if (!SCENARIO_ID_PATTERN.test(value) || value.includes("..")) throw new Error("Invalid authored workbook scenario id.");
  return value;
}

function boundedModelIdentity(value: unknown, label: string): string {
  const identity = boundedString(value, `${label} model identity`, 128);
  if (!MODEL_IDENTITY_PATTERN.test(identity)) throw new Error(`Invalid ${label} model identity.`);
  return identity;
}

function copyModelIdentityRole(value: Record<string, unknown>, canonical: "Main Tutor" | "Judge"): AuthoredWorkbookEvalModelIdentity {
  const raw = value[canonical];
  if (!isPlainRecord(raw)) throw new Error("Invalid authored workbook model identities.");
  assertExactKeys(raw, ["requested", "selected"], "authored workbook model identity");
  return {
    requested: boundedModelIdentity(raw.requested, `${canonical} requested`),
    selected: boundedModelIdentity(raw.selected, `${canonical} selected`)
  };
}

export function copyAuthoredWorkbookEvalModelIdentities(value: unknown): AuthoredWorkbookEvalModelIdentities {
  return copyModelIdentitiesForMode(value, "judged");
}

function copyModelIdentitiesForMode(value: unknown, mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookEvalModelIdentities {
  const checkedMode = validEvaluationMode(mode);
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook model identities.");
  const expectedRoles = checkedMode === "judged" ? ["Main Tutor", "Judge"] : ["Main Tutor"];
  assertExactKeys(value, expectedRoles, "authored workbook model identities");
  const mainTutor = copyModelIdentityRole(value, "Main Tutor");
  if (checkedMode === "deterministic-only") return deepFreeze({ "Main Tutor": mainTutor });
  return deepFreeze({ "Main Tutor": mainTutor, Judge: copyModelIdentityRole(value, "Judge") });
}

export function defaultAuthoredWorkbookEvalLifecycle(status: AuthoredWorkbookEvalRunLifecycleStatus, evaluationMode: AuthoredWorkbookEvalEvaluationMode = "judged"): AuthoredWorkbookEvalLifecycle {
  const checkedStatus = validRunStatus(status);
  const checkedMode = validEvaluationMode(evaluationMode);
  const lifecycle: AuthoredWorkbookEvalLifecycle = {
    setup: "not-started",
    session: "not-started",
    gate: "not-run",
    judge: "not-run",
    report: "not-written",
    cleanup: "not-started",
    interrupted: checkedStatus === "interrupted" ? "yes" : "no",
    completed: checkedStatus === "completed" ? "yes" : "no"
  };
  const completedJudgeState = checkedMode === "deterministic-only" ? "not-applicable" : "completed";
  switch (checkedStatus) {
    case "setup": lifecycle.setup = "failed"; break;
    case "session": lifecycle.setup = "completed"; lifecycle.session = "failed"; break;
    case "gate": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "failed"; break;
    case "judge": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = "failed"; break;
    case "report": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = completedJudgeState; lifecycle.report = "failed"; lifecycle.cleanup = "completed"; break;
    case "cleanup": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = completedJudgeState; lifecycle.report = "not-written"; lifecycle.cleanup = "failed"; break;
    case "interrupted": lifecycle.session = "interrupted"; break;
    case "completed": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = completedJudgeState; lifecycle.report = "written"; lifecycle.cleanup = "completed"; break;
  }
  return deepFreeze(lifecycle);
}

function jsonEnvelope(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function boundedTextForWrite(text: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} exceeds the authored workbook report write limit.`);
  return text;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowedSet.has(key))) throw new Error(`Invalid ${label}.`);
}

function publicFailureMessage(status: Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">): string {
  switch (status) {
    case "setup": return "Authored workbook eval failed during setup; local diagnostics may exist but are not curated or advertised.";
    case "session": return "Authored workbook eval failed while driving the scenario session; local diagnostics may exist but are not curated or advertised.";
    case "gate": return "Deterministic gate failed before judge invocation; local diagnostics may exist but are not curated or advertised.";
    case "judge": return "Authored workbook eval failed during judge invocation or judge verdict; local diagnostics may exist but are not curated or advertised.";
    case "report": return "Authored workbook eval failed while writing curated report artifacts; local diagnostics may exist but are not curated or advertised.";
    case "cleanup": return "Authored workbook eval failed during cleanup; local diagnostics may exist but are not curated or advertised.";
    case "interrupted": return "Authored workbook eval was interrupted; local diagnostics may exist but are not curated or advertised.";
  }
}

function verdictFromJudge(verdict: AuthoredWorkbookEvalVerdict): AuthoredWorkbookJudgedLifecycleVerdict {
  return deepFreeze({ passed: verdict.passed, percentage: verdict.percentage, rule: verdict.rule });
}

function notJudgedVerdict(): AuthoredWorkbookNotJudgedVerdict {
  return deepFreeze({ passed: false, percentage: 0, rule: "not-judged" as const });
}

function deterministicSuccessVerdict(): AuthoredWorkbookDeterministicOnlySuccessVerdict {
  return deepFreeze({ passed: true, rule: "deterministic-gate-only" as const });
}

function successFiles(mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookSuccessCuratedFiles {
  return deepFreeze(validEvaluationMode(mode) === "judged" ? { ...AUTHORED_WORKBOOK_REPORT_FILENAMES } : { ...AUTHORED_WORKBOOK_DETERMINISTIC_REPORT_FILENAMES });
}

function metadataOnlyFiles(): AuthoredWorkbookMetadataOnlyFiles {
  return deepFreeze({ metadata: AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata });
}

function curatedFilesForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus, mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookCuratedFiles {
  const checkedMode = validEvaluationMode(mode);
  return status === "completed" ? successFiles(checkedMode) : metadataOnlyFiles();
}

function copyExactCuratedFilesForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus, files: unknown, mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookCuratedFiles {
  if (!isPlainRecord(files)) throw new Error("Invalid authored workbook curated files.");
  const expected = curatedFilesForStatus(status, mode) as Record<string, string>;
  assertExactKeys(files, Object.keys(expected), "authored workbook curated files");
  for (const [key, value] of Object.entries(expected)) if (files[key] !== value) throw new Error("Invalid authored workbook curated files.");
  return deepFreeze({ ...expected } as AuthoredWorkbookCuratedFiles);
}

function copyStrictAuthoredWorkbookEvalModelIdentities(value: unknown, mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookEvalModelIdentities {
  return copyModelIdentitiesForMode(value, mode);
}

function copyExactLifecycleForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus, value: unknown, mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookEvalLifecycle {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook eval lifecycle.");
  const expected = defaultAuthoredWorkbookEvalLifecycle(status, mode) as unknown as Record<string, string>;
  assertExactKeys(value, Object.keys(expected), "authored workbook eval lifecycle");
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) throw new Error("Invalid authored workbook eval lifecycle.");
  return defaultAuthoredWorkbookEvalLifecycle(status, mode);
}

function copyExactFailureSummaryForStatus(status: Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">, value: unknown): AuthoredWorkbookEvalFailureSummary {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook failure summary.");
  assertExactKeys(value, ["stage", "message", "diagnosticPolicy"], "authored workbook failure summary");
  const message = publicFailureMessage(status);
  if (value.stage !== status || value.message !== message || value.diagnosticPolicy !== "local-diagnostics-are-not-curated-or-advertised") throw new Error("Invalid authored workbook failure summary.");
  return deepFreeze({ stage: status, message, diagnosticPolicy: "local-diagnostics-are-not-curated-or-advertised" });
}

function expectedOutcomeForStatusAndVerdict(status: AuthoredWorkbookEvalRunLifecycleStatus, verdict: AuthoredWorkbookEvalLifecycleVerdict): AuthoredWorkbookEvalRunOutcome {
  if (status === "completed") return verdict.passed ? "passed" : "failed";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function validEvaluationMode(value: unknown): AuthoredWorkbookEvalEvaluationMode {
  if (value !== "judged" && value !== "deterministic-only") throw new Error("Invalid authored workbook evaluation mode.");
  return value;
}

function assertScenarioAllowsEvaluationMode(scenarioId: string, mode: AuthoredWorkbookEvalEvaluationMode): void {
  const checkedMode = validEvaluationMode(mode);
  const deterministicScenarioId = AUTHORED_WORKBOOK_DETERMINISTIC_ONLY_REPORT_POLICY.scenarioId;
  if (checkedMode === "deterministic-only" && scenarioId !== deterministicScenarioId) throw new Error("Invalid deterministic-only scenario for authored workbook reports.");
  if (checkedMode === "judged" && scenarioId === deterministicScenarioId) throw new Error("Invalid judged scenario for deterministic-only authored workbook reports.");
}

function deterministicOnlyRequiredAssertionCount(): number {
  return AUTHORED_WORKBOOK_DETERMINISTIC_ONLY_REPORT_POLICY.requiredAssertionCount;
}

function copyStrictAuthoredWorkbookMetadataEnvelope(value: unknown): AuthoredWorkbookMetadataEnvelope {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook metadata.");
  if (value.namespace !== AUTHORED_WORKBOOK_EVAL_MARKERS.namespace || value.owner !== AUTHORED_WORKBOOK_EVAL_MARKERS.owner || value.suite !== AUTHORED_WORKBOOK_EVAL_MARKERS.suite || value.schemaVersion !== AUTHORED_WORKBOOK_EVAL_MARKERS.schemaVersion) throw new Error("Invalid authored workbook metadata markers.");
  const status = validRunStatus(value.status);
  const evaluationMode = validEvaluationMode(value.evaluationMode);
  if (evaluationMode === "deterministic-only" && status === "judge") throw new Error("Invalid authored workbook deterministic-only lifecycle status.");
  const expectedKeys = ["namespace", "owner", "suite", "schemaVersion", "runId", "scenario", "repetition", "status", "outcome", "evaluationMode", "verdict", "modelIdentities", "lifecycle", "files"];
  assertExactKeys(value, status === "completed" ? expectedKeys : [...expectedKeys, "failure"], "authored workbook metadata");
  const verdict = copyLifecycleVerdictForStatus(status, value.verdict, evaluationMode);
  const outcome = expectedOutcomeForStatusAndVerdict(status, verdict);
  if (value.outcome !== outcome) throw new Error("Invalid authored workbook metadata outcome.");
  const runId = safeRunId(value.runId);
  const scenario = safeScenarioId(value.scenario);
  assertScenarioAllowsEvaluationMode(scenario, evaluationMode);
  const envelope = {
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId,
    scenario,
    repetition: validRepetition(value.repetition as number),
    status,
    outcome,
    evaluationMode,
    verdict,
    modelIdentities: copyStrictAuthoredWorkbookEvalModelIdentities(value.modelIdentities, evaluationMode),
    lifecycle: copyExactLifecycleForStatus(status, value.lifecycle, evaluationMode),
    files: copyExactCuratedFilesForStatus(status, value.files, evaluationMode)
  } as AuthoredWorkbookMetadataEnvelope;
  if (status !== "completed") envelope.failure = copyExactFailureSummaryForStatus(status, value.failure);
  return deepFreeze(envelope);
}

export function createAuthoredWorkbookEvalReportBundleObjects(options: CreateAuthoredWorkbookReportOptions): AuthoredWorkbookReportBundleObjects {
  const runId = safeRunId(options.runId);
  const repetition = validRepetition(options.repetition ?? 1);
  const scenario = copyAuthoredWorkbookEvalScenarioPublicDescriptor(options.scenario);
  const trace = copyAuthoredWorkbookEvalTrace(options.trace);
  const judgeTrace = projectAuthoredWorkbookEvalTraceForJudge(trace);
  const publicGate = projectAuthoredWorkbookGateForPublicReport(options.gate);
  if (!publicGate.passed) throw new Error("Cannot create an authored workbook report when the deterministic gate failed.");
  if (publicGate.failureCount > 0) throw new Error("Cannot create an authored workbook report when the deterministic gate passed with failed assertions.");
  const mode = validEvaluationMode(options.evaluationMode ?? "judged");
  assertScenarioAllowsEvaluationMode(scenario.id, mode);
  const traceEnvelope: AuthoredWorkbookTraceEnvelope = deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, trace: judgeTrace });

  if (mode === "deterministic-only") {
    if (Object.hasOwn(options, "judgeInput") || Object.hasOwn(options, "judge")) throw new Error("Judge artifacts are not valid for deterministic-only authored workbook reports.");
    if (publicGate.assertionCount !== deterministicOnlyRequiredAssertionCount()) throw new Error("Deterministic-only authored workbook success requires the 17-assertion gate.");
    const modelIdentities = copyModelIdentitiesForMode(options.modelIdentities, mode) as AuthoredWorkbookEvalDeterministicOnlyModelIdentities;
    const verdict = deterministicSuccessVerdict();
    const files = successFiles(mode) as AuthoredWorkbookDeterministicSuccessFiles;
    const report: AuthoredWorkbookDeterministicOnlyReportEnvelope = deepFreeze({
      ...AUTHORED_WORKBOOK_EVAL_MARKERS,
      runId,
      scenario,
      evaluationMode: mode,
      modelIdentities,
      gate: publicGate,
      judge: { policy: "deterministic-only", expectedCalls: 0, status: "not-run" },
      verdict,
      files
    });
    const summary = renderAuthoredWorkbookSummary({ scenario, gate: publicGate, evaluationMode: mode });
    const metadata: AuthoredWorkbookDeterministicOnlySuccessMetadataEnvelope = deepFreeze({
      ...AUTHORED_WORKBOOK_EVAL_MARKERS,
      runId,
      scenario: scenario.id,
      repetition,
      status: "completed",
      outcome: "passed",
      evaluationMode: mode,
      verdict,
      modelIdentities,
      lifecycle: defaultAuthoredWorkbookEvalLifecycle("completed", mode),
      files
    });
    return deepFreeze({ traceEnvelope, report, summary, metadata });
  }

  const expectedJudgeInput = buildAuthoredWorkbookJudgePrompt(scenario, trace, options.gate);
  if (options.judgeInput !== expectedJudgeInput) throw new Error("Judge input does not match the sanitized authored workbook judge prompt.");
  const judge = verifyAuthoredWorkbookJudgeResult(options.judge, scenario, trace);
  const verdict = authoredWorkbookJudgeVerdict(judge);
  const lifecycleVerdict = verdictFromJudge(verdict);
  const modelIdentities = copyModelIdentitiesForMode(options.modelIdentities, mode) as AuthoredWorkbookEvalJudgedModelIdentities;
  const files = successFiles(mode) as AuthoredWorkbookJudgedSuccessFiles;
  const judgeInputEnvelope: AuthoredWorkbookJudgeInputEnvelope = deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, scenario: scenario.id, traceFile: AUTHORED_WORKBOOK_REPORT_FILENAMES.trace, prompt: expectedJudgeInput });
  const judgeEnvelope: AuthoredWorkbookJudgeEnvelope = deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, judge, verdict });
  const report: AuthoredWorkbookJudgedReportEnvelope = deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId,
    scenario,
    evaluationMode: mode,
    modelIdentities,
    gate: publicGate,
    judge: { policy: "scenario-specific", expectedCalls: 1, status: "completed" },
    verdict: lifecycleVerdict,
    files
  });
  const summary = renderAuthoredWorkbookSummary({ scenario, judge, verdict, gate: publicGate, evaluationMode: mode });
  const metadata: AuthoredWorkbookJudgedSuccessMetadataEnvelope = deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId,
    scenario: scenario.id,
    repetition,
    status: "completed",
    outcome: verdict.passed ? "passed" : "failed",
    evaluationMode: mode,
    verdict: lifecycleVerdict,
    modelIdentities,
    lifecycle: defaultAuthoredWorkbookEvalLifecycle("completed", mode),
    files
  });
  return deepFreeze({ traceEnvelope, judgeInputEnvelope, judgeInput: expectedJudgeInput, judgeEnvelope, report, summary, metadata });
}

export function createAuthoredWorkbookEvalFailureMetadataEnvelope(options: CreateAuthoredWorkbookFailureMetadataOptions): AuthoredWorkbookMetadataEnvelope {
  const status = validFailureStatus(options.status);
  const evaluationMode = validEvaluationMode(options.evaluationMode ?? "judged");
  if (evaluationMode === "deterministic-only" && status === "judge") throw new Error("Deterministic-only authored workbook runs cannot fail in the Judge stage.");
  const outcome: AuthoredWorkbookEvalRunOutcome = status === "interrupted" ? "interrupted" : "failed";
  const message = boundedTextForWrite(publicFailureMessage(status), 1024, "public failure message");
  const scenario = safeScenarioId(options.scenarioId);
  assertScenarioAllowsEvaluationMode(scenario, evaluationMode);
  const envelope = {
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId: safeRunId(options.runId),
    scenario,
    repetition: validRepetition(options.repetition ?? 1),
    status,
    outcome,
    evaluationMode,
    verdict: notJudgedVerdict(),
    modelIdentities: copyModelIdentitiesForMode(options.modelIdentities, evaluationMode),
    lifecycle: defaultAuthoredWorkbookEvalLifecycle(status, evaluationMode),
    files: metadataOnlyFiles(),
    failure: { stage: status, message, diagnosticPolicy: "local-diagnostics-are-not-curated-or-advertised" }
  } as AuthoredWorkbookMetadataEnvelope;
  return deepFreeze(envelope);
}

export function renderAuthoredWorkbookSummary(options: { scenario: AuthoredWorkbookEvalScenarioPublicDescriptor; gate: AuthoredWorkbookEvalPublicGateResult; evaluationMode?: AuthoredWorkbookEvalEvaluationMode; judge?: AuthoredWorkbookEvalJudgeResult; verdict?: AuthoredWorkbookEvalVerdict }): string {
  const mode = validEvaluationMode(options.evaluationMode ?? "judged");
  const lines = [
    `# ${options.scenario.title}`,
    "",
    `Scenario: \`${options.scenario.id}\``,
    `Evaluation mode: **${mode}**`,
    `Deterministic gate: **${options.gate.passed ? "pass" : "fail"}** (${options.gate.assertionCount} assertions)`
  ];
  if (mode === "deterministic-only") {
    lines.push("Judge: **not run** (scenario policy expects 0 Judge calls)", "Verdict: **pass** (deterministic-gate-only)", "");
    return lines.join("\n");
  }
  if (!options.judge || !options.verdict) throw new Error("Judged authored workbook summaries require a Judge result and verdict.");
  lines.push(
    `Judge verdict: **${Math.round(options.verdict.percentage * 100)}%** (${options.verdict.passed ? "pass" : "fail"})`,
    "",
    "## Criteria",
    ""
  );
  for (const criterion of options.scenario.criteria) {
    const score = options.judge.criteria[criterion.id];
    lines.push(`- **${criterion.title}** (${criterion.id}): ${score?.score ?? 0}/2`);
  }
  lines.push("", "## Judge summary", "", options.judge.summary, "");
  return lines.join("\n");
}

export async function writeAuthoredWorkbookEvalReportBundle(options: WriteAuthoredWorkbookReportBundleOptions): Promise<{ directory: string; files: AuthoredWorkbookSuccessCuratedFiles }> {
  const runId = safeRunId(options.runId);
  const objects = createAuthoredWorkbookEvalReportBundleObjects({ ...options, runId });
  const writeText = options.writeText ?? atomicWriteText;
  let directory: string | undefined;
  try {
    directory = await createFreshAuthoredWorkbookEvalReportDirectory(options.reportsRoot, runId);
    const writes: Array<[string, string]> = [
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.trace, jsonEnvelope(objects.traceEnvelope)]
    ];
    if (objects.judgeInputEnvelope && objects.judgeEnvelope) {
      writes.push(
        [AUTHORED_WORKBOOK_REPORT_FILENAMES.judgeInput, jsonEnvelope(objects.judgeInputEnvelope)],
        [AUTHORED_WORKBOOK_REPORT_FILENAMES.judge, jsonEnvelope(objects.judgeEnvelope)]
      );
    }
    writes.push(
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.report, jsonEnvelope(objects.report)],
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.summary, boundedTextForWrite(objects.summary, MAX_CURATED_TEXT_BYTES, "summary")],
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata, jsonEnvelope(objects.metadata)]
    );
    for (const [file, text] of writes) await writeText(join(directory, file), boundedTextForWrite(text, MAX_CURATED_TEXT_BYTES, file));
    await validateRunDirectoryFilesForStatus(resolve(options.reportsRoot), runId, "completed", objects.metadata.evaluationMode);
    return deepFreeze({ directory, files: successFiles(objects.metadata.evaluationMode) });
  } catch (error) {
    if (directory) {
      try { await removeFreshRunDirectoryAfterPartialWrite(options.reportsRoot, runId, directory); }
      catch (rollbackError) { throw sanitizeFsError(rollbackError, REPORT_FS_WRITE_ERROR_MESSAGE); }
    }
    throw sanitizeFsError(error, REPORT_FS_WRITE_ERROR_MESSAGE);
  }
}

export async function writeAuthoredWorkbookEvalFailureMetadata(options: WriteAuthoredWorkbookFailureMetadataOptions): Promise<{ directory: string; files: AuthoredWorkbookMetadataOnlyFiles }> {
  const runId = safeRunId(options.runId);
  const metadata = createAuthoredWorkbookEvalFailureMetadataEnvelope({ ...options, runId });
  const writeText = options.writeText ?? atomicWriteText;
  let directory: string | undefined;
  try {
    directory = await createFreshAuthoredWorkbookEvalReportDirectory(options.reportsRoot, runId);
    await writeText(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata), boundedTextForWrite(jsonEnvelope(metadata), MAX_CURATED_TEXT_BYTES, AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata));
    await validateRunDirectoryFilesForStatus(resolve(options.reportsRoot), runId, metadata.status, metadata.evaluationMode);
    return deepFreeze({ directory, files: metadataOnlyFiles() });
  } catch (error) {
    if (directory) {
      try { await removeFreshRunDirectoryAfterPartialWrite(options.reportsRoot, runId, directory); }
      catch (rollbackError) { throw sanitizeFsError(rollbackError, REPORT_FS_WRITE_ERROR_MESSAGE); }
    }
    throw sanitizeFsError(error, REPORT_FS_WRITE_ERROR_MESSAGE);
  }
}

export async function createFreshAuthoredWorkbookEvalReportDirectory(reportsRoot: string, runId: string): Promise<string> {
  const safeId = safeRunId(runId);
  try {
    const root = resolve(reportsRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Authored workbook reports root must be an ordinary directory.");
    await chmod(root, 0o700);
    const rootReal = await realpath(root);
    const directory = resolve(rootReal, safeId);
    if (!isInside(rootReal, directory) || basename(directory) !== safeId) throw new Error("Invalid authored workbook report directory.");
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (isNativeFsError(error) && error.code === "EEXIST") throw new Error("Authored workbook report run directory already exists; run ids are idempotency keys and are never reused.");
      throw error;
    }
    await chmod(directory, 0o700);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Authored workbook report run directory must be an ordinary fresh directory.");
    const directoryReal = await realpath(directory);
    if (directoryReal !== directory) throw new Error("Authored workbook report run directory must not be a symlink or path alias.");
    await fsyncDirectory(rootReal);
    return directory;
  } catch (error) {
    throw sanitizeFsError(error, REPORT_FS_DIRECTORY_ERROR_MESSAGE);
  }
}

export async function atomicWriteText(path: string, data: string): Promise<void> {
  const target = resolve(path);
  const parent = dirname(target);
  const name = basename(target);
  if (name.includes(sep) || name === "." || name === ".." || name.includes("/")) throw new Error("Invalid authored workbook report file name.");
  let temp = join(parent, `.${name}.tmp-${randomUUID()}`);
  let final = join(parent, name);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Authored workbook report parent must be an ordinary directory.");
    const parentReal = await realpath(parent);
    final = join(parentReal, name);
    const realTemp = join(parentReal, basename(temp));
    temp = realTemp;
    handle = await open(realTemp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(realTemp, 0o600);
    await assertOrdinarySingleLinkFile(realTemp, "Authored workbook report temp file must be an ordinary non-linked file.");
    await rename(realTemp, final);
    renamed = true;
    await assertOrdinarySingleLinkFile(final, "Authored workbook report file must be an ordinary non-linked file.");
    await chmod(final, 0o600);
    await fsyncDirectory(parentReal);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (renamed) await rm(final, { force: true }).catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw sanitizeFsError(error, "Unable to write authored workbook report file.");
  }
}

function isNativeFsError(error: unknown): error is NodeJS.ErrnoException {
  return isPlainRecord(error) && (typeof error.code === "string" || typeof error.syscall === "string" || typeof error.path === "string");
}

function sanitizeFsError(error: unknown, message: string): Error {
  return isNativeFsError(error) ? new Error(message) : error instanceof Error ? error : new Error(message);
}

interface StableFilesystemIdentity {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface LatestRunValidationSnapshot {
  reportDirectory: string;
  directory: StableFilesystemIdentity;
  files: Record<string, StableFilesystemIdentity>;
}

function stableFilesystemIdentity(stat: Stats): StableFilesystemIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function sameStableFilesystemIdentity(left: StableFilesystemIdentity, right: StableFilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertStableFilesystemIdentity(left: StableFilesystemIdentity, right: StableFilesystemIdentity, message: string): void {
  if (!sameStableFilesystemIdentity(left, right)) throw new Error(message);
}

function assertOrdinarySingleLinkFileStat(stat: Stats, message: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error(message);
}

async function assertOrdinarySingleLinkFile(path: string, message: string): Promise<void> {
  assertOrdinarySingleLinkFileStat(await lstat(path), message);
}

async function assertOrdinaryDirectory(path: string, message: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error(message);
}

async function canonicalReportsRoot(reportsRoot: string): Promise<string> {
  const root = resolve(reportsRoot);
  await assertOrdinaryDirectory(root, "Authored workbook reports root must be an ordinary directory.");
  return realpath(root);
}

async function runDirectoryForRoot(rootReal: string, runDirectory: string): Promise<string> {
  const directory = resolve(rootReal, runDirectory);
  if (!isInside(rootReal, directory)) throw new Error("Invalid authored workbook report directory.");
  await assertOrdinaryDirectory(directory, "Authored workbook report run directory must be an ordinary directory.");
  const real = await realpath(directory);
  if (real !== directory) throw new Error("Authored workbook report run directory must not be a symlink or path alias.");
  return directory;
}

async function readBoundedFileHandleText(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, label: string): Promise<string> {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
  let total = 0;
  let position = 0;
  while (true) {
    const length = Math.min(buffer.byteLength, maxBytes - total + 1);
    if (length <= 0) throw new Error(`${label} exceeds the authored workbook report length limit.`);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error(`${label} exceeds the authored workbook report length limit.`);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    position += bytesRead;
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readStableJsonFile(path: string, label: string): Promise<{ parsed: unknown; text: string; identity: StableFilesystemIdentity }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
    const beforeStat = await handle.stat();
    assertOrdinarySingleLinkFileStat(beforeStat, `Authored workbook ${label} must be an ordinary non-linked file.`);
    if (beforeStat.size > MAX_CURATED_TEXT_BYTES) throw new Error(`authored workbook ${label} exceeds the authored workbook report length limit.`);
    const beforeIdentity = stableFilesystemIdentity(beforeStat);
    const text = await readBoundedFileHandleText(handle, MAX_CURATED_TEXT_BYTES, `authored workbook ${label}`);
    const afterStat = await handle.stat();
    assertOrdinarySingleLinkFileStat(afterStat, `Authored workbook ${label} must be an ordinary non-linked file.`);
    const afterIdentity = stableFilesystemIdentity(afterStat);
    assertStableFilesystemIdentity(beforeIdentity, afterIdentity, `Authored workbook ${label} changed during validation.`);
    if (Buffer.byteLength(text, "utf8") !== afterStat.size) throw new Error(`Authored workbook ${label} changed during validation.`);
    const pathStat = await lstat(path);
    assertOrdinarySingleLinkFileStat(pathStat, `Authored workbook ${label} must be an ordinary non-linked file.`);
    assertStableFilesystemIdentity(afterIdentity, stableFilesystemIdentity(pathStat), `Authored workbook ${label} path changed during validation.`);
    try {
      return { parsed: JSON.parse(text), text, identity: afterIdentity };
    } catch {
      throw new Error(`Invalid authored workbook ${label}.`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStableTextFile(path: string, label: string): Promise<{ text: string; identity: StableFilesystemIdentity }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
    const beforeStat = await handle.stat();
    assertOrdinarySingleLinkFileStat(beforeStat, `Authored workbook ${label} must be an ordinary non-linked file.`);
    if (beforeStat.size > MAX_CURATED_TEXT_BYTES) throw new Error(`authored workbook ${label} exceeds the authored workbook report length limit.`);
    const beforeIdentity = stableFilesystemIdentity(beforeStat);
    const text = await readBoundedFileHandleText(handle, MAX_CURATED_TEXT_BYTES, `authored workbook ${label}`);
    const afterStat = await handle.stat();
    assertOrdinarySingleLinkFileStat(afterStat, `Authored workbook ${label} must be an ordinary non-linked file.`);
    const afterIdentity = stableFilesystemIdentity(afterStat);
    assertStableFilesystemIdentity(beforeIdentity, afterIdentity, `Authored workbook ${label} changed during validation.`);
    if (Buffer.byteLength(text, "utf8") !== afterStat.size) throw new Error(`Authored workbook ${label} changed during validation.`);
    const pathStat = await lstat(path);
    assertOrdinarySingleLinkFileStat(pathStat, `Authored workbook ${label} must be an ordinary non-linked file.`);
    assertStableFilesystemIdentity(afterIdentity, stableFilesystemIdentity(pathStat), `Authored workbook ${label} path changed during validation.`);
    return { text, identity: afterIdentity };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStableMetadataJson(metadataPath: string): Promise<{ metadata: AuthoredWorkbookMetadataEnvelope; identity: StableFilesystemIdentity }> {
  const { parsed, identity } = await readStableJsonFile(metadataPath, "metadata.json");
  return { metadata: copyStrictAuthoredWorkbookMetadataEnvelope(parsed), identity };
}

async function validateRunDirectoryFilesForStatus(reportsRoot: string, runDirectory: string, status: AuthoredWorkbookEvalRunLifecycleStatus, mode: AuthoredWorkbookEvalEvaluationMode): Promise<void> {
  const checkedStatus = validRunStatus(status);
  const checkedMode = validEvaluationMode(mode);
  const rootReal = await canonicalReportsRoot(reportsRoot);
  const directory = await runDirectoryForRoot(rootReal, runDirectory);
  const expected = curatedFilesForStatus(checkedStatus, checkedMode);
  await assertRunDirectoryClosed(directory, expected);
  const { metadata } = await readStableMetadataJson(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata));
  if (metadata.runId !== runIdFromReportDirectory(runDirectory) || metadata.status !== checkedStatus || metadata.evaluationMode !== checkedMode || !sameCuratedFiles(metadata.files, expected)) throw new Error("Authored workbook report metadata identity mismatch.");
  await validateCuratedContentMatchesMetadata(directory, metadata);
}

async function assertRunDirectoryClosed(directory: string, expected: AuthoredWorkbookCuratedFiles): Promise<void> {
  const expectedFiles = new Set<string>(Object.values(expected));
  const recognizedDiagnostics = new Set<string>(Object.values(AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES));
  for (const file of expectedFiles) await assertOrdinarySingleLinkFile(join(directory, file), "Authored workbook report advertised file must be an ordinary non-linked file.");
  for (const entry of await readdir(directory)) {
    if (entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) throw new Error("Authored workbook report directory contains an invalid entry.");
    const path = join(directory, entry);
    if (expectedFiles.has(entry)) continue;
    if (recognizedDiagnostics.has(entry)) {
      await assertOrdinarySingleLinkFile(path, "Authored workbook report local diagnostic must be an ordinary non-linked file.");
      continue;
    }
    throw new Error("Authored workbook report directory contains an unexpected file.");
  }
}

async function validateCuratedContentMatchesMetadata(directory: string, metadata: AuthoredWorkbookMetadataEnvelope): Promise<void> {
  if (metadata.status !== "completed") return;
  const { parsed: traceParsed } = await readStableJsonFile(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.trace), "trace.json");
  const traceEnvelope = copyStrictAuthoredWorkbookTraceEnvelope(traceParsed, metadata.scenario);
  const { parsed: reportParsed } = await readStableJsonFile(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.report), "report.json");
  const report = copyStrictAuthoredWorkbookReportEnvelope(reportParsed);
  assertReportMatchesMetadata(report, metadata);
  let expectedSummary: string;
  if (metadata.evaluationMode === "judged") {
    const { parsed: judgeInputParsed } = await readStableJsonFile(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.judgeInput), "judge-input.json");
    const judgeInput = copyStrictAuthoredWorkbookJudgeInputEnvelope(judgeInputParsed);
    if (judgeInput.scenario !== metadata.scenario || judgeInput.traceFile !== AUTHORED_WORKBOOK_REPORT_FILENAMES.trace) throw new Error("Authored workbook judge input identity mismatch.");
    const expectedPrompt = buildAuthoredWorkbookJudgePromptFromProjectedTrace(report.scenario, traceEnvelope.trace, report.gate);
    if (judgeInput.prompt !== expectedPrompt) throw new Error("Authored workbook judge input prompt mismatch.");
    const { parsed: judgeParsed } = await readStableJsonFile(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.judge), "judge.json");
    const judge = copyStrictAuthoredWorkbookJudgeEnvelope(judgeParsed, report.scenario, traceEnvelope.trace);
    if (!sameLifecycleVerdict(verdictFromJudge(judge.verdict), metadata.verdict)) throw new Error("Authored workbook judge verdict metadata mismatch.");
    expectedSummary = renderAuthoredWorkbookSummary({ scenario: report.scenario, gate: report.gate, evaluationMode: metadata.evaluationMode, judge: judge.judge, verdict: judge.verdict });
  } else {
    expectedSummary = renderAuthoredWorkbookSummary({ scenario: report.scenario, gate: report.gate, evaluationMode: metadata.evaluationMode });
  }
  const { text: summary } = await readStableTextFile(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.summary), "summary.md");
  if (summary !== expectedSummary) throw new Error("Authored workbook summary metadata mismatch.");
}

function runIdFromReportDirectory(reportDirectory: string): string {
  const parts = reportDirectory.split("/");
  return parts[parts.length - 1] ?? reportDirectory;
}

function sameLifecycleVerdict(left: AuthoredWorkbookEvalLifecycleVerdict, right: AuthoredWorkbookEvalLifecycleVerdict): boolean {
  return left.passed === right.passed && left.percentage === right.percentage && left.rule === right.rule;
}

function sameCuratedFiles(left: AuthoredWorkbookCuratedFiles, right: AuthoredWorkbookCuratedFiles): boolean {
  const leftRecord = left as Record<string, string>;
  const rightRecord = right as Record<string, string>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) => leftRecord[key] === rightRecord[key]);
}

function sameModelIdentities(left: AuthoredWorkbookEvalModelIdentities, right: AuthoredWorkbookEvalModelIdentities): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function copyStrictMarkers(value: Record<string, unknown>, label: string): void {
  if (value.namespace !== AUTHORED_WORKBOOK_EVAL_MARKERS.namespace || value.owner !== AUTHORED_WORKBOOK_EVAL_MARKERS.owner || value.suite !== AUTHORED_WORKBOOK_EVAL_MARKERS.suite || value.schemaVersion !== AUTHORED_WORKBOOK_EVAL_MARKERS.schemaVersion) throw new Error(`Invalid authored workbook ${label} markers.`);
}

function copyStrictAuthoredWorkbookTraceEnvelope(value: unknown, expectedScenario: string): AuthoredWorkbookTraceEnvelope {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook trace envelope.");
  assertExactKeys(value, ["namespace", "owner", "suite", "schemaVersion", "trace"], "authored workbook trace envelope");
  copyStrictMarkers(value, "trace envelope");
  const trace = copyStrictAuthoredWorkbookJudgeTrace(value.trace);
  if (trace.scenarioId !== expectedScenario) throw new Error("Authored workbook trace metadata identity mismatch.");
  return deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, trace });
}

function copyStrictAuthoredWorkbookJudgeTrace(value: unknown): AuthoredWorkbookEvalJudgeTrace {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge trace.");
  assertExactKeys(value, ["scenarioId", "publicStates", "terminalTranscript", "reflections", "editors", "progressionEvents", "artifacts"], "authored workbook judge trace");
  if (!Array.isArray(value.publicStates) || !Array.isArray(value.terminalTranscript) || !Array.isArray(value.reflections) || !Array.isArray(value.editors) || !Array.isArray(value.progressionEvents) || !Array.isArray(value.artifacts)) throw new Error("Invalid authored workbook judge trace.");
  return deepFreeze({
    scenarioId: safeScenarioId(value.scenarioId),
    publicStates: value.publicStates.map(copyStrictJudgeRecordedPublicState),
    terminalTranscript: value.terminalTranscript.map(copyStrictPublicTerminalTranscriptEntry),
    reflections: value.reflections.map(copyStrictPublicReflectionEntry),
    editors: value.editors.map(copyStrictPublicEditorEntry),
    progressionEvents: value.progressionEvents.map(copyStrictProgressionEvent),
    artifacts: value.artifacts.map(copyStrictArtifactSnapshot)
  });
}

function copyStrictJudgeRecordedPublicState(value: unknown): AuthoredWorkbookEvalJudgeTrace["publicStates"][number] {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge public state.");
  assertExactKeys(value, ["label", "state"], "authored workbook judge public state");
  return { label: boundedString(value.label, "public state label", 128), state: deepFreeze(copyAuthoredWorkbookEvalJudgePublicState(value.state)) };
}

function copyStrictPublicTerminalTranscriptEntry(value: unknown): AuthoredWorkbookEvalJudgeTrace["terminalTranscript"][number] {
  if (!isPlainRecord(value) || (value.direction !== "input" && value.direction !== "output" && value.direction !== "observer") || typeof value.text !== "string") throw new Error("Invalid authored workbook terminal transcript entry.");
  const keys = Object.hasOwn(value, "blockId") ? ["blockId", "direction", "text"] : ["direction", "text"];
  assertExactKeys(value, keys, "authored workbook terminal transcript entry");
  if (Object.hasOwn(value, "blockId") && typeof value.blockId !== "string") throw new Error("Invalid authored workbook terminal transcript entry.");
  const text = boundedString(value.text, "terminal transcript", 64 * 1024);
  return Object.hasOwn(value, "blockId") ? { blockId: boundedString(value.blockId, "terminal transcript block id", 512), direction: value.direction, text } : { direction: value.direction, text };
}

function copyStrictPublicReflectionEntry(value: unknown): AuthoredWorkbookEvalJudgeTrace["reflections"][number] {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || (value.role !== "learner" && value.role !== "tutor") || typeof value.text !== "string") throw new Error("Invalid authored workbook reflection entry.");
  assertExactKeys(value, ["blockId", "role", "text"], "authored workbook reflection entry");
  return { blockId: boundedString(value.blockId, "reflection block id", 512), role: value.role, text: boundedString(value.text, "reflection transcript", 64 * 1024) };
}

function copyStrictPublicEditorEntry(value: unknown): AuthoredWorkbookEvalJudgeTrace["editors"][number] {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || !Number.isInteger(value.revision) || (value.status !== "reviewing" && value.status !== "feedback" && value.status !== "unlocked")) throw new Error("Invalid authored workbook editor entry.");
  const keys = Object.hasOwn(value, "feedback") ? ["blockId", "revision", "status", "feedback"] : ["blockId", "revision", "status"];
  assertExactKeys(value, keys, "authored workbook editor entry");
  if (Object.hasOwn(value, "feedback") && typeof value.feedback !== "string") throw new Error("Invalid authored workbook editor entry.");
  const revision = value.revision as number;
  return Object.hasOwn(value, "feedback") ? { blockId: boundedString(value.blockId, "editor block id", 512), revision, status: value.status, feedback: boundedString(value.feedback, "editor feedback", 64 * 1024) } : { blockId: boundedString(value.blockId, "editor block id", 512), revision, status: value.status };
}

function copyStrictProgressionEvent(value: unknown): AuthoredWorkbookEvalJudgeTrace["progressionEvents"][number] {
  if (!isPlainRecord(value) || typeof value.type !== "string") throw new Error("Invalid authored workbook progression event.");
  switch (value.type) {
    case "session_started":
    case "workbook_introduction_completed":
      assertExactKeys(value, ["type"], "authored workbook progression event");
      return { type: value.type };
    case "attempt_accepted":
      assertExactKeys(value, ["type", "lessonId", "blockId", "kind"], "authored workbook progression event");
      if (typeof value.lessonId !== "string" || typeof value.blockId !== "string" || (value.kind !== "editor" && value.kind !== "terminal" && value.kind !== "reflection")) throw new Error("Invalid authored workbook progression event.");
      return { type: "attempt_accepted", lessonId: value.lessonId, blockId: value.blockId, kind: value.kind };
    case "reflection_submitted":
    case "reflection_follow_up_submitted":
    case "reflection_reply_recorded":
    case "reflection_completed":
      assertExactKeys(value, ["type", "lessonId", "blockId"], "authored workbook progression event");
      if (typeof value.lessonId !== "string" || typeof value.blockId !== "string") throw new Error("Invalid authored workbook progression event.");
      return { type: value.type, lessonId: value.lessonId, blockId: value.blockId };
    case "block_completed": {
      const keys = Object.hasOwn(value, "lessonId") ? ["type", "lessonId", "blockId"] : ["type", "blockId"];
      assertExactKeys(value, keys, "authored workbook progression event");
      if (Object.hasOwn(value, "lessonId") && typeof value.lessonId !== "string") throw new Error("Invalid authored workbook progression event.");
      if (typeof value.blockId !== "string") throw new Error("Invalid authored workbook progression event.");
      return Object.hasOwn(value, "lessonId") ? { type: "block_completed", lessonId: value.lessonId as string, blockId: value.blockId } : { type: "block_completed", blockId: value.blockId };
    }
    default:
      throw new Error("Invalid authored workbook progression event.");
  }
}

function copyStrictArtifactSnapshot(value: unknown): AuthoredWorkbookEvalJudgeTrace["artifacts"][number] {
  if (!isPlainRecord(value) || typeof value.path !== "string" || typeof value.content !== "string") throw new Error("Invalid authored workbook artifact snapshot.");
  assertExactKeys(value, ["path", "content"], "authored workbook artifact snapshot");
  const path = boundedString(value.path, "artifact path", 512);
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("Invalid authored workbook artifact path.");
  return { path, content: boundedString(value.content, `artifact '${path}'`, 64 * 1024) };
}

function copyStrictScenarioPublicDescriptor(value: unknown): AuthoredWorkbookEvalScenarioPublicDescriptor {
  if (!isPlainRecord(value) || !Array.isArray(value.criteria)) throw new Error("Invalid authored workbook eval scenario descriptor.");
  assertExactKeys(value, ["id", "title", "description", "criteria"], "authored workbook eval scenario descriptor");
  for (const criterion of value.criteria) {
    if (!isPlainRecord(criterion)) throw new Error("Invalid authored workbook eval scenario criterion.");
    assertExactKeys(criterion, ["id", "title", "description"], "authored workbook eval scenario criterion");
  }
  const descriptor = copyAuthoredWorkbookEvalScenarioPublicDescriptor(value);
  const expected = authoredWorkbookScenarioPublicDescriptorById(descriptor.id);
  if (!sameScenarioPublicDescriptor(descriptor, expected)) throw new Error("Authored workbook report scenario descriptor does not match the authored catalog.");
  return expected;
}

function sameScenarioPublicDescriptor(left: AuthoredWorkbookEvalScenarioPublicDescriptor, right: AuthoredWorkbookEvalScenarioPublicDescriptor): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.description === right.description
    && left.criteria.length === right.criteria.length
    && left.criteria.every((criterion, index) => {
      const expected = right.criteria[index];
      return expected !== undefined && criterion.id === expected.id && criterion.title === expected.title && criterion.description === expected.description;
    });
}

function copyStrictPublicGate(value: unknown): AuthoredWorkbookEvalPublicGateResult {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook public gate result.");
  assertExactKeys(value, ["passed", "assertionCount", "failureCount", "assertions", "detailPolicy"], "authored workbook public gate result");
  if (typeof value.passed !== "boolean" || !Number.isInteger(value.assertionCount) || !Number.isInteger(value.failureCount) || !Array.isArray(value.assertions) || value.detailPolicy !== "assertion-details-omitted-from-public-report") throw new Error("Invalid authored workbook public gate result.");
  const assertions = value.assertions.map((assertion, index) => {
    if (!isPlainRecord(assertion)) throw new Error("Invalid authored workbook public gate assertion.");
    assertExactKeys(assertion, ["index", "passed"], "authored workbook public gate assertion");
    if (assertion.index !== index || typeof assertion.passed !== "boolean") throw new Error("Invalid authored workbook public gate assertion.");
    return { index, passed: assertion.passed };
  });
  const failureCount = assertions.filter((assertion) => !assertion.passed).length;
  if (value.assertionCount !== assertions.length || value.failureCount !== failureCount) throw new Error("Invalid authored workbook public gate result.");
  if (value.passed && failureCount > 0) throw new Error("Invalid authored workbook public gate result with failed assertions.");
  return deepFreeze({ passed: value.passed, assertionCount: assertions.length, failureCount, assertions, detailPolicy: "assertion-details-omitted-from-public-report" as const });
}

function assertCompletedPublicGatePassed(gate: AuthoredWorkbookEvalPublicGateResult): void {
  if (gate.passed !== true || gate.failureCount !== 0 || gate.assertions.some((assertion) => assertion.passed !== true)) throw new Error("Invalid completed authored workbook report gate.");
}

function copyStrictJudgeRunSummary(value: unknown, mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookEvalJudgeRunSummary {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook report judge summary.");
  if (mode === "deterministic-only") {
    assertExactKeys(value, ["policy", "expectedCalls", "status"], "authored workbook report judge summary");
    if (value.policy !== "deterministic-only" || value.expectedCalls !== 0 || value.status !== "not-run") throw new Error("Invalid authored workbook report judge summary.");
    return { policy: "deterministic-only", expectedCalls: 0, status: "not-run" };
  }
  assertExactKeys(value, ["policy", "expectedCalls", "status"], "authored workbook report judge summary");
  if (value.policy !== "scenario-specific" || value.expectedCalls !== 1 || value.status !== "completed") throw new Error("Invalid authored workbook report judge summary.");
  return { policy: "scenario-specific", expectedCalls: 1, status: "completed" };
}

function copyStrictAuthoredWorkbookReportEnvelope(value: unknown): AuthoredWorkbookReportEnvelope {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook report envelope.");
  assertExactKeys(value, ["namespace", "owner", "suite", "schemaVersion", "runId", "scenario", "evaluationMode", "modelIdentities", "gate", "judge", "verdict", "files"], "authored workbook report envelope");
  copyStrictMarkers(value, "report envelope");
  const mode = validEvaluationMode(value.evaluationMode);
  const scenario = copyStrictScenarioPublicDescriptor(value.scenario);
  assertScenarioAllowsEvaluationMode(scenario.id, mode);
  const gate = copyStrictPublicGate(value.gate);
  assertCompletedPublicGatePassed(gate);
  if (mode === "deterministic-only" && gate.assertionCount !== deterministicOnlyRequiredAssertionCount()) throw new Error("Invalid deterministic-only authored workbook report gate.");
  return deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId: safeRunId(value.runId),
    scenario,
    evaluationMode: mode,
    modelIdentities: copyStrictAuthoredWorkbookEvalModelIdentities(value.modelIdentities, mode),
    gate,
    judge: copyStrictJudgeRunSummary(value.judge, mode),
    verdict: copyLifecycleVerdictForStatus("completed", value.verdict, mode),
    files: copyExactCuratedFilesForStatus("completed", value.files, mode)
  } as AuthoredWorkbookReportEnvelope);
}

function copyStrictAuthoredWorkbookJudgeInputEnvelope(value: unknown): AuthoredWorkbookJudgeInputEnvelope {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge input envelope.");
  assertExactKeys(value, ["namespace", "owner", "suite", "schemaVersion", "scenario", "traceFile", "prompt"], "authored workbook judge input envelope");
  copyStrictMarkers(value, "judge input envelope");
  if (value.traceFile !== AUTHORED_WORKBOOK_REPORT_FILENAMES.trace) throw new Error("Invalid authored workbook judge input envelope.");
  return deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, scenario: safeScenarioId(value.scenario), traceFile: AUTHORED_WORKBOOK_REPORT_FILENAMES.trace, prompt: boundedString(value.prompt, "judge prompt", MAX_CURATED_TEXT_BYTES) });
}

function copyStrictJudgeResultForTrace(value: unknown, scenario: AuthoredWorkbookEvalScenarioPublicDescriptor, trace: AuthoredWorkbookEvalJudgeTrace): AuthoredWorkbookEvalJudgeResult {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge result.");
  assertExactKeys(value, ["criteria", "summary"], "authored workbook judge result");
  if (!isPlainRecord(value.criteria)) throw new Error("Invalid authored workbook judge result.");
  const criterionIds = scenario.criteria.map((criterion) => criterion.id);
  assertExactKeys(value.criteria, criterionIds, "authored workbook judge criteria");
  const validCitationIds = new Set(enumerateAuthoredWorkbookEvalJudgeCitations(trace).map((citation) => citation.id));
  const criteria: Record<string, AuthoredWorkbookEvalJudgeCriterionScore> = {};
  for (const id of criterionIds) {
    const score = value.criteria[id];
    if (!isPlainRecord(score)) throw new Error("Invalid authored workbook judge criterion.");
    assertExactKeys(score, ["score", "citations", "rationale"], "authored workbook judge criterion");
    if (score.score !== 0 && score.score !== 1 && score.score !== 2) throw new Error("Invalid authored workbook judge criterion.");
    if (!Array.isArray(score.citations) || score.citations.length === 0 || !score.citations.every((citation) => Number.isInteger(citation) && validCitationIds.has(citation))) throw new Error("Invalid authored workbook judge citation.");
    criteria[id] = { score: score.score, citations: [...score.citations], rationale: boundedString(score.rationale, "judge rationale", 8 * 1024) };
  }
  return deepFreeze({ criteria, summary: boundedString(value.summary, "judge summary", 16 * 1024) });
}

function copyStrictAuthoredWorkbookJudgeEnvelope(value: unknown, scenario: AuthoredWorkbookEvalScenarioPublicDescriptor, trace: AuthoredWorkbookEvalJudgeTrace): AuthoredWorkbookJudgeEnvelope {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge envelope.");
  assertExactKeys(value, ["namespace", "owner", "suite", "schemaVersion", "judge", "verdict"], "authored workbook judge envelope");
  copyStrictMarkers(value, "judge envelope");
  const judge = copyStrictJudgeResultForTrace(value.judge, scenario, trace);
  const verdict = copyLifecycleVerdictForStatus("completed", value.verdict, "judged") as AuthoredWorkbookJudgedLifecycleVerdict;
  const derived = authoredWorkbookJudgeVerdict(judge);
  if (!sameLifecycleVerdict(verdict, derived)) throw new Error("Authored workbook judge verdict does not match judge scores.");
  return deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, judge, verdict });
}

function assertReportMatchesMetadata(report: AuthoredWorkbookReportEnvelope, metadata: AuthoredWorkbookMetadataEnvelope): void {
  if (metadata.status !== "completed") throw new Error("Authored workbook report metadata identity mismatch.");
  if (report.runId !== metadata.runId || report.scenario.id !== metadata.scenario || report.evaluationMode !== metadata.evaluationMode) throw new Error("Authored workbook report metadata identity mismatch.");
  if (!sameLifecycleVerdict(report.verdict, metadata.verdict) || !sameCuratedFiles(report.files, metadata.files) || !sameModelIdentities(report.modelIdentities, metadata.modelIdentities)) throw new Error("Authored workbook report metadata identity mismatch.");
}

function assertLatestEntryMatchesMetadata(entry: AuthoredWorkbookEvalLatestRunEntry, metadata: AuthoredWorkbookMetadataEnvelope): void {
  if (metadata.runId !== runIdFromReportDirectory(entry.reportDirectory)) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (metadata.scenario !== entry.scenario) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (metadata.repetition !== entry.repetition) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (metadata.status !== entry.status) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (metadata.evaluationMode !== entry.evaluationMode) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (!sameLifecycleVerdict(metadata.verdict, entry.verdict)) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (!sameCuratedFiles(metadata.files, entry.files)) throw new Error("Authored workbook latest metadata identity mismatch.");
}

function assertSameLatestRunValidationSnapshot(left: LatestRunValidationSnapshot, right: LatestRunValidationSnapshot): void {
  if (left.reportDirectory !== right.reportDirectory) throw new Error("Authored workbook latest report directory changed during write.");
  assertStableFilesystemIdentity(left.directory, right.directory, "Authored workbook latest report directory changed during write.");
  const leftFiles = Object.keys(left.files);
  const rightFiles = Object.keys(right.files);
  if (leftFiles.length !== rightFiles.length || leftFiles.some((file) => !rightFiles.includes(file))) throw new Error("Authored workbook latest advertised files changed during write.");
  for (const file of leftFiles) assertStableFilesystemIdentity(left.files[file]!, right.files[file]!, "Authored workbook latest advertised files changed during write.");
}

async function validateLatestRunDirectory(rootReal: string, entry: AuthoredWorkbookEvalLatestRunEntry): Promise<LatestRunValidationSnapshot> {
  await validateRunDirectoryFilesForStatus(rootReal, entry.reportDirectory, entry.status, entry.evaluationMode);
  const directory = await runDirectoryForRoot(rootReal, entry.reportDirectory);
  const directoryStat = await lstat(directory);
  const directoryIdentity = stableFilesystemIdentity(directoryStat);
  const expected = curatedFilesForStatus(entry.status, entry.evaluationMode);
  copyExactCuratedFilesForStatus(entry.status, entry.files, entry.evaluationMode);
  const files: Record<string, StableFilesystemIdentity> = {};
  for (const file of Object.values(expected)) {
    const candidate = join(directory, file);
    const stat = await lstat(candidate);
    assertOrdinarySingleLinkFileStat(stat, "Authored workbook latest advertised file must be an ordinary non-linked file.");
    const real = await realpath(candidate);
    if (real !== candidate || !isInside(rootReal, real)) throw new Error("Authored workbook latest advertised file must stay under the reports root without aliases.");
    files[file] = stableFilesystemIdentity(stat);
  }
  for (const file of Object.values(AUTHORED_WORKBOOK_REPORT_FILENAMES)) {
    if (Object.values(expected).includes(file)) continue;
    try {
      await lstat(join(directory, file));
      throw new Error("Authored workbook latest run directory contains unexpected curated files for its status.");
    } catch (error) {
      if (isNativeFsError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  const { metadata, identity } = await readStableMetadataJson(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata));
  assertLatestEntryMatchesMetadata(entry, metadata);
  files[AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata] = identity;
  return deepFreeze({ reportDirectory: entry.reportDirectory, directory: directoryIdentity, files });
}

async function validateLatestRunSnapshots(rootReal: string, runs: readonly AuthoredWorkbookEvalLatestRunEntry[]): Promise<LatestRunValidationSnapshot[]> {
  const snapshots: LatestRunValidationSnapshot[] = [];
  for (const run of runs) snapshots.push(await validateLatestRunDirectory(rootReal, run));
  return deepFreeze(snapshots);
}

async function assertLatestRunSnapshotsUnchanged(rootReal: string, runs: readonly AuthoredWorkbookEvalLatestRunEntry[], previous: readonly LatestRunValidationSnapshot[]): Promise<void> {
  const current = await validateLatestRunSnapshots(rootReal, runs);
  if (current.length !== previous.length) throw new Error("Authored workbook latest run set changed during write.");
  for (let index = 0; index < previous.length; index += 1) assertSameLatestRunValidationSnapshot(previous[index]!, current[index]!);
}

async function removeFreshRunDirectoryAfterPartialWrite(reportsRoot: string, runId: string, directory: string): Promise<void> {
  const rootReal = await canonicalReportsRoot(reportsRoot);
  const expectedDirectory = resolve(rootReal, safeRunId(runId));
  if (directory !== expectedDirectory) throw new Error("Invalid authored workbook report directory rollback target.");
  await assertOrdinaryDirectory(directory, "Authored workbook report rollback target must be an ordinary directory.");
  const directoryReal = await realpath(directory);
  if (directoryReal !== directory || !isInside(rootReal, directoryReal)) throw new Error("Invalid authored workbook report directory rollback target.");
  for (const entry of await readdir(directory)) {
    if (entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) throw new Error("Invalid authored workbook report rollback entry.");
    const child = join(directory, entry);
    const metadata = await lstat(child);
    if (metadata.isDirectory()) throw new Error("Authored workbook report rollback refuses nested directories.");
    await unlink(child);
  }
  await rmdir(directory);
  await fsyncDirectory(rootReal);
}

async function replaceLatestPreservingPrevious(rootReal: string, data: string, writeText: (path: string, data: string) => Promise<void>, validateReplacement?: () => Promise<void>): Promise<void> {
  const final = join(rootReal, AUTHORED_WORKBOOK_LATEST_FILENAME);
  const backup = join(rootReal, `.latest.json.backup-${randomUUID()}`);
  let backupCreated = false;
  let hadPrevious = false;
  let attemptedReplace = false;
  try {
    try {
      await assertOrdinarySingleLinkFile(final, "Authored workbook previous latest must be an ordinary non-linked file.");
      await copyFile(final, backup, constants.COPYFILE_EXCL);
      await assertOrdinarySingleLinkFile(backup, "Authored workbook latest backup must be an ordinary non-linked file.");
      hadPrevious = true;
      backupCreated = true;
      await fsyncFile(backup);
      await fsyncDirectory(rootReal);
    } catch (error) {
      if (isNativeFsError(error) && error.code === "ENOENT") {
        hadPrevious = false;
      } else {
        throw error;
      }
    }
    attemptedReplace = true;
    await validateReplacement?.();
    await writeText(final, data);
    await assertOrdinarySingleLinkFile(final, "Authored workbook latest must be an ordinary non-linked file.");
    const written = await readFile(final, "utf8");
    if (written !== data) throw new Error("Authored workbook latest replacement did not write the checked envelope.");
    await validateReplacement?.();
    await rm(backup, { force: true });
    backupCreated = false;
    await fsyncDirectory(rootReal);
  } catch (error) {
    if (attemptedReplace) await rm(final, { force: true }).catch(() => undefined);
    if (hadPrevious && backupCreated) {
      if (attemptedReplace) await rename(backup, final);
      else await rm(backup, { force: true }).catch(() => undefined);
      await fsyncDirectory(rootReal);
    } else {
      await rm(backup, { force: true }).catch(() => undefined);
      await fsyncDirectory(rootReal);
    }
    throw error;
  }
}

async function fsyncFile(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not available on every platform/filesystem. File fsync+rename still gives
    // atomic replacement; callers can inject a writer in tests to force failures.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function authoredWorkbookEvalLocalDiagnosticText(text: string): AuthoredWorkbookEvalLocalDiagnosticText {
  return deepFreeze({ __authoredWorkbookEvalLocalDiagnosticText: "local-diagnostic-only", text: boundedTextForWrite(text, MAX_DIAGNOSTIC_TEXT_BYTES, "local diagnostic") } as AuthoredWorkbookEvalLocalDiagnosticText);
}

export async function writeAuthoredWorkbookEvalGateDiagnostic(directory: string, gate: AuthoredWorkbookEvalGateResult, writeText: (path: string, data: string) => Promise<void> = atomicWriteText): Promise<AuthoredWorkbookEvalDiagnosticWriteStatus> {
  try {
    await writeText(join(directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate), boundedTextForWrite(`${JSON.stringify(gate, null, 2)}\n`, MAX_DIAGNOSTIC_TEXT_BYTES, "gate diagnostic"));
    return "written";
  } catch {
    return "write-failed";
  }
}

export async function writeAuthoredWorkbookEvalFailureDiagnostic(directory: string, diagnostic: AuthoredWorkbookEvalLocalDiagnosticText, writeText: (path: string, data: string) => Promise<void> = atomicWriteText): Promise<AuthoredWorkbookEvalDiagnosticWriteStatus> {
  try {
    await writeText(join(directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.failure), boundedTextForWrite(diagnostic.text, MAX_DIAGNOSTIC_TEXT_BYTES, "failure diagnostic"));
    return "written";
  } catch {
    return "write-failed";
  }
}

export async function writeAuthoredWorkbookEvalCleanupFailureDiagnostic(directory: string, diagnostic: AuthoredWorkbookEvalLocalDiagnosticText, writeText: (path: string, data: string) => Promise<void> = atomicWriteText): Promise<AuthoredWorkbookEvalDiagnosticWriteStatus> {
  try {
    await writeText(join(directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.cleanupFailure), boundedTextForWrite(diagnostic.text, MAX_DIAGNOSTIC_TEXT_BYTES, "cleanup diagnostic"));
    return "written";
  } catch {
    return "write-failed";
  }
}

function validRepetition(value: number): 1 | 2 | 3 {
  if (!Number.isInteger(value) || value < 1 || value > 3) throw new Error("Authored workbook eval repetition must be 1, 2, or 3.");
  return value as 1 | 2 | 3;
}

function safeRelativeReportDirectory(value: unknown): string {
  const directory = boundedString(value, "authored workbook latest report directory", 140);
  if (isAbsolute(directory) || directory.includes(":") || directory.includes("\\") || directory.includes("//")) throw new Error("Invalid authored workbook latest report directory.");
  const parts = directory.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Invalid authored workbook latest report directory.");
  if (parts.length === 1) return safeRunId(parts[0]);
  if (parts.length === 2 && parts[0] === "runs") return `runs/${safeRunId(parts[1])}`;
  throw new Error("Invalid authored workbook latest report directory.");
}

function copyLifecycleVerdictForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus, value: unknown, mode: AuthoredWorkbookEvalEvaluationMode): AuthoredWorkbookEvalLifecycleVerdict {
  const checkedMode = validEvaluationMode(mode);
  if (status !== "completed") {
    const exact = notJudgedVerdict();
    if (!isPlainRecord(value)) throw new Error("Invalid authored workbook latest verdict.");
    assertExactKeys(value, ["passed", "percentage", "rule"], "authored workbook latest verdict");
    if (value.passed !== exact.passed || value.percentage !== exact.percentage || value.rule !== exact.rule) throw new Error("Invalid authored workbook latest verdict.");
    return exact;
  }
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook latest verdict.");
  if (checkedMode === "deterministic-only") {
    const exact = deterministicSuccessVerdict();
    assertExactKeys(value, ["passed", "rule"], "authored workbook latest verdict");
    if (value.passed !== exact.passed || value.rule !== exact.rule) throw new Error("Invalid authored workbook latest verdict.");
    return exact;
  }
  assertExactKeys(value, ["passed", "percentage", "rule"], "authored workbook latest verdict");
  if (typeof value.passed !== "boolean") throw new Error("Invalid authored workbook latest verdict.");
  if (typeof value.percentage !== "number" || !Number.isFinite(value.percentage) || value.percentage < 0 || value.percentage > 1) throw new Error("Invalid authored workbook latest verdict.");
  if (value.rule !== "all-criteria-positive-and-aggregate-at-least-80-percent") throw new Error("Invalid authored workbook latest verdict.");
  if (value.passed && value.percentage < 0.8) throw new Error("Invalid authored workbook latest verdict.");
  if (!value.passed && value.percentage === 1) throw new Error("Invalid authored workbook latest verdict.");
  return deepFreeze({ passed: value.passed, percentage: value.percentage, rule: value.rule });
}

function validRunStatus(value: unknown): AuthoredWorkbookEvalRunLifecycleStatus {
  if (!AUTHORED_WORKBOOK_RUN_STATUSES.includes(value as AuthoredWorkbookEvalRunLifecycleStatus)) throw new Error("Invalid authored workbook run status.");
  return value as AuthoredWorkbookEvalRunLifecycleStatus;
}

function validFailureStatus(value: unknown): Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed"> {
  const status = validRunStatus(value);
  if (status === "completed") throw new Error("Invalid authored workbook failure run status.");
  return status;
}

function copyLatestRunEntry(value: unknown, scenarioIds: Set<string>, repeat: 1 | 2 | 3): AuthoredWorkbookEvalLatestRunEntry {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook latest run entry.");
  assertExactKeys(value, ["namespace", "owner", "suite", "schemaVersion", "scenario", "repetition", "status", "evaluationMode", "verdict", "reportDirectory", "files"], "authored workbook latest run entry");
  if (value.namespace !== AUTHORED_WORKBOOK_EVAL_MARKERS.namespace || value.owner !== AUTHORED_WORKBOOK_EVAL_MARKERS.owner || value.suite !== AUTHORED_WORKBOOK_EVAL_MARKERS.suite || value.schemaVersion !== AUTHORED_WORKBOOK_EVAL_MARKERS.schemaVersion) throw new Error("Invalid authored workbook latest run markers.");
  if (typeof value.scenario !== "string") throw new Error("Invalid authored workbook scenario id.");
  const scenario = safeScenarioId(value.scenario);
  if (!scenarioIds.has(scenario)) throw new Error("Authored workbook latest contains a run for an unknown scenario.");
  if (typeof value.repetition !== "number") throw new Error("Authored workbook eval repetition must be 1, 2, or 3.");
  const repetition = validRepetition(value.repetition);
  if (repetition > repeat) throw new Error("Authored workbook latest contains a repetition outside the invocation repeat.");
  const status = validRunStatus(value.status);
  const evaluationMode = validEvaluationMode(value.evaluationMode);
  assertScenarioAllowsEvaluationMode(scenario, evaluationMode);
  if (evaluationMode === "deterministic-only" && status === "judge") throw new Error("Invalid authored workbook deterministic-only latest entry.");
  return deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    scenario,
    repetition,
    status,
    evaluationMode,
    verdict: copyLifecycleVerdictForStatus(status, value.verdict, evaluationMode),
    reportDirectory: safeRelativeReportDirectory(value.reportDirectory),
    files: copyExactCuratedFilesForStatus(status, value.files, evaluationMode)
  } as AuthoredWorkbookEvalLatestRunEntry);
}

export function createAuthoredWorkbookEvalLatestRunEntry(options: Omit<AuthoredWorkbookEvalLatestRunEntry, keyof AuthoredWorkbookEvalMarkers>): AuthoredWorkbookEvalLatestRunEntry {
  const scenario = safeScenarioId(options.scenario);
  const status = validRunStatus(options.status);
  const evaluationMode = validEvaluationMode(options.evaluationMode);
  assertScenarioAllowsEvaluationMode(scenario, evaluationMode);
  if (evaluationMode === "deterministic-only" && status === "judge") throw new Error("Invalid authored workbook deterministic-only latest entry.");
  return deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    scenario,
    repetition: validRepetition(options.repetition),
    status,
    evaluationMode,
    verdict: copyLifecycleVerdictForStatus(status, options.verdict, evaluationMode),
    reportDirectory: safeRelativeReportDirectory(options.reportDirectory),
    files: copyExactCuratedFilesForStatus(status, options.files, evaluationMode)
  } as AuthoredWorkbookEvalLatestRunEntry);
}

export function createAuthoredWorkbookEvalLatestEnvelope(options: CreateAuthoredWorkbookEvalLatestEnvelopeOptions): AuthoredWorkbookEvalLatestEnvelope {
  const repeat = validRepetition(options.invocation.repeat);
  if (!["scenario", "all", "release"].includes(options.invocation.scope)) throw new Error("Invalid authored workbook eval invocation scope.");
  if (options.invocation.scope === "release" && repeat !== 1) throw new Error("Authored workbook eval release scope always has repeat 1.");
  const scenarioIds = options.invocation.scenarioIds.map(safeScenarioId);
  if (scenarioIds.length === 0) throw new Error("Authored workbook latest requires at least one scenario id.");
  if (new Set(scenarioIds).size !== scenarioIds.length) throw new Error("Authored workbook latest scenario ids must be unique.");
  const scenarioSet = new Set(scenarioIds);
  const seen = new Set<string>();
  const seenReportDirectories = new Set<string>();
  const runs = options.runs.map((run) => {
    const copied = copyLatestRunEntry(run, scenarioSet, repeat);
    const key = `${copied.scenario}:${copied.repetition}`;
    if (seen.has(key)) throw new Error("Authored workbook latest contains duplicate run entries.");
    if (seenReportDirectories.has(copied.reportDirectory)) throw new Error("Authored workbook latest contains duplicate report directories.");
    seen.add(key);
    seenReportDirectories.add(copied.reportDirectory);
    return copied;
  });
  const generatedAt = options.generatedAt === undefined ? new Date().toISOString() : boundedString(options.generatedAt, "authored workbook latest timestamp", 64);
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("Invalid authored workbook latest timestamp.");
  const envelope: AuthoredWorkbookEvalLatestEnvelope = {
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    generatedAt,
    invocation: { scope: options.invocation.scope, scenarioIds, repeat },
    runs
  };
  return deepFreeze(envelope);
}

export async function writeAuthoredWorkbookEvalLatestEnvelope(reportsRoot: string, envelope: AuthoredWorkbookEvalLatestEnvelope, writeText: (path: string, data: string) => Promise<void> = atomicWriteText): Promise<{ file: typeof AUTHORED_WORKBOOK_LATEST_FILENAME }> {
  try {
    await mkdir(resolve(reportsRoot), { recursive: true, mode: 0o700 });
    await chmod(resolve(reportsRoot), 0o700);
    const rootReal = await canonicalReportsRoot(reportsRoot);
    const checked = createAuthoredWorkbookEvalLatestEnvelope({ generatedAt: envelope.generatedAt, invocation: envelope.invocation, runs: envelope.runs });
    const snapshots = await validateLatestRunSnapshots(rootReal, checked.runs);
    const revalidate = () => assertLatestRunSnapshotsUnchanged(rootReal, checked.runs, snapshots);
    await revalidate();
    const data = boundedTextForWrite(jsonEnvelope(checked), MAX_CURATED_TEXT_BYTES, AUTHORED_WORKBOOK_LATEST_FILENAME);
    await replaceLatestPreservingPrevious(rootReal, data, writeText, revalidate);
    return deepFreeze({ file: AUTHORED_WORKBOOK_LATEST_FILENAME });
  } catch {
    throw new Error(REPORT_FS_LATEST_ERROR_MESSAGE);
  }
}

export function authoredWorkbookEvalStatusAfterCleanup(options: { status: AuthoredWorkbookEvalRunLifecycleStatus; verdict: AuthoredWorkbookEvalLifecycleVerdict; cleanupFailed: boolean; evaluationMode?: AuthoredWorkbookEvalEvaluationMode }): { status: AuthoredWorkbookEvalRunLifecycleStatus; verdict: AuthoredWorkbookEvalLifecycleVerdict } {
  const status = validRunStatus(options.status);
  const mode = options.evaluationMode ?? "judged";
  const verdict = copyLifecycleVerdictForStatus(status, options.verdict, mode);
  if (!options.cleanupFailed) return deepFreeze({ status, verdict });
  if (status === "completed") return deepFreeze({ status: "cleanup" as const, verdict: notJudgedVerdict() });
  return deepFreeze({ status, verdict });
}

export function authoredWorkbookEvalStabilityPassed(runs: readonly ({ passed: boolean } | { verdict: { passed: boolean } })[]): boolean {
  const total = runs.length;
  if (total < 1 || total > 3) throw new Error("Authored workbook eval stability aggregation supports 1, 2, or 3 runs.");
  const passes = runs.filter((run) => "verdict" in run ? run.verdict.passed : run.passed).length;
  if (total === 1) return passes === 1;
  if (total === 2) return passes === 2;
  return passes >= 2;
}

export const AUTHORED_WORKBOOK_RELEASE_REPEAT = 1 as const;
