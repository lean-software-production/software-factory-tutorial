import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { normalizeWorkbookTimelineRecord, type WorkbookTimelineRecord } from "../../src/workbook/timeline.js";
import type { PublicWorkbookState, V2ArtifactSnapshot, V2EditorEntry, V2JudgeTrace, V2PublicProgressionEvent, V2RecordedPublicState, V2ReflectionEntry, V2SessionTrace, V2TerminalTranscriptEntry } from "./types.js";

const DEFAULT_ARTIFACT_ROOTS = ["factory/.tmp", "editor-artifacts"];
const MAX_ARTIFACT_BYTES = 64 * 1024;

export function createEmptyV2SessionTrace(scenarioId: string): V2SessionTrace {
  return { scenarioId, publicStates: [], terminalTranscript: [], reflections: [], editors: [], events: [], artifacts: [] };
}

export function recordPublicState(trace: V2SessionTrace, label: string, state: unknown): V2RecordedPublicState {
  const cloned = structuredClone(state) as PublicWorkbookState;
  const previous = trace.publicStates.at(-1);
  if (previous && JSON.stringify(previous.state) === JSON.stringify(cloned)) return previous;
  const recorded = { label, state: cloned };
  trace.publicStates.push(recorded);
  return recorded;
}

export function recordTerminalTranscript(trace: V2SessionTrace, entry: V2TerminalTranscriptEntry): V2TerminalTranscriptEntry {
  trace.terminalTranscript.push({ blockId: entry.blockId, direction: entry.direction, text: entry.text, ...(entry.at === undefined ? {} : { at: entry.at }) });
  return entry;
}

export function recordReflectionTurn(trace: V2SessionTrace, entry: V2ReflectionEntry): V2ReflectionEntry {
  trace.reflections.push({ blockId: entry.blockId, role: entry.role, text: entry.text, ...(entry.at === undefined ? {} : { at: entry.at }) });
  return entry;
}

export function recordEditorStatus(trace: V2SessionTrace, entry: V2EditorEntry): V2EditorEntry {
  const previous = trace.editors.at(-1);
  if (previous?.blockId === entry.blockId && previous.revision === entry.revision && previous.status === entry.status && previous.feedback === entry.feedback) return previous;
  trace.editors.push({ blockId: entry.blockId, revision: entry.revision, status: entry.status, ...(entry.feedback === undefined ? {} : { feedback: entry.feedback }), ...(entry.at === undefined ? {} : { at: entry.at }) });
  return entry;
}

export async function readWorkbookTimeline(sessionRoot: string): Promise<WorkbookTimelineRecord[]> {
  const eventPath = resolve(sessionRoot, "workbook/events.jsonl");
  let text: string;
  try { text = await readFile(eventPath, "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return normalizeWorkbookTimelineRecord(JSON.parse(line), index + 1); }
    catch (error) { throw new Error(`${eventPath}:${index + 1}: invalid JSONL event`); }
  });
}

export function projectV2JudgeTrace(trace: V2SessionTrace): V2JudgeTrace {
  return copyV2JudgeTrace({
    scenarioId: trace.scenarioId,
    publicStates: trace.publicStates,
    terminalTranscript: trace.terminalTranscript,
    reflections: trace.reflections,
    editors: trace.editors,
    progressionEvents: trace.events.map(projectPublicProgressionEvent).filter((event): event is V2PublicProgressionEvent => event !== undefined),
    artifacts: trace.artifacts
  });
}

