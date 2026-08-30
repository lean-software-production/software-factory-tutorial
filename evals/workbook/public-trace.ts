import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parsePublicWorkbookState, type PublicAttemptKind, type PublicWorkbookState } from "../../tutorial-engine/src/workbook/public-contract.js";
import type {
  AuthoredWorkbookEvalArtifactSnapshot,
  AuthoredWorkbookEvalCitation,
  AuthoredWorkbookEvalEditorEntry,
  AuthoredWorkbookEvalProgressionEvent,
  AuthoredWorkbookEvalRecordedPublicState,
  AuthoredWorkbookEvalReflectionEntry,
  AuthoredWorkbookEvalSessionTrace,
  AuthoredWorkbookEvalTerminalTranscriptEntry,
  AuthoredWorkbookEvalTrace
} from "./types.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_ARTIFACT_BYTES = 256 * 1024;
const DEFAULT_MAX_ARTIFACT_FILES = 50;
const MAX_PUBLIC_CHANNEL_TEXT_BYTES = 64 * 1024;
const KNOWN_EVENT_BEARING_FIELDS = ["events", "internalEvents", "progressionEvents"] as const;
const MAX_EVENT_BEARING_FIELD_EVENTS = 10_000;

export type {
  AuthoredWorkbookEvalArtifactSnapshot,
  AuthoredWorkbookEvalCitation,
  AuthoredWorkbookEvalEditorEntry,
  AuthoredWorkbookEvalProgressionEvent,
  AuthoredWorkbookEvalRecordedPublicState,
  AuthoredWorkbookEvalReflectionEntry,
  AuthoredWorkbookEvalSessionTrace,
  AuthoredWorkbookEvalTerminalTranscriptEntry,
  AuthoredWorkbookEvalTrace
} from "./types.js";

