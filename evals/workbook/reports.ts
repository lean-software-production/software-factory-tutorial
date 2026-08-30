import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AUTHORED_WORKBOOK_EVAL_MARKERS, type AuthoredWorkbookEvalMarkers } from "./types.js";
import { copyAuthoredWorkbookEvalTrace, type AuthoredWorkbookEvalTrace } from "./public-trace.js";
import {
  authoredWorkbookJudgeVerdict,
  buildAuthoredWorkbookJudgePrompt,
  copyAuthoredWorkbookEvalScenarioPublicDescriptor,
  projectAuthoredWorkbookGateForPublicReport,
  verifyAuthoredWorkbookJudgeResult,
  type AuthoredWorkbookEvalGateResult,
  type AuthoredWorkbookEvalJudgeResult,
  type AuthoredWorkbookEvalPublicGateResult,
  type AuthoredWorkbookEvalScenarioPublicDescriptor,
  type AuthoredWorkbookEvalVerdict
} from "./judge.js";

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

export const AUTHORED_WORKBOOK_LATEST_FILENAME = "latest.json" as const;

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

export interface AuthoredWorkbookEvalModelIdentity {
  requested: string;
  selected: string;
}

export interface AuthoredWorkbookEvalModelIdentities {
  "Main Tutor": AuthoredWorkbookEvalModelIdentity;
  Judge: AuthoredWorkbookEvalModelIdentity;
}