export function copyV2JudgeTrace(value: unknown): V2JudgeTrace {
  if (!isPlainRecord(value) || typeof value.scenarioId !== "string" || !hasArrayTraceShape(value)) throw new Error("Invalid public judge trace.");
  const judgeTrace: V2JudgeTrace = {
    scenarioId: value.scenarioId,
    publicStates: value.publicStates.map(copyRecordedPublicState).filter((entry): entry is V2RecordedPublicState => entry !== undefined),
    terminalTranscript: value.terminalTranscript.map(copyTerminalTranscriptEntry).filter((entry): entry is V2JudgeTrace["terminalTranscript"][number] => entry !== undefined),
    reflections: value.reflections.map(copyReflectionEntry).filter((entry): entry is V2JudgeTrace["reflections"][number] => entry !== undefined),
    editors: value.editors.map(copyEditorEntry).filter((entry): entry is V2JudgeTrace["editors"][number] => entry !== undefined),
    progressionEvents: value.progressionEvents.map(projectPublicProgressionEvent).filter((entry): entry is V2PublicProgressionEvent => entry !== undefined),
    artifacts: value.artifacts.map(copyArtifactSnapshot).filter((entry): entry is V2ArtifactSnapshot => entry !== undefined)
  };
  return judgeTrace;
}