export interface AuthoredWorkbookEvalArtifactOptions {
  /** Explicit exact relative files to expose to the public evaluator. Directories are never recursed. */
  files: string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export function createEmptyAuthoredWorkbookEvalSessionTrace(scenarioId: string): AuthoredWorkbookEvalSessionTrace {
  return { scenarioId, publicStates: [], terminalTranscript: [], reflections: [], editors: [], internalEvents: [], artifacts: [] };
}

export function recordAuthoredWorkbookEvalPublicState(trace: AuthoredWorkbookEvalSessionTrace, label: string, state: PublicWorkbookState): AuthoredWorkbookEvalRecordedPublicState {
  const cloned = parsePublicWorkbookState(structuredClone(state) as unknown);
  const previous = trace.publicStates.at(-1);
  if (previous && JSON.stringify(previous.state) === JSON.stringify(cloned)) return previous;
  const recorded = { label: boundedText(label, "public state label"), state: cloned };
  trace.publicStates.push(recorded);
  return recorded;
}

export function recordAuthoredWorkbookEvalTerminalTranscript(trace: AuthoredWorkbookEvalSessionTrace, entry: AuthoredWorkbookEvalTerminalTranscriptEntry): AuthoredWorkbookEvalTerminalTranscriptEntry {
  const recorded = { blockId: entry.blockId, direction: entry.direction, text: boundedText(entry.text, "terminal transcript"), ...(entry.at === undefined ? {} : { at: entry.at }) };
  trace.terminalTranscript.push(recorded);
  return recorded;
}

export function recordAuthoredWorkbookEvalReflectionTurn(trace: AuthoredWorkbookEvalSessionTrace, entry: AuthoredWorkbookEvalReflectionEntry): AuthoredWorkbookEvalReflectionEntry {
  const recorded = { blockId: entry.blockId, role: entry.role, text: boundedText(entry.text, "reflection transcript"), ...(entry.at === undefined ? {} : { at: entry.at }) };
  trace.reflections.push(recorded);
  return recorded;
}

export function recordAuthoredWorkbookEvalEditorStatus(trace: AuthoredWorkbookEvalSessionTrace, entry: AuthoredWorkbookEvalEditorEntry): AuthoredWorkbookEvalEditorEntry {
  const previous = trace.editors.at(-1);
  const feedback = entry.feedback === undefined ? undefined : boundedText(entry.feedback, "editor feedback");
  if (previous?.blockId === entry.blockId && previous.revision === entry.revision && previous.status === entry.status && previous.feedback === feedback) return previous;
  const recorded = { blockId: entry.blockId, revision: entry.revision, status: entry.status, ...(feedback === undefined ? {} : { feedback }), ...(entry.at === undefined ? {} : { at: entry.at }) };
  trace.editors.push(recorded);
  return recorded;
}

export function projectAuthoredWorkbookEvalTrace(trace: AuthoredWorkbookEvalSessionTrace): AuthoredWorkbookEvalTrace {
  assertNoLessonJumpEvents(trace.internalEvents, "internalEvents");
  return copyAuthoredWorkbookEvalTrace({
    scenarioId: trace.scenarioId,
    publicStates: trace.publicStates,
    terminalTranscript: trace.terminalTranscript,
    reflections: trace.reflections,
    editors: trace.editors,
    progressionEvents: trace.internalEvents.map(projectAuthoredWorkbookProgressionEvent).filter((event): event is AuthoredWorkbookEvalProgressionEvent => event !== undefined),
    artifacts: trace.artifacts
  });
}

export function copyAuthoredWorkbookEvalTrace(value: unknown): AuthoredWorkbookEvalTrace {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook public eval trace.");
  assertNoKnownLessonJumpFields(value);
  if (typeof value.scenarioId !== "string" || !hasPublicTraceArrays(value)) throw new Error("Invalid authored workbook public eval trace.");
  return {
    scenarioId: boundedText(value.scenarioId, "scenario id"),
    publicStates: value.publicStates.map((entry, index) => copyRecordedPublicState(entry, index)),
    terminalTranscript: value.terminalTranscript.map((entry, index) => copyTerminalTranscriptEntry(entry, index)),
    reflections: value.reflections.map((entry, index) => copyReflectionEntry(entry, index)),
    editors: value.editors.map((entry, index) => copyEditorEntry(entry, index)),
    progressionEvents: value.progressionEvents.map((entry, index) => copyProgressionEvent(entry, index)),
    artifacts: value.artifacts.map((entry, index) => copyArtifactSnapshot(entry, index))
  };
}

export function projectAuthoredWorkbookProgressionEvent(record: unknown): AuthoredWorkbookEvalProgressionEvent | undefined {
  if (!isPlainRecord(record) || typeof record.type !== "string") return undefined;
  switch (record.type) {
    case "session_started":
      return { type: "session_started" };
    case "lesson_jump_started":
      throw new Error("Authored workbook eval setup forbids lesson jumps; lesson_jump_started cannot enter the public trace.");
    case "workbook_introduction_completed":
      return { type: "workbook_introduction_completed" };
    case "attempt_accepted":
      return typeof record.lessonId === "string" && typeof record.blockId === "string" && isPublicAttemptKind(record.kind) ? { type: "attempt_accepted", lessonId: record.lessonId, blockId: record.blockId, kind: record.kind } : undefined;
    case "block_completed": {
      if (typeof record.blockId !== "string") return undefined;
      const lessonId = record.lessonId;
      if ("lessonId" in record && typeof lessonId !== "string") return undefined;
      return typeof lessonId === "string" ? { type: "block_completed", lessonId, blockId: record.blockId } : { type: "block_completed", blockId: record.blockId };
    }
    default:
      return undefined;
  }
}

export function enumerateAuthoredWorkbookEvalCitations(trace: AuthoredWorkbookEvalTrace): AuthoredWorkbookEvalCitation[] {
  const safeTrace = copyAuthoredWorkbookEvalTrace(trace);
  const citations: AuthoredWorkbookEvalCitation[] = [];
  const seen = new Set<string>();
  const push = (kind: AuthoredWorkbookEvalCitation["kind"], ref: AuthoredWorkbookEvalCitation["ref"], keyValue: unknown) => {
    const key = JSON.stringify([kind, keyValue]);
    if (seen.has(key)) return;
    seen.add(key);
    citations.push({ id: citations.length, kind, ref } as AuthoredWorkbookEvalCitation);
  };
  safeTrace.publicStates.forEach((value, index) => push("publicState", { index, label: value.label }, value.state));
  safeTrace.terminalTranscript.forEach((value, index) => push("terminalTranscript", { index, blockId: value.blockId }, value));
  safeTrace.reflections.forEach((value, index) => push("reflection", { index, blockId: value.blockId }, value));
  safeTrace.editors.forEach((value, index) => push("editor", { index, blockId: value.blockId, revision: value.revision }, value));
  safeTrace.progressionEvents.forEach((value, index) => push("progressionEvent", { index, type: value.type }, value));
  safeTrace.artifacts.forEach((value, index) => push("artifact", { index, path: value.path }, value));
  return citations;
}

export async function snapshotAuthoredWorkbookEvalArtifacts(workspaceRoot: string, options: AuthoredWorkbookEvalArtifactOptions): Promise<AuthoredWorkbookEvalArtifactSnapshot[]> {
  if (!Array.isArray(options?.files)) throw new Error("Authored workbook eval artifact capture requires an explicit exact relative file allowlist.");
  const limits = {
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_ARTIFACT_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_ARTIFACT_FILES
  };
  if (options.files.length > limits.maxFiles) throw new Error(`Authored workbook eval artifact allowlist has too many files (max ${limits.maxFiles}).`);
  let workspaceReal: string;
  try { workspaceReal = await realpath(resolve(workspaceRoot)); }
  catch { throw new Error("Unable to inspect the artifact workspace."); }
  const snapshots: AuthoredWorkbookEvalArtifactSnapshot[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const file of options.files) {
    const safeFile = assertSafeRelativeArtifactFile(file);
    const absolute = resolve(workspaceReal, safeFile);
    const relativePath = relative(workspaceReal, absolute).split(sep).join("/");
    let metadata;
    try { metadata = await lstat(absolute); }
    catch (error: any) { if (error?.code === "ENOENT") throw new Error(`Artifact '${relativePath}' was not found.`); throw new Error(`Unable to inspect artifact '${relativePath}'.`); }
    if (!metadata.isFile()) throw new Error(`Artifact '${relativePath}' is not an ordinary file.`);
    let real: string;
    try { real = await realpath(absolute); }
    catch { throw new Error(`Unable to inspect artifact '${relativePath}'.`); }
    if (!isInside(workspaceReal, real)) throw new Error(`Artifact '${relativePath}' is outside the workspace.`);
    const stableRelativePath = relative(workspaceReal, real).split(sep).join("/");
    if (stableRelativePath !== safeFile) throw new Error(`Artifact '${relativePath}' must not be a symlink or alias.`);
    if (seen.has(stableRelativePath)) throw new Error(`Duplicate authored workbook eval artifact allowlist entry: ${stableRelativePath}.`);
    if (metadata.size > limits.maxFileBytes) throw new Error(`Artifact '${stableRelativePath}' is too large to include in an authored workbook eval trace.`);
    totalBytes += metadata.size;
    if (totalBytes > limits.maxTotalBytes) throw new Error(`Authored workbook eval artifacts exceed ${limits.maxTotalBytes} bytes.`);
    const content = await readFile(real, "utf8");
    snapshots.push({ path: stableRelativePath, content: boundedText(content, `artifact '${stableRelativePath}'`) });
    seen.add(stableRelativePath);
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPublicTraceArrays(value: Record<string, unknown>): value is Record<"publicStates" | "terminalTranscript" | "reflections" | "editors" | "progressionEvents" | "artifacts", unknown[]> & { scenarioId: string } {
  return Array.isArray(value.publicStates) && Array.isArray(value.terminalTranscript) && Array.isArray(value.reflections) && Array.isArray(value.editors) && Array.isArray(value.progressionEvents) && Array.isArray(value.artifacts);
}

function isPublicAttemptKind(value: unknown): value is PublicAttemptKind {
  return value === "editor" || value === "terminal" || value === "reflection";
}

function copyRecordedPublicState(value: unknown, index: number): AuthoredWorkbookEvalRecordedPublicState {
  if (!isPlainRecord(value) || typeof value.label !== "string") throw new Error(`Invalid public state trace entry at index ${index}.`);
  let state: PublicWorkbookState;
  try { state = parsePublicWorkbookState(structuredClone(value.state) as unknown); }
  catch { throw new Error(`Invalid public state trace entry at index ${index}.`); }
  return { label: boundedText(value.label, "public state label"), state };
}

function copyTerminalTranscriptEntry(value: unknown, index: number): AuthoredWorkbookEvalTrace["terminalTranscript"][number] {
  if (!isPlainRecord(value) || (value.direction !== "input" && value.direction !== "output" && value.direction !== "observer") || typeof value.text !== "string") throw new Error(`Invalid terminal transcript entry at index ${index}.`);
  const blockId = value.blockId;
  if ("blockId" in value && typeof blockId !== "string") throw new Error(`Invalid terminal transcript entry at index ${index}.`);
  const text = boundedText(value.text, "terminal transcript");
  return typeof blockId === "string" ? { blockId, direction: value.direction, text } : { direction: value.direction, text };
}

function copyReflectionEntry(value: unknown, index: number): AuthoredWorkbookEvalTrace["reflections"][number] {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || (value.role !== "learner" && value.role !== "tutor") || typeof value.text !== "string") throw new Error(`Invalid reflection transcript entry at index ${index}.`);
  return { blockId: value.blockId, role: value.role, text: boundedText(value.text, "reflection transcript") };
}

function copyEditorEntry(value: unknown, index: number): AuthoredWorkbookEvalTrace["editors"][number] {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || !Number.isInteger(value.revision) || (value.status !== "reviewing" && value.status !== "feedback" && value.status !== "unlocked")) throw new Error(`Invalid editor trace entry at index ${index}.`);
  const revision = value.revision as number;
  const feedback = value.feedback;
  if ("feedback" in value && typeof feedback !== "string") throw new Error(`Invalid editor trace entry at index ${index}.`);
  return typeof feedback === "string" ? { blockId: value.blockId, revision, status: value.status, feedback: boundedText(feedback, "editor feedback") } : { blockId: value.blockId, revision, status: value.status };
}

function copyProgressionEvent(value: unknown, index: number): AuthoredWorkbookEvalProgressionEvent {
  const event = projectAuthoredWorkbookProgressionEvent(value);
  if (event === undefined) throw new Error(`Invalid progression event at index ${index}.`);
  return event;
}

function copyArtifactSnapshot(value: unknown, index: number): AuthoredWorkbookEvalArtifactSnapshot {
  if (!isPlainRecord(value) || typeof value.path !== "string" || typeof value.content !== "string") throw new Error(`Invalid artifact snapshot at index ${index}.`);
  const path = assertSafeRelativeArtifactFile(value.path);
  return { path, content: boundedText(value.content, `artifact '${path}'`) };
}

function assertNoKnownLessonJumpFields(record: Record<string, unknown>): void {
  for (const field of KNOWN_EVENT_BEARING_FIELDS) {
    const events = record[field];
    if (Array.isArray(events)) assertNoLessonJumpEvents(events, field);
  }
}

function assertNoLessonJumpEvents(events: readonly unknown[], channel: string): void {
  if (events.length > MAX_EVENT_BEARING_FIELD_EVENTS) throw new Error(`Authored workbook eval setup event field ${channel} is too large.`);
  if (events.some((event) => isPlainRecord(event) && event.type === "lesson_jump_started")) throw new Error(`Authored workbook eval setup forbids lesson jumps; lesson_jump_started found in ${channel}.`);
}

function assertSafeRelativeArtifactFile(file: string): string {
  if (typeof file !== "string" || file.length === 0 || isAbsolute(file) || file.split(/[\\/]+/).includes("..")) throw new Error("Invalid relative artifact file allowlist entry.");
  const normalized = file.split(/[\\/]+/).filter(Boolean).join("/");
  if (normalized.length === 0 || normalized !== file.split("\\").join("/")) throw new Error("Invalid relative artifact file allowlist entry.");
  if (isRawEventArtifactPath(normalized)) throw new Error("Raw workbook or station event files are internal gate-only inputs, not public eval artifacts.");
  return normalized;
}

function isRawEventArtifactPath(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return /(^|\/)workbook\/events\.jsonl$/.test(lower) || /(^|\/)events(\/|$)/.test(lower);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function boundedText(text: string, label: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_PUBLIC_CHANNEL_TEXT_BYTES) throw new Error(`${label} exceeds the authored workbook public trace length limit.`);
  return text;
}
