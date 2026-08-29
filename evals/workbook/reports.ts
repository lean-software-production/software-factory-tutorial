import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MODEL_IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+ -]{0,127}$/;

export const AUTHORED_WORKBOOK_REPORT_FILENAMES = Object.freeze({
  trace: "trace.json",
  judgeInput: "judge-input.txt",
  judge: "judge.json",
  report: "report.json",
  summary: "summary.md",
  metadata: "metadata.json"
});

export const AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES = Object.freeze({
  gate: "gate.json",
  failure: "failure.txt",
  cleanupFailure: "cleanup-failure.txt"
});

export interface AuthoredWorkbookEvalModelIdentity {
  requested: string;
  selected: string;
}

export interface AuthoredWorkbookEvalModelIdentities {
  mainTutor: AuthoredWorkbookEvalModelIdentity;
  practiceCoach: AuthoredWorkbookEvalModelIdentity;
  judge: AuthoredWorkbookEvalModelIdentity;
}

export interface AuthoredWorkbookTraceEnvelope extends AuthoredWorkbookEvalMarkers {
  trace: AuthoredWorkbookEvalTrace;
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

export interface AuthoredWorkbookMetadataEnvelope extends AuthoredWorkbookEvalMarkers {
  runId: string;
  scenario: string;
  status: "passed" | "failed";
  modelIdentities: AuthoredWorkbookEvalModelIdentities;
  files: typeof AUTHORED_WORKBOOK_REPORT_FILENAMES;
  diagnosticStatus: {
    gate: "not-written" | "written" | "write-failed";
    failure: "not-written" | "written" | "write-failed";
    cleanupFailure: "not-written" | "written" | "write-failed";
  };
}

export interface AuthoredWorkbookReportBundleObjects {
  traceEnvelope: AuthoredWorkbookTraceEnvelope;
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
  modelIdentities: AuthoredWorkbookEvalModelIdentities;
  diagnosticStatus?: Partial<AuthoredWorkbookMetadataEnvelope["diagnosticStatus"]>;
}

export interface WriteAuthoredWorkbookReportBundleOptions extends CreateAuthoredWorkbookReportOptions {
  reportsRoot: string;
  writeText?: (path: string, data: string) => Promise<void>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId) || runId.includes("..")) throw new Error("Invalid authored workbook report run id.");
  return runId;
}

function boundedModelIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODEL_IDENTITY_PATTERN.test(value)) throw new Error(`Invalid ${label} model identity.`);
  return value;
}

export function copyAuthoredWorkbookEvalModelIdentities(value: unknown): AuthoredWorkbookEvalModelIdentities {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook model identities.");
  const copyRole = (role: "mainTutor" | "practiceCoach" | "judge"): AuthoredWorkbookEvalModelIdentity => {
    const raw = value[role];
    if (!isPlainRecord(raw)) throw new Error("Invalid authored workbook model identities.");
    return {
      requested: boundedModelIdentity(raw.requested, `${role} requested`),
      selected: boundedModelIdentity(raw.selected, `${role} selected`)
    };
  };
  return { mainTutor: copyRole("mainTutor"), practiceCoach: copyRole("practiceCoach"), judge: copyRole("judge") };
}

function withDefaultDiagnosticStatus(value: Partial<AuthoredWorkbookMetadataEnvelope["diagnosticStatus"]> | undefined): AuthoredWorkbookMetadataEnvelope["diagnosticStatus"] {
  return {
    gate: value?.gate ?? "not-written",
    failure: value?.failure ?? "not-written",
    cleanupFailure: value?.cleanupFailure ?? "not-written"
  };
}