export function projectPublicProgressionEvent(record: unknown): V2PublicProgressionEvent | undefined {
  if (!isPlainRecord(record) || typeof record.type !== "string") return undefined;
  switch (record.type) {
    case "session_started":
      return { type: "session_started" };
    case "lesson_jump_started":
      return typeof record.lessonId === "string" ? { type: "lesson_jump_started", lessonId: record.lessonId } : undefined;
    case "workbook_introduction_completed":
      return { type: "workbook_introduction_completed" };
    case "attempt_accepted":
      return typeof record.lessonId === "string" && typeof record.blockId === "string" && isAttemptKind(record.kind) ? { type: "attempt_accepted", lessonId: record.lessonId, blockId: record.blockId, kind: record.kind } : undefined;
    case "work_accepted":
      return typeof record.blockId === "string" ? { type: "work_accepted", blockId: record.blockId } : undefined;
    case "block_completed": {
      if (typeof record.blockId !== "string") return undefined;
      const lessonId = record.lessonId;
      if ("lessonId" in record && typeof lessonId !== "string") return undefined;
      return typeof lessonId === "string" ? { type: "block_completed", lessonId, blockId: record.blockId } : { type: "block_completed", blockId: record.blockId };
    }
    case "reflection_submitted":
      return hasLessonBlock(record) ? { type: "reflection_submitted", lessonId: record.lessonId, blockId: record.blockId } : undefined;
    case "reflection_follow_up_submitted":
      return hasLessonBlock(record) ? { type: "reflection_follow_up_submitted", lessonId: record.lessonId, blockId: record.blockId } : undefined;
    case "reflection_reply_recorded":
      return hasLessonBlock(record) ? { type: "reflection_reply_recorded", lessonId: record.lessonId, blockId: record.blockId } : undefined;
    case "observation_acknowledged":
      return typeof record.lessonId === "string" && typeof record.blockId === "string" ? { type: "observation_acknowledged", lessonId: record.lessonId, blockId: record.blockId, kind: "terminal" } : undefined;
    case "observation_verified":
      return typeof record.lessonId === "string" && typeof record.blockId === "string" ? { type: "observation_verified", lessonId: record.lessonId, blockId: record.blockId, kind: "terminal" } : undefined;
    case "block_continued":
      return hasLessonBlock(record) ? { type: "block_continued", lessonId: record.lessonId, blockId: record.blockId } : undefined;
    case "reflection_completed":
      return hasLessonBlock(record) ? { type: "reflection_completed", lessonId: record.lessonId, blockId: record.blockId } : undefined;
    case "editor_practice_unlocked":
      return typeof record.lessonId === "string" && typeof record.blockId === "string" ? { type: "editor_practice_unlocked", lessonId: record.lessonId, blockId: record.blockId, kind: "editor" } : undefined;
    case "lesson_transitioned":
      return hasLessonBlock(record) ? { type: "lesson_transitioned", lessonId: record.lessonId, blockId: record.blockId } : undefined;
    case "terminal-command-submitted":
    case "terminal-command-finished":
    case "terminal-transcript-snapshotted":
    case "terminal-feedback-recorded":
    case "terminal-coach-handoff-recorded":
    case "message":
    case "block_summarized":
    case "lesson_summarized":
    case "tutor_failed":
    case "workbook_completion_summary":
      return undefined;
    default:
      return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasArrayTraceShape(value: Record<string, unknown>): value is Record<"publicStates" | "terminalTranscript" | "reflections" | "editors" | "progressionEvents" | "artifacts", unknown[]> & { scenarioId: string } {
  return Array.isArray(value.publicStates) && Array.isArray(value.terminalTranscript) && Array.isArray(value.reflections) && Array.isArray(value.editors) && Array.isArray(value.progressionEvents) && Array.isArray(value.artifacts);
}

function isAttemptKind(value: unknown): value is "editor" | "terminal" | "reflection" {
  return value === "editor" || value === "terminal" || value === "reflection";
}

function hasLessonBlock(record: Record<string, unknown>): record is Record<string, unknown> & { lessonId: string; blockId: string } {
  return typeof record.lessonId === "string" && typeof record.blockId === "string";
}

function copyRecordedPublicState(value: unknown): V2RecordedPublicState | undefined {
  if (!isPlainRecord(value) || typeof value.label !== "string" || !isPlainRecord(value.state)) return undefined;
  let state: PublicWorkbookState;
  try { state = structuredClone(value.state) as PublicWorkbookState; }
  catch { return undefined; }
  return { label: value.label, state };
}

function copyTerminalTranscriptEntry(value: unknown): V2JudgeTrace["terminalTranscript"][number] | undefined {
  if (!isPlainRecord(value) || (value.direction !== "input" && value.direction !== "output" && value.direction !== "observer") || typeof value.text !== "string") return undefined;
  const blockId = value.blockId;
  if ("blockId" in value && typeof blockId !== "string") return undefined;
  return typeof blockId === "string" ? { blockId, direction: value.direction, text: value.text } : { direction: value.direction, text: value.text };
}

function copyReflectionEntry(value: unknown): V2JudgeTrace["reflections"][number] | undefined {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || (value.role !== "learner" && value.role !== "tutor") || typeof value.text !== "string") return undefined;
  return { blockId: value.blockId, role: value.role, text: value.text };
}

function copyEditorEntry(value: unknown): V2JudgeTrace["editors"][number] | undefined {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || !Number.isInteger(value.revision) || (value.status !== "reviewing" && value.status !== "feedback" && value.status !== "unlocked")) return undefined;
  const revision = value.revision as number;
  const feedback = value.feedback;
  if ("feedback" in value && typeof feedback !== "string") return undefined;
  return typeof feedback === "string" ? { blockId: value.blockId, revision, status: value.status, feedback } : { blockId: value.blockId, revision, status: value.status };
}

function copyArtifactSnapshot(value: unknown): V2ArtifactSnapshot | undefined {
  return isPlainRecord(value) && typeof value.path === "string" && typeof value.content === "string" ? { path: value.path, content: value.content } : undefined;
}

export async function snapshotArtifacts(workspaceRoot: string, artifactRoots: string[] = DEFAULT_ARTIFACT_ROOTS): Promise<V2ArtifactSnapshot[]> {
  const snapshots: V2ArtifactSnapshot[] = [];
  for (const root of artifactRoots) {
    await collectArtifacts(workspaceRoot, resolve(workspaceRoot, root), snapshots);
  }
  return snapshots.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectArtifacts(workspaceRoot: string, path: string, snapshots: V2ArtifactSnapshot[]): Promise<void> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) {
      await collectArtifacts(workspaceRoot, child, snapshots);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(child, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error(`${child} is too large to include in a v2 evaluator trace.`);
    const relativePath = relative(workspaceRoot, child).split(sep).join("/");
    const snapshot = { path: relativePath, content };
    snapshots.push(snapshot);
  }
}