export interface AuthoredWorkbookTraceEnvelope extends AuthoredWorkbookEvalMarkers {
  trace: AuthoredWorkbookEvalTrace;
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

export interface AuthoredWorkbookReportEnvelope extends AuthoredWorkbookEvalMarkers {
  runId: string;
  scenario: AuthoredWorkbookEvalScenarioPublicDescriptor;
  modelIdentities: AuthoredWorkbookEvalModelIdentities;
  gate: AuthoredWorkbookEvalPublicGateResult;
  verdict: AuthoredWorkbookEvalVerdict;
  files: {
    trace: typeof AUTHORED_WORKBOOK_REPORT_FILENAMES.trace;
    judgeInput: typeof AUTHORED_WORKBOOK_REPORT_FILENAMES.judgeInput;
    judge: typeof AUTHORED_WORKBOOK_REPORT_FILENAMES.judge;
  };
}

export interface AuthoredWorkbookEvalLifecycle {
  setup: "not-started" | "completed" | "failed";
  session: "not-started" | "completed" | "failed" | "interrupted";
  gate: "not-run" | "passed" | "failed";
  judge: "not-run" | "input-written" | "completed" | "failed";
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

export type AuthoredWorkbookCuratedFiles = Partial<typeof AUTHORED_WORKBOOK_REPORT_FILENAMES>;

export interface AuthoredWorkbookMetadataEnvelope extends AuthoredWorkbookEvalMarkers {
  runId: string;
  scenario: string;
  repetition: number;
  status: AuthoredWorkbookEvalRunLifecycleStatus;
  outcome: AuthoredWorkbookEvalRunOutcome;
  verdict: AuthoredWorkbookEvalLifecycleVerdict;
  modelIdentities: AuthoredWorkbookEvalModelIdentities;
  lifecycle: AuthoredWorkbookEvalLifecycle;
  files: AuthoredWorkbookCuratedFiles;
  failure?: AuthoredWorkbookEvalFailureSummary;
}

export interface AuthoredWorkbookEvalLifecycleVerdict {
  passed: boolean;
  percentage?: number;
  rule: AuthoredWorkbookEvalVerdict["rule"] | "not-judged";
}

export interface AuthoredWorkbookReportBundleObjects {
  traceEnvelope: AuthoredWorkbookTraceEnvelope;
  judgeInputEnvelope: AuthoredWorkbookJudgeInputEnvelope;
  judgeInput: string;
  judgeEnvelope: AuthoredWorkbookJudgeEnvelope;
  report: AuthoredWorkbookReportEnvelope;
  summary: string;
  metadata: AuthoredWorkbookMetadataEnvelope;
}

export interface CreateAuthoredWorkbookReportOptions {
  runId: string;
  scenario: AuthoredWorkbookEvalScenarioPublicDescriptor;
  trace: AuthoredWorkbookEvalTrace;
  gate: AuthoredWorkbookEvalGateResult;
  judgeInput: string;
  judge: AuthoredWorkbookEvalJudgeResult;
  modelIdentities: AuthoredWorkbookEvalModelIdentities | Record<string, unknown>;
  repetition?: number;
}

export interface WriteAuthoredWorkbookReportBundleOptions extends CreateAuthoredWorkbookReportOptions {
  reportsRoot: string;
  writeText?: (path: string, data: string) => Promise<void>;
}

export interface CreateAuthoredWorkbookFailureMetadataOptions {
  runId: string;
  scenarioId: string;
  repetition?: number;
  status: Exclude<AuthoredWorkbookEvalRunLifecycleStatus, "completed">;
  modelIdentities: AuthoredWorkbookEvalModelIdentities | Record<string, unknown>;
}

export interface WriteAuthoredWorkbookFailureMetadataOptions extends CreateAuthoredWorkbookFailureMetadataOptions {
  reportsRoot: string;
  writeText?: (path: string, data: string) => Promise<void>;
}

export interface AuthoredWorkbookEvalLatestRunEntry extends AuthoredWorkbookEvalMarkers {
  scenario: string;
  repetition: number;
  status: AuthoredWorkbookEvalRunLifecycleStatus;
  verdict: AuthoredWorkbookEvalLifecycleVerdict;
  reportDirectory: string;
  files: AuthoredWorkbookCuratedFiles;
}

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

function modelRole(value: Record<string, unknown>, canonical: keyof AuthoredWorkbookEvalModelIdentities, legacy: "mainTutor" | "judge"): AuthoredWorkbookEvalModelIdentity {
  const raw = value[canonical] ?? value[legacy];
  if (!isPlainRecord(raw)) throw new Error("Invalid authored workbook model identities.");
  return {
    requested: boundedModelIdentity(raw.requested, `${canonical} requested`),
    selected: boundedModelIdentity(raw.selected, `${canonical} selected`)
  };
}

export function copyAuthoredWorkbookEvalModelIdentities(value: unknown): AuthoredWorkbookEvalModelIdentities {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook model identities.");
  return deepFreeze({
    "Main Tutor": modelRole(value, "Main Tutor", "mainTutor"),
    Judge: modelRole(value, "Judge", "judge")
  });
}

export function defaultAuthoredWorkbookEvalLifecycle(status: AuthoredWorkbookEvalRunLifecycleStatus): AuthoredWorkbookEvalLifecycle {
  const checkedStatus = validRunStatus(status);
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
  switch (checkedStatus) {
    case "setup": lifecycle.setup = "failed"; break;
    case "session": lifecycle.setup = "completed"; lifecycle.session = "failed"; break;
    case "gate": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "failed"; break;
    case "judge": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = "failed"; break;
    case "report": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = "completed"; lifecycle.report = "failed"; break;
    case "cleanup": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = "completed"; lifecycle.report = "written"; lifecycle.cleanup = "failed"; break;
    case "interrupted": lifecycle.session = "interrupted"; break;
    case "completed": lifecycle.setup = "completed"; lifecycle.session = "completed"; lifecycle.gate = "passed"; lifecycle.judge = "completed"; lifecycle.report = "written"; lifecycle.cleanup = "completed"; break;
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

function verdictFromJudge(verdict: AuthoredWorkbookEvalVerdict): AuthoredWorkbookEvalLifecycleVerdict {
  return deepFreeze({ passed: verdict.passed, percentage: verdict.percentage, rule: verdict.rule });
}

function notJudgedVerdict(): AuthoredWorkbookEvalLifecycleVerdict {
  return deepFreeze({ passed: false, percentage: 0, rule: "not-judged" as const });
}

function successFiles(): typeof AUTHORED_WORKBOOK_REPORT_FILENAMES {
  return deepFreeze({ ...AUTHORED_WORKBOOK_REPORT_FILENAMES });
}

function metadataOnlyFiles(): Pick<typeof AUTHORED_WORKBOOK_REPORT_FILENAMES, "metadata"> {
  return deepFreeze({ metadata: AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata });
}

function curatedFilesForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus): AuthoredWorkbookCuratedFiles {
  return status === "completed" ? successFiles() : metadataOnlyFiles();
}

function copyExactCuratedFilesForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus, files: unknown): AuthoredWorkbookCuratedFiles {
  if (!isPlainRecord(files)) throw new Error("Invalid authored workbook curated files.");
  const expected = curatedFilesForStatus(status) as Record<string, string>;
  assertExactKeys(files, Object.keys(expected), "authored workbook curated files");
  for (const [key, value] of Object.entries(expected)) if (files[key] !== value) throw new Error("Invalid authored workbook curated files.");
  return deepFreeze({ ...expected } as AuthoredWorkbookCuratedFiles);
}

function copyStrictAuthoredWorkbookEvalModelIdentities(value: unknown): AuthoredWorkbookEvalModelIdentities {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook model identities.");
  assertExactKeys(value, ["Main Tutor", "Judge"], "authored workbook model identities");
  const role = (canonical: keyof AuthoredWorkbookEvalModelIdentities): AuthoredWorkbookEvalModelIdentity => {
    const raw = value[canonical];
    if (!isPlainRecord(raw)) throw new Error("Invalid authored workbook model identities.");
    assertExactKeys(raw, ["requested", "selected"], "authored workbook model identity");
    return {
      requested: boundedModelIdentity(raw.requested, `${canonical} requested`),
      selected: boundedModelIdentity(raw.selected, `${canonical} selected`)
    };
  };
  return deepFreeze({
    "Main Tutor": role("Main Tutor"),
    Judge: role("Judge")
  });
}

function copyExactLifecycleForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus, value: unknown): AuthoredWorkbookEvalLifecycle {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook eval lifecycle.");
  const expected = defaultAuthoredWorkbookEvalLifecycle(status) as unknown as Record<string, string>;
  assertExactKeys(value, Object.keys(expected), "authored workbook eval lifecycle");
  for (const [key, expectedValue] of Object.entries(expected)) if (value[key] !== expectedValue) throw new Error("Invalid authored workbook eval lifecycle.");
  return defaultAuthoredWorkbookEvalLifecycle(status);
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

function copyStrictAuthoredWorkbookMetadataEnvelope(value: unknown): AuthoredWorkbookMetadataEnvelope {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook metadata.");
  if (value.namespace !== AUTHORED_WORKBOOK_EVAL_MARKERS.namespace || value.owner !== AUTHORED_WORKBOOK_EVAL_MARKERS.owner || value.suite !== AUTHORED_WORKBOOK_EVAL_MARKERS.suite || value.schemaVersion !== AUTHORED_WORKBOOK_EVAL_MARKERS.schemaVersion) throw new Error("Invalid authored workbook metadata markers.");
  const status = validRunStatus(value.status);
  const expectedKeys = ["namespace", "owner", "suite", "schemaVersion", "runId", "scenario", "repetition", "status", "outcome", "verdict", "modelIdentities", "lifecycle", "files"];
  assertExactKeys(value, status === "completed" ? expectedKeys : [...expectedKeys, "failure"], "authored workbook metadata");
  const verdict = copyLifecycleVerdictForStatus(status, value.verdict);
  const outcome = expectedOutcomeForStatusAndVerdict(status, verdict);
  if (value.outcome !== outcome) throw new Error("Invalid authored workbook metadata outcome.");
  const envelope: AuthoredWorkbookMetadataEnvelope = {
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId: safeRunId(value.runId),
    scenario: safeScenarioId(value.scenario),
    repetition: validRepetition(value.repetition as number),
    status,
    outcome,
    verdict,
    modelIdentities: copyStrictAuthoredWorkbookEvalModelIdentities(value.modelIdentities),
    lifecycle: copyExactLifecycleForStatus(status, value.lifecycle),
    files: copyExactCuratedFilesForStatus(status, value.files)
  };
  if (status !== "completed") envelope.failure = copyExactFailureSummaryForStatus(status, value.failure);
  return deepFreeze(envelope);
}

export function createAuthoredWorkbookEvalReportBundleObjects(options: CreateAuthoredWorkbookReportOptions): AuthoredWorkbookReportBundleObjects {
  const runId = safeRunId(options.runId);
  const repetition = validRepetition(options.repetition ?? 1);
  const scenario = copyAuthoredWorkbookEvalScenarioPublicDescriptor(options.scenario);
  const trace = copyAuthoredWorkbookEvalTrace(options.trace);
  const publicGate = projectAuthoredWorkbookGateForPublicReport(options.gate);
  if (!publicGate.passed) throw new Error("Cannot create an authored workbook judge report when the deterministic gate failed.");
  const expectedJudgeInput = buildAuthoredWorkbookJudgePrompt(scenario, trace, options.gate);
  if (options.judgeInput !== expectedJudgeInput) throw new Error("Judge input does not match the sanitized authored workbook judge prompt.");
  const judge = verifyAuthoredWorkbookJudgeResult(options.judge, scenario, trace);
  const verdict = authoredWorkbookJudgeVerdict(judge);
  const modelIdentities = copyAuthoredWorkbookEvalModelIdentities(options.modelIdentities);
  const traceEnvelope: AuthoredWorkbookTraceEnvelope = deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, trace });
  const judgeInputEnvelope: AuthoredWorkbookJudgeInputEnvelope = deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, scenario: scenario.id, traceFile: AUTHORED_WORKBOOK_REPORT_FILENAMES.trace, prompt: expectedJudgeInput });
  const judgeEnvelope: AuthoredWorkbookJudgeEnvelope = deepFreeze({ ...AUTHORED_WORKBOOK_EVAL_MARKERS, judge, verdict });
  const report: AuthoredWorkbookReportEnvelope = deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId,
    scenario,
    modelIdentities,
    gate: publicGate,
    verdict,
    files: {
      trace: AUTHORED_WORKBOOK_REPORT_FILENAMES.trace,
      judgeInput: AUTHORED_WORKBOOK_REPORT_FILENAMES.judgeInput,
      judge: AUTHORED_WORKBOOK_REPORT_FILENAMES.judge
    }
  });
  const summary = renderAuthoredWorkbookSummary({ scenario, judge, verdict, gate: publicGate });
  const metadata: AuthoredWorkbookMetadataEnvelope = deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId,
    scenario: scenario.id,
    repetition,
    status: "completed",
    outcome: verdict.passed ? "passed" : "failed",
    verdict: verdictFromJudge(verdict),
    modelIdentities,
    lifecycle: defaultAuthoredWorkbookEvalLifecycle("completed"),
    files: successFiles()
  });
  return deepFreeze({ traceEnvelope, judgeInputEnvelope, judgeInput: expectedJudgeInput, judgeEnvelope, report, summary, metadata });
}