function jsonEnvelope(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function boundedTextForWrite(text: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${label} exceeds the authored workbook report write limit.`);
  return text;
}

export function createAuthoredWorkbookEvalReportBundleObjects(options: CreateAuthoredWorkbookReportOptions): AuthoredWorkbookReportBundleObjects {
  const runId = safeRunId(options.runId);
  const scenario = copyAuthoredWorkbookEvalScenarioPublicDescriptor(options.scenario);
  const trace = copyAuthoredWorkbookEvalTrace(options.trace);
  const publicGate = projectAuthoredWorkbookGateForPublicReport(options.gate);
  if (!publicGate.passed) throw new Error("Cannot create an authored workbook judge report when the deterministic gate failed.");
  const expectedJudgeInput = buildAuthoredWorkbookJudgePrompt(scenario, trace, options.gate);
  if (options.judgeInput !== expectedJudgeInput) throw new Error("Judge input does not match the sanitized authored workbook judge prompt.");
  const judge = verifyAuthoredWorkbookJudgeResult(options.judge, scenario, trace);
  const verdict = authoredWorkbookJudgeVerdict(judge);
  const modelIdentities = copyAuthoredWorkbookEvalModelIdentities(options.modelIdentities);
  const traceEnvelope: AuthoredWorkbookTraceEnvelope = { ...AUTHORED_WORKBOOK_EVAL_MARKERS, trace };
  const judgeEnvelope: AuthoredWorkbookJudgeEnvelope = { ...AUTHORED_WORKBOOK_EVAL_MARKERS, judge, verdict };
  const report: AuthoredWorkbookReportEnvelope = {
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
  };
  const summary = renderAuthoredWorkbookSummary({ scenario, judge, verdict, gate: publicGate });
  const metadata: AuthoredWorkbookMetadataEnvelope = {
    ...AUTHORED_WORKBOOK_EVAL_MARKERS,
    runId,
    scenario: scenario.id,
    status: verdict.passed ? "passed" : "failed",
    modelIdentities,
    files: AUTHORED_WORKBOOK_REPORT_FILENAMES,
    diagnosticStatus: withDefaultDiagnosticStatus(options.diagnosticStatus)
  };
  return { traceEnvelope, judgeInput: expectedJudgeInput, judgeEnvelope, report, summary, metadata };
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
  const directory = join(options.reportsRoot, runId);
  const writeText = options.writeText ?? atomicWriteText;
  const objects = createAuthoredWorkbookEvalReportBundleObjects({ ...options, runId });
  await mkdir(directory, { recursive: true });
  const writes: Array<[string, string]> = [
    [AUTHORED_WORKBOOK_REPORT_FILENAMES.trace, jsonEnvelope(objects.traceEnvelope)],
    [AUTHORED_WORKBOOK_REPORT_FILENAMES.judgeInput, objects.judgeInput],
    [AUTHORED_WORKBOOK_REPORT_FILENAMES.judge, jsonEnvelope(objects.judgeEnvelope)],
    [AUTHORED_WORKBOOK_REPORT_FILENAMES.report, jsonEnvelope(objects.report)],
    [AUTHORED_WORKBOOK_REPORT_FILENAMES.summary, objects.summary],
    [AUTHORED_WORKBOOK_REPORT_FILENAMES.metadata, jsonEnvelope(objects.metadata)]
  ];
  for (const [file, text] of writes) await writeText(join(directory, file), boundedTextForWrite(text, MAX_CURATED_TEXT_BYTES, file));
  return { directory, files: AUTHORED_WORKBOOK_REPORT_FILENAMES };
}

export async function atomicWriteText(path: string, data: string): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, data, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAuthoredWorkbookEvalGateDiagnostic(directory: string, gate: AuthoredWorkbookEvalGateResult, writeText: (path: string, data: string) => Promise<void> = atomicWriteText): Promise<"written" | "write-failed"> {
  try {
    await writeText(join(directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.gate), boundedTextForWrite(jsonEnvelope(gate), MAX_DIAGNOSTIC_TEXT_BYTES, "gate diagnostic"));
    return "written";
  } catch {
    return "write-failed";
  }
}

export async function writeAuthoredWorkbookEvalFailureDiagnostic(directory: string, text: string, writeText: (path: string, data: string) => Promise<void> = atomicWriteText): Promise<"written" | "write-failed"> {
  try {
    await writeText(join(directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.failure), boundedTextForWrite(text, MAX_DIAGNOSTIC_TEXT_BYTES, "failure diagnostic"));
    return "written";
  } catch {
    return "write-failed";
  }
}

export async function writeAuthoredWorkbookEvalCleanupFailureDiagnostic(directory: string, text: string, writeText: (path: string, data: string) => Promise<void> = atomicWriteText): Promise<"written" | "write-failed"> {
  try {
    await writeText(join(directory, AUTHORED_WORKBOOK_LOCAL_DIAGNOSTIC_FILENAMES.cleanupFailure), boundedTextForWrite(text, MAX_DIAGNOSTIC_TEXT_BYTES, "cleanup diagnostic"));
    return "written";
  } catch {
    return "write-failed";
  }
}