export function createAuthoredWorkbookEvalFailureMetadataEnvelope(options: CreateAuthoredWorkbookFailureMetadataOptions): AuthoredWorkbookMetadataEnvelope {
  const status = validFailureStatus(options.status);
  const outcome: AuthoredWorkbookEvalRunOutcome = status === "interrupted" ? "interrupted" : "failed";
  const message = boundedTextForWrite(publicFailureMessage(status), 1024, "public failure message");
  const envelope: AuthoredWorkbookMetadataEnvelope = {
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId: safeRunId(options.runId),
    scenario: safeScenarioId(options.scenarioId),
    repetition: validRepetition(options.repetition ?? 1),
    status,
    outcome,
    verdict: notJudgedVerdict(),
    modelIdentities: copyAuthoredWorkbookEvalModelIdentities(options.modelIdentities),
    lifecycle: defaultAuthoredWorkbookEvalLifecycle(status),
    files: metadataOnlyFiles(),
    failure: { stage: status, message, diagnosticPolicy: "local-diagnostics-are-not-curated-or-advertised" }
  };
  return deepFreeze(envelope);
}

export function renderAuthoredWorkbookSummary(options: { scenario: AuthoredWorkbookEvalScenarioPublicDescriptor; judge: AuthoredWorkbookEvalJudgeResult; verdict: AuthoredWorkbookEvalVerdict; gate: AuthoredWorkbookEvalPublicGateResult }): string {
  const lines = [
    `# ${options.scenario.title}`,
    "",
    `Scenario: \`${options.scenario.id}\``,
    `Deterministic gate: **${options.gate.passed ? "pass" : "fail"}**`,
    `Judge verdict: **${Math.round(options.verdict.percentage * 100)}%** (${options.verdict.passed ? "pass" : "fail"})`,
    "",
    "## Criteria",
    ""
  ];
  for (const criterion of options.scenario.criteria) {
    const score = options.judge.criteria[criterion.id];
    lines.push(`- **${criterion.title}** (${criterion.id}): ${score?.score ?? 0}/2`);
  }
  lines.push("", "## Judge summary", "", options.judge.summary, "");
  return lines.join("\n");
}

export async function writeAuthoredWorkbookEvalReportBundle(options: WriteAuthoredWorkbookReportBundleOptions): Promise<{ directory: string; files: typeof AUTHORED_WORKBOOK_REPORT_FILENAMES }> {
  const runId = safeRunId(options.runId);
  const objects = createAuthoredWorkbookEvalReportBundleObjects({ ...options, runId });
  const writeText = options.writeText ?? atomicWriteText;
  let directory: string | undefined;
  try {
    directory = await createFreshAuthoredWorkbookEvalReportDirectory(options.reportsRoot, runId);
    const writes: Array<[string, string]> = [
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.trace, jsonEnvelope(objects.traceEnvelope)],
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.judgeInput, jsonEnvelope(objects.judgeInputEnvelope)],
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.judge, jsonEnvelope(objects.judgeEnvelope)],
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.report, jsonEnvelope(objects.report)],
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.summary, boundedTextForWrite(objects.summary, MAX_CURATED_TEXT_BYTES, "summary")],
      [AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata, jsonEnvelope(objects.metadata)]
    ];
    for (const [file, text] of writes) await writeText(join(directory, file), boundedTextForWrite(text, MAX_CURATED_TEXT_BYTES, file));
    await validateRunDirectoryFilesForStatus(resolve(options.reportsRoot), runId, "completed");
    return deepFreeze({ directory, files: successFiles() });
  } catch (error) {
    if (directory) {
      try { await removeFreshRunDirectoryAfterPartialWrite(options.reportsRoot, runId, directory); }
      catch (rollbackError) { throw sanitizeFsError(rollbackError, REPORT_FS_WRITE_ERROR_MESSAGE); }
    }
    throw sanitizeFsError(error, REPORT_FS_WRITE_ERROR_MESSAGE);
  }
}

export async function writeAuthoredWorkbookEvalFailureMetadata(options: WriteAuthoredWorkbookFailureMetadataOptions): Promise<{ directory: string; files: Pick<typeof AUTHORED_WORKBOOK_REPORT_FILENAMES, "metadata"> }> {
  const runId = safeRunId(options.runId);
  const metadata = createAuthoredWorkbookEvalFailureMetadataEnvelope({ ...options, runId });
  const writeText = options.writeText ?? atomicWriteText;
  let directory: string | undefined;
  try {
    directory = await createFreshAuthoredWorkbookEvalReportDirectory(options.reportsRoot, runId);
    await writeText(join(directory, AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata), boundedTextForWrite(jsonEnvelope(metadata), MAX_CURATED_TEXT_BYTES, AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata));
    await validateRunDirectoryFilesForStatus(resolve(options.reportsRoot), runId, metadata.status);
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

async function readStableMetadataJson(metadataPath: string): Promise<{ metadata: AuthoredWorkbookMetadataEnvelope; identity: StableFilesystemIdentity }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(metadataPath, constants.O_RDONLY | O_NOFOLLOW);
    const beforeStat = await handle.stat();
    assertOrdinarySingleLinkFileStat(beforeStat, "Authored workbook latest metadata must be an ordinary non-linked file.");
    if (beforeStat.size > MAX_CURATED_TEXT_BYTES) throw new Error("authored workbook metadata.json exceeds the authored workbook report length limit.");
    const beforeIdentity = stableFilesystemIdentity(beforeStat);
    const text = await readBoundedFileHandleText(handle, MAX_CURATED_TEXT_BYTES, "authored workbook metadata.json");
    const afterStat = await handle.stat();
    assertOrdinarySingleLinkFileStat(afterStat, "Authored workbook latest metadata must be an ordinary non-linked file.");
    const afterIdentity = stableFilesystemIdentity(afterStat);
    assertStableFilesystemIdentity(beforeIdentity, afterIdentity, "Authored workbook latest metadata changed during validation.");
    if (Buffer.byteLength(text, "utf8") !== afterStat.size) throw new Error("Authored workbook latest metadata changed during validation.");
    const pathStat = await lstat(metadataPath);
    assertOrdinarySingleLinkFileStat(pathStat, "Authored workbook latest metadata must be an ordinary non-linked file.");
    assertStableFilesystemIdentity(afterIdentity, stableFilesystemIdentity(pathStat), "Authored workbook latest metadata path changed during validation.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Invalid authored workbook metadata.");
    }
    return { metadata: copyStrictAuthoredWorkbookMetadataEnvelope(parsed), identity: afterIdentity };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateRunDirectoryFilesForStatus(reportsRoot: string, runDirectory: string, status: AuthoredWorkbookEvalRunLifecycleStatus): Promise<void> {
  const checkedStatus = validRunStatus(status);
  const rootReal = await canonicalReportsRoot(reportsRoot);
  const directory = await runDirectoryForRoot(rootReal, runDirectory);
  const expected = curatedFilesForStatus(checkedStatus);
  for (const file of Object.values(expected)) await assertOrdinarySingleLinkFile(join(directory, file), "Authored workbook report advertised file must be an ordinary non-linked file.");
  for (const file of Object.values(AUTHORED_WORKBOOK_REPORT_FILENAMES)) {
    if (Object.values(expected).includes(file)) continue;
    try {
      await lstat(join(directory, file));
      throw new Error("Authored workbook report directory contains unexpected curated files for its status.");
    } catch (error) {
      if (isNativeFsError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
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

function assertLatestEntryMatchesMetadata(entry: AuthoredWorkbookEvalLatestRunEntry, metadata: AuthoredWorkbookMetadataEnvelope): void {
  if (metadata.runId !== runIdFromReportDirectory(entry.reportDirectory)) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (metadata.scenario !== entry.scenario) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (metadata.repetition !== entry.repetition) throw new Error("Authored workbook latest metadata identity mismatch.");
  if (metadata.status !== entry.status) throw new Error("Authored workbook latest metadata identity mismatch.");
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
  const directory = await runDirectoryForRoot(rootReal, entry.reportDirectory);
  const directoryStat = await lstat(directory);
  const directoryIdentity = stableFilesystemIdentity(directoryStat);
  const expected = curatedFilesForStatus(entry.status);
  copyExactCuratedFilesForStatus(entry.status, entry.files);
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

function copyLifecycleVerdictForStatus(status: AuthoredWorkbookEvalRunLifecycleStatus, value: unknown): AuthoredWorkbookEvalLifecycleVerdict {
  if (status !== "completed") {
    const exact = notJudgedVerdict();
    if (!isPlainRecord(value)) throw new Error("Invalid authored workbook latest verdict.");
    assertExactKeys(value, ["passed", "percentage", "rule"], "authored workbook latest verdict");
    if (value.passed !== exact.passed || value.percentage !== exact.percentage || value.rule !== exact.rule) throw new Error("Invalid authored workbook latest verdict.");
    return exact;
  }
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook latest verdict.");
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
  assertExactKeys(value, ["namespace", "owner", "suite", "schemaVersion", "scenario", "repetition", "status", "verdict", "reportDirectory", "files"], "authored workbook latest run entry");
  if (value.namespace !== AUTHORED_WORKBOOK_EVAL_MARKERS.namespace || value.owner !== AUTHORED_WORKBOOK_EVAL_MARKERS.owner || value.suite !== AUTHORED_WORKBOOK_EVAL_MARKERS.suite || value.schemaVersion !== AUTHORED_WORKBOOK_EVAL_MARKERS.schemaVersion) throw new Error("Invalid authored workbook latest run markers.");
  if (typeof value.scenario !== "string") throw new Error("Invalid authored workbook scenario id.");
  const scenario = safeScenarioId(value.scenario);
  if (!scenarioIds.has(scenario)) throw new Error("Authored workbook latest contains a run for an unknown scenario.");
  if (typeof value.repetition !== "number") throw new Error("Authored workbook eval repetition must be 1, 2, or 3.");
  const repetition = validRepetition(value.repetition);
  if (repetition > repeat) throw new Error("Authored workbook latest contains a repetition outside the invocation repeat.");
  const status = validRunStatus(value.status);
  return deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    scenario,
    repetition,
    status,
    verdict: copyLifecycleVerdictForStatus(status, value.verdict),
    reportDirectory: safeRelativeReportDirectory(value.reportDirectory),
    files: copyExactCuratedFilesForStatus(status, value.files)
  });
}

export function createAuthoredWorkbookEvalLatestRunEntry(options: Omit<AuthoredWorkbookEvalLatestRunEntry, keyof AuthoredWorkbookEvalMarkers>): AuthoredWorkbookEvalLatestRunEntry {
  const scenario = safeScenarioId(options.scenario);
  const status = validRunStatus(options.status);
  return deepFreeze({
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    scenario,
    repetition: validRepetition(options.repetition),
    status,
    verdict: copyLifecycleVerdictForStatus(status, options.verdict),
    reportDirectory: safeRelativeReportDirectory(options.reportDirectory),
    files: copyExactCuratedFilesForStatus(status, options.files)
  });
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

export function authoredWorkbookEvalStatusAfterCleanup(options: { status: AuthoredWorkbookEvalRunLifecycleStatus; verdict: AuthoredWorkbookEvalLifecycleVerdict; cleanupFailed: boolean }): { status: AuthoredWorkbookEvalRunLifecycleStatus; verdict: AuthoredWorkbookEvalLifecycleVerdict } {
  const status = validRunStatus(options.status);
  const verdict = copyLifecycleVerdictForStatus(status, options.verdict);
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
