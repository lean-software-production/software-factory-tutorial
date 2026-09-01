import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parsePublicWorkbookState, type PublicAttemptKind, type PublicWorkbookState } from "../../tutorial-engine/src/workbook/public-contract.js";
import type {
  AuthoredWorkbookEvalArtifactSnapshot,
  AuthoredWorkbookEvalCitation,
  AuthoredWorkbookEvalEditorEntry,
  AuthoredWorkbookEvalJudgeBlockProgress,
  AuthoredWorkbookEvalJudgeBlockReference,
  AuthoredWorkbookEvalJudgeCheckpoint,
  AuthoredWorkbookEvalJudgePublicState,
  AuthoredWorkbookEvalJudgeTextMetadata,
  AuthoredWorkbookEvalJudgeRecordedPublicState,
  AuthoredWorkbookEvalJudgeTimelineRecord,
  AuthoredWorkbookEvalJudgeTrace,
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
  AuthoredWorkbookEvalJudgePublicState,
  AuthoredWorkbookEvalJudgeRecordedPublicState,
  AuthoredWorkbookEvalJudgeTrace,
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

export interface AuthoredWorkbookEvalPublicArtifactPolicyProjection {
  scenarioId?: string;
  artifactAllowlist: readonly string[];
}

export interface AuthoredWorkbookEvalJudgeTraceCopyOptions {
  artifactPolicy?: AuthoredWorkbookEvalPublicArtifactPolicyProjection;
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

export function projectAuthoredWorkbookEvalTraceForJudge(trace: AuthoredWorkbookEvalTrace, options: AuthoredWorkbookEvalJudgeTraceCopyOptions = {}): AuthoredWorkbookEvalJudgeTrace {
  const safeTrace = copyAuthoredWorkbookEvalTrace(trace);
  const seenTimelineRecords = new Set<string>();
  const publicStates: AuthoredWorkbookEvalJudgeRecordedPublicState[] = [];
  let previousProjectedState = "";
  for (const entry of safeTrace.publicStates) {
    const state = projectPublicWorkbookStateForJudge(entry.state, seenTimelineRecords);
    const serialized = JSON.stringify(state);
    if (serialized === previousProjectedState) continue;
    publicStates.push({ label: entry.label, state });
    previousProjectedState = serialized;
  }
  return copyAuthoredWorkbookEvalJudgeTrace({
    scenarioId: safeTrace.scenarioId,
    publicStates,
    terminalTranscript: safeTrace.terminalTranscript,
    reflections: safeTrace.reflections,
    editors: safeTrace.editors,
    progressionEvents: safeTrace.progressionEvents,
    artifacts: safeTrace.artifacts
  }, options);
}

export function copyAuthoredWorkbookEvalJudgeTrace(value: unknown, options: AuthoredWorkbookEvalJudgeTraceCopyOptions = {}): AuthoredWorkbookEvalJudgeTrace {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge trace.");
  assertObjectKeys(value, ["scenarioId", "publicStates", "terminalTranscript", "reflections", "editors", "progressionEvents", "artifacts"], [], "authored workbook judge trace");
  if (!Array.isArray(value.publicStates) || !Array.isArray(value.terminalTranscript) || !Array.isArray(value.reflections) || !Array.isArray(value.editors) || !Array.isArray(value.progressionEvents) || !Array.isArray(value.artifacts)) throw new Error("Invalid authored workbook judge trace.");
  const scenarioId = copyString(value.scenarioId, "authored workbook judge trace scenario id");
  const artifactPolicy = copyArtifactPolicyProjection(options.artifactPolicy);
  if (artifactPolicy?.scenarioId !== undefined && artifactPolicy.scenarioId !== scenarioId) throw new Error("Authored workbook Judge trace scenario does not match the artifact allowlist policy.");
  const trace: AuthoredWorkbookEvalJudgeTrace = {
    scenarioId,
    publicStates: value.publicStates.map(copyJudgeRecordedPublicState),
    terminalTranscript: value.terminalTranscript.map(copyJudgeTerminalTranscriptEntry),
    reflections: value.reflections.map(copyJudgeReflectionEntry),
    editors: value.editors.map(copyJudgeEditorEntry),
    progressionEvents: value.progressionEvents.map(copyJudgeProgressionEvent),
    artifacts: value.artifacts.map(copyJudgeArtifactSnapshot)
  };
  assertArtifactsMatchPolicy(trace.artifacts, artifactPolicy);
  return deepFreeze(trace);
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
    case "reflection_submitted":
    case "reflection_follow_up_submitted":
    case "reflection_reply_recorded":
    case "reflection_completed":
      return typeof record.lessonId === "string" && typeof record.blockId === "string" ? { type: record.type, lessonId: record.lessonId, blockId: record.blockId } : undefined;
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
  return enumerateTraceCitations(safeTrace);
}

export function enumerateAuthoredWorkbookEvalJudgeCitations(trace: AuthoredWorkbookEvalJudgeTrace): AuthoredWorkbookEvalCitation[] {
  return enumerateTraceCitations(trace);
}

function enumerateTraceCitations(trace: Omit<AuthoredWorkbookEvalTrace | AuthoredWorkbookEvalJudgeTrace, "scenarioId">): AuthoredWorkbookEvalCitation[] {
  const citations: AuthoredWorkbookEvalCitation[] = [];
  const seen = new Set<string>();
  const push = (kind: AuthoredWorkbookEvalCitation["kind"], ref: AuthoredWorkbookEvalCitation["ref"], keyValue: unknown) => {
    const key = JSON.stringify([kind, keyValue]);
    if (seen.has(key)) return;
    seen.add(key);
    citations.push({ id: citations.length, kind, ref } as AuthoredWorkbookEvalCitation);
  };
  trace.publicStates.forEach((value, index) => push("publicState", { index, label: value.label }, value.state));
  trace.terminalTranscript.forEach((value, index) => push("terminalTranscript", { index, blockId: value.blockId }, value));
  trace.reflections.forEach((value, index) => push("reflection", { index, blockId: value.blockId }, value));
  trace.editors.forEach((value, index) => push("editor", { index, blockId: value.blockId, revision: value.revision }, value));
  trace.progressionEvents.forEach((value, index) => push("progressionEvent", { index, type: value.type }, value));
  trace.artifacts.forEach((value, index) => push("artifact", { index, path: value.path }, value));
  return citations;
}

function projectPublicWorkbookStateForJudge(state: PublicWorkbookState, seenTimelineRecords: Set<string>): AuthoredWorkbookEvalJudgePublicState {
  return copyAuthoredWorkbookEvalJudgePublicState(omitUndefined({
    workbook: { title: state.workbook.title },
    introductionComplete: state.introductionComplete,
    active: omitUndefined({ lessonId: state.progress.activeLessonId, blockId: state.progress.activeBlockId, anchorId: state.progress.activeAnchorId }),
    completedLessons: [...state.progress.completedLessons],
    completedBlocks: optionalStrings(state.progress.completedBlocks),
    workAcceptedBlocks: optionalStrings(state.progress.workAcceptedBlocks),
    readyBlocks: optionalStrings(state.progress.readyBlocks),
    revealedBlockIds: optionalStrings(state.revealedBlockIds),
    renderedBlockIds: optionalStrings(state.renderedBlockIds),
    readyBlockIds: optionalStrings(state.readyBlockIds),
    currentBlock: state.currentBlock === undefined ? undefined : projectBlockReference(state.currentBlock),
    completion: state.completion === undefined ? undefined : omitUndefined({ complete: true as const, anchorId: state.completion.anchorId, summary: textMetadata(state.completion.summary) }),
    chapters: state.chapters.map((chapter) => omitUndefined({
      id: chapter.id,
      title: chapter.title,
      partId: chapter.partId,
      part: chapter.part,
      partNumber: chapter.partNumber,
      lessonNumber: chapter.lessonNumber,
      lesson: chapter.lesson === undefined ? undefined : {
        id: chapter.lesson.id,
        title: chapter.lesson.title,
        durationMinutes: chapter.lesson.durationMinutes,
        outcomes: [...chapter.lesson.outcomes],
        blockCount: chapter.lesson.blocks.length,
        blocks: chapter.lesson.blocks.map(projectBlockReference).filter((block): block is AuthoredWorkbookEvalJudgeBlockReference => block !== undefined)
      }
    })),
    orderedBlocks: state.orderedBlocks?.map(projectBlockReference).filter((block): block is AuthoredWorkbookEvalJudgeBlockReference => block !== undefined),
    progressBlocks: state.progress.blocks.map(projectProgressBlockForJudge),
    reflectionBlocks: Object.keys(state.progress.reflections).sort(),
    reflectionConversations: Object.entries(state.progress.reflectionConversations).sort(([left], [right]) => left.localeCompare(right)).map(([blockId, turns]) => ({ blockId, turns: turns.length, roles: turns.map((turn) => turn.role) })),
    canComplete: state.progress.canComplete === undefined ? undefined : omitUndefined({ blockId: state.progress.canComplete.blockId, eligible: state.progress.canComplete.eligible, reason: state.progress.canComplete.reason }),
    workbookComplete: state.progress.workbookComplete,
    adapter: omitUndefined({ modelBackedHelp: state.adapter.modelBackedHelp, note: textMetadata(state.adapter.note) }),
    timelineNewRecords: state.timeline.map((record) => projectTimelineRecordForJudge(record, seenTimelineRecords)).filter((record): record is AuthoredWorkbookEvalJudgeTimelineRecord => record !== undefined)
  }));
}

export function copyAuthoredWorkbookEvalJudgePublicState(value: unknown): AuthoredWorkbookEvalJudgePublicState {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge public state.");
  assertObjectKeys(value, ["workbook", "introductionComplete", "active", "completedLessons", "chapters", "progressBlocks", "reflectionBlocks", "reflectionConversations", "adapter", "timelineNewRecords"], ["completedBlocks", "workAcceptedBlocks", "readyBlocks", "revealedBlockIds", "renderedBlockIds", "readyBlockIds", "currentBlock", "completion", "orderedBlocks", "canComplete", "workbookComplete"], "authored workbook judge public state");
  const copied: AuthoredWorkbookEvalJudgePublicState = {
    workbook: copyJudgeWorkbook(value.workbook),
    introductionComplete: copyBoolean(value.introductionComplete, "authored workbook judge public state introductionComplete"),
    active: copyJudgeActive(value.active),
    completedLessons: copyStringArray(value.completedLessons, "authored workbook judge completed lessons"),
    chapters: copyArray(value.chapters, "authored workbook judge chapters", copyJudgeChapter),
    progressBlocks: copyArray(value.progressBlocks, "authored workbook judge progress blocks", copyJudgeProgressBlock),
    reflectionBlocks: copyStringArray(value.reflectionBlocks, "authored workbook judge reflection blocks"),
    reflectionConversations: copyArray(value.reflectionConversations, "authored workbook judge reflection conversations", copyJudgeReflectionConversation),
    adapter: copyJudgeAdapter(value.adapter),
    timelineNewRecords: copyArray(value.timelineNewRecords, "authored workbook judge timeline records", copyJudgeTimelineRecord)
  };
  if (Object.hasOwn(value, "completedBlocks")) copied.completedBlocks = copyStringArray(value.completedBlocks, "authored workbook judge completed blocks");
  if (Object.hasOwn(value, "workAcceptedBlocks")) copied.workAcceptedBlocks = copyStringArray(value.workAcceptedBlocks, "authored workbook judge work accepted blocks");
  if (Object.hasOwn(value, "readyBlocks")) copied.readyBlocks = copyStringArray(value.readyBlocks, "authored workbook judge ready blocks");
  if (Object.hasOwn(value, "revealedBlockIds")) copied.revealedBlockIds = copyStringArray(value.revealedBlockIds, "authored workbook judge revealed block ids");
  if (Object.hasOwn(value, "renderedBlockIds")) copied.renderedBlockIds = copyStringArray(value.renderedBlockIds, "authored workbook judge rendered block ids");
  if (Object.hasOwn(value, "readyBlockIds")) copied.readyBlockIds = copyStringArray(value.readyBlockIds, "authored workbook judge ready block ids");
  if (Object.hasOwn(value, "currentBlock")) copied.currentBlock = copyJudgeBlockReference(value.currentBlock);
  if (Object.hasOwn(value, "completion")) copied.completion = copyJudgeCompletion(value.completion);
  if (Object.hasOwn(value, "orderedBlocks")) copied.orderedBlocks = copyArray(value.orderedBlocks, "authored workbook judge ordered blocks", copyJudgeBlockReference);
  if (Object.hasOwn(value, "canComplete")) copied.canComplete = copyJudgeCanComplete(value.canComplete);
  if (Object.hasOwn(value, "workbookComplete")) copied.workbookComplete = copyBoolean(value.workbookComplete, "authored workbook judge workbookComplete");
  return copied;
}

function copyJudgeRecordedPublicState(value: unknown, index: number): AuthoredWorkbookEvalJudgeTrace["publicStates"][number] {
  if (!isPlainRecord(value)) throw new Error(`Invalid authored workbook judge public state at index ${index}.`);
  assertObjectKeys(value, ["label", "state"], [], "authored workbook judge public state");
  return { label: copyString(value.label, "authored workbook judge public state label"), state: copyAuthoredWorkbookEvalJudgePublicState(value.state) };
}

function copyJudgeTerminalTranscriptEntry(value: unknown, index: number): AuthoredWorkbookEvalJudgeTrace["terminalTranscript"][number] {
  if (!isPlainRecord(value)) throw new Error(`Invalid authored workbook terminal transcript entry at index ${index}.`);
  assertObjectKeys(value, ["direction", "text"], ["blockId"], "authored workbook terminal transcript entry");
  if (value.direction !== "input" && value.direction !== "output" && value.direction !== "observer") throw new Error(`Invalid authored workbook terminal transcript entry at index ${index}.`);
  const text = copyString(value.text, "authored workbook terminal transcript text");
  if (Object.hasOwn(value, "blockId")) return { blockId: copyString(value.blockId, "authored workbook terminal transcript block id"), direction: value.direction, text };
  return { direction: value.direction, text };
}

function copyJudgeReflectionEntry(value: unknown, index: number): AuthoredWorkbookEvalJudgeTrace["reflections"][number] {
  if (!isPlainRecord(value)) throw new Error(`Invalid authored workbook reflection entry at index ${index}.`);
  assertObjectKeys(value, ["blockId", "role", "text"], [], "authored workbook reflection entry");
  if (value.role !== "learner" && value.role !== "tutor") throw new Error(`Invalid authored workbook reflection entry at index ${index}.`);
  return { blockId: copyString(value.blockId, "authored workbook reflection block id"), role: value.role, text: copyString(value.text, "authored workbook reflection text") };
}

function copyJudgeEditorEntry(value: unknown, index: number): AuthoredWorkbookEvalJudgeTrace["editors"][number] {
  if (!isPlainRecord(value)) throw new Error(`Invalid authored workbook editor entry at index ${index}.`);
  assertObjectKeys(value, ["blockId", "revision", "status"], ["feedback"], "authored workbook editor entry");
  if (!Number.isInteger(value.revision) || (value.status !== "reviewing" && value.status !== "feedback" && value.status !== "unlocked")) throw new Error(`Invalid authored workbook editor entry at index ${index}.`);
  const entry: AuthoredWorkbookEvalJudgeTrace["editors"][number] = { blockId: copyString(value.blockId, "authored workbook editor block id"), revision: value.revision as number, status: value.status };
  if (Object.hasOwn(value, "feedback")) entry.feedback = copyString(value.feedback, "authored workbook editor feedback");
  return entry;
}

function copyJudgeProgressionEvent(value: unknown, index: number): AuthoredWorkbookEvalJudgeTrace["progressionEvents"][number] {
  if (!isPlainRecord(value) || typeof value.type !== "string") throw new Error(`Invalid authored workbook progression event at index ${index}.`);
  switch (value.type) {
    case "session_started":
    case "workbook_introduction_completed":
      assertObjectKeys(value, ["type"], [], "authored workbook progression event");
      return { type: value.type };
    case "attempt_accepted":
      assertObjectKeys(value, ["type", "lessonId", "blockId", "kind"], [], "authored workbook progression event");
      return { type: "attempt_accepted", lessonId: copyString(value.lessonId, "authored workbook progression lesson id"), blockId: copyString(value.blockId, "authored workbook progression block id"), kind: copyPublicAttemptKind(value.kind, "authored workbook progression attempt kind") };
    case "reflection_submitted":
    case "reflection_follow_up_submitted":
    case "reflection_reply_recorded":
    case "reflection_completed":
      assertObjectKeys(value, ["type", "lessonId", "blockId"], [], "authored workbook progression event");
      return { type: value.type, lessonId: copyString(value.lessonId, "authored workbook progression lesson id"), blockId: copyString(value.blockId, "authored workbook progression block id") };
    case "block_completed": {
      assertObjectKeys(value, ["type", "blockId"], ["lessonId"], "authored workbook progression event");
      const blockId = copyString(value.blockId, "authored workbook progression block id");
      return Object.hasOwn(value, "lessonId") ? { type: "block_completed", lessonId: copyString(value.lessonId, "authored workbook progression lesson id"), blockId } : { type: "block_completed", blockId };
    }
    default:
      throw new Error(`Invalid authored workbook progression event at index ${index}.`);
  }
}

function copyJudgeArtifactSnapshot(value: unknown, index: number): AuthoredWorkbookEvalJudgeTrace["artifacts"][number] {
  if (!isPlainRecord(value)) throw new Error(`Invalid authored workbook artifact snapshot at index ${index}.`);
  assertObjectKeys(value, ["path", "content"], [], "authored workbook artifact snapshot");
  const path = assertSafeRelativeArtifactFile(copyString(value.path, "authored workbook artifact path"));
  return { path, content: copyString(value.content, `authored workbook artifact '${path}'`) };
}

function copyArtifactPolicyProjection(policy: AuthoredWorkbookEvalPublicArtifactPolicyProjection | undefined): AuthoredWorkbookEvalPublicArtifactPolicyProjection | undefined {
  if (policy === undefined) return undefined;
  if (!isPlainRecord(policy) || !Array.isArray(policy.artifactAllowlist)) throw new Error("Invalid authored workbook artifact allowlist policy.");
  assertObjectKeys(policy, ["artifactAllowlist"], ["scenarioId"], "authored workbook artifact allowlist policy");
  const artifactAllowlist = policy.artifactAllowlist.map((entry) => assertSafeRelativeArtifactFile(copyString(entry, "authored workbook artifact allowlist entry")));
  if (new Set(artifactAllowlist).size !== artifactAllowlist.length) throw new Error("Duplicate authored workbook artifact allowlist entry.");
  const copied: AuthoredWorkbookEvalPublicArtifactPolicyProjection = { artifactAllowlist };
  if (Object.hasOwn(policy, "scenarioId")) copied.scenarioId = copyString(policy.scenarioId, "authored workbook artifact allowlist scenario id");
  return copied;
}

function assertArtifactsMatchPolicy(artifacts: readonly AuthoredWorkbookEvalArtifactSnapshot[], policy: AuthoredWorkbookEvalPublicArtifactPolicyProjection | undefined): void {
  if (policy === undefined) return;
  const actual = artifacts.map((artifact) => artifact.path);
  const expected = policy.artifactAllowlist;
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) throw new Error("Authored workbook Judge trace artifacts do not match the scenario artifact allowlist.");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return Object.freeze(value);
}

function assertObjectKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label}.`);
}

function copyString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
  return boundedText(value, label);
}

function copyBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}.`);
  return value;
}

function copyFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function copyNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}.`);
  return value as number;
}

function copyStringArray(value: unknown, label: string): string[] {
  return copyArray(value, label, (entry, index) => copyString(entry, `${label} entry ${index}`));
}

function copyArray<T>(value: unknown, label: string, copyEntry: (entry: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value.map(copyEntry);
}

function copyJudgeWorkbook(value: unknown): AuthoredWorkbookEvalJudgePublicState["workbook"] {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge workbook.");
  assertObjectKeys(value, ["title"], [], "authored workbook judge workbook");
  return { title: copyString(value.title, "authored workbook judge workbook title") };
}

function copyJudgeActive(value: unknown): AuthoredWorkbookEvalJudgePublicState["active"] {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge active block.");
  assertObjectKeys(value, ["lessonId", "blockId"], ["anchorId"], "authored workbook judge active block");
  const active: AuthoredWorkbookEvalJudgePublicState["active"] = {
    lessonId: copyString(value.lessonId, "authored workbook judge active lesson id"),
    blockId: copyString(value.blockId, "authored workbook judge active block id")
  };
  if (Object.hasOwn(value, "anchorId")) active.anchorId = copyString(value.anchorId, "authored workbook judge active anchor id");
  return active;
}

function copyJudgeTextMetadata(value: unknown, label: string): AuthoredWorkbookEvalJudgeTextMetadata {
  if (!isPlainRecord(value)) throw new Error(`Invalid ${label}.`);
  assertObjectKeys(value, ["bytes"], [], label);
  return { bytes: copyNonNegativeInteger(value.bytes, `${label} bytes`) };
}

function copyJudgeBlockPath(value: unknown, label: string): string {
  const path = copyString(value, label);
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`Invalid ${label}.`);
  return path;
}

function copyJudgeBlockReference(value: unknown): AuthoredWorkbookEvalJudgeBlockReference {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge block reference.");
  assertObjectKeys(value, ["id"], ["anchorId", "origin", "kind", "type", "title", "lessonId", "declaredId", "order", "path", "workAccepted"], "authored workbook judge block reference");
  const block: AuthoredWorkbookEvalJudgeBlockReference = { id: copyString(value.id, "authored workbook judge block id") };
  for (const key of ["anchorId", "origin", "kind", "type", "title", "lessonId", "declaredId"] as const) if (Object.hasOwn(value, key)) block[key] = copyString(value[key], `authored workbook judge block ${key}`);
  if (Object.hasOwn(value, "order")) block.order = copyFiniteNumber(value.order, "authored workbook judge block order");
  if (Object.hasOwn(value, "path")) block.path = copyJudgeBlockPath(value.path, "authored workbook judge block path");
  if (Object.hasOwn(value, "workAccepted")) block.workAccepted = copyBoolean(value.workAccepted, "authored workbook judge block workAccepted");
  return block;
}

function copyJudgeCompletion(value: unknown): NonNullable<AuthoredWorkbookEvalJudgePublicState["completion"]> {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge completion.");
  assertObjectKeys(value, ["complete", "anchorId"], ["summary"], "authored workbook judge completion");
  if (value.complete !== true) throw new Error("Invalid authored workbook judge completion.");
  const completion: NonNullable<AuthoredWorkbookEvalJudgePublicState["completion"]> = { complete: true, anchorId: copyString(value.anchorId, "authored workbook judge completion anchor id") };
  if (Object.hasOwn(value, "summary")) completion.summary = copyJudgeTextMetadata(value.summary, "authored workbook judge completion summary");
  return completion;
}

function copyJudgeLesson(value: unknown): NonNullable<AuthoredWorkbookEvalJudgePublicState["chapters"][number]["lesson"]> {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge lesson.");
  assertObjectKeys(value, ["id", "title", "durationMinutes", "outcomes", "blockCount", "blocks"], [], "authored workbook judge lesson");
  return {
    id: copyString(value.id, "authored workbook judge lesson id"),
    title: copyString(value.title, "authored workbook judge lesson title"),
    durationMinutes: copyFiniteNumber(value.durationMinutes, "authored workbook judge lesson duration"),
    outcomes: copyStringArray(value.outcomes, "authored workbook judge lesson outcomes"),
    blockCount: copyNonNegativeInteger(value.blockCount, "authored workbook judge lesson block count"),
    blocks: copyArray(value.blocks, "authored workbook judge lesson blocks", copyJudgeBlockReference)
  };
}

function copyJudgeChapter(value: unknown): AuthoredWorkbookEvalJudgePublicState["chapters"][number] {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge chapter.");
  assertObjectKeys(value, ["id", "title", "lessonNumber"], ["partId", "part", "partNumber", "lesson"], "authored workbook judge chapter");
  const chapter: AuthoredWorkbookEvalJudgePublicState["chapters"][number] = {
    id: copyString(value.id, "authored workbook judge chapter id"),
    title: copyString(value.title, "authored workbook judge chapter title"),
    lessonNumber: copyFiniteNumber(value.lessonNumber, "authored workbook judge chapter lesson number")
  };
  if (Object.hasOwn(value, "partId")) chapter.partId = copyString(value.partId, "authored workbook judge chapter part id");
  if (Object.hasOwn(value, "part")) chapter.part = copyString(value.part, "authored workbook judge chapter part");
  if (Object.hasOwn(value, "partNumber")) chapter.partNumber = copyFiniteNumber(value.partNumber, "authored workbook judge chapter part number");
  if (Object.hasOwn(value, "lesson")) chapter.lesson = copyJudgeLesson(value.lesson);
  return chapter;
}

function copyPublicAttemptKind(value: unknown, label: string): PublicAttemptKind {
  if (value !== "editor" && value !== "terminal" && value !== "reflection") throw new Error(`Invalid ${label}.`);
  return value;
}

function copyJudgeCheckpoint(value: unknown): AuthoredWorkbookEvalJudgeCheckpoint {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge checkpoint.");
  assertObjectKeys(value, ["status"], ["feedback", "successMessage", "summary", "evidence"], "authored workbook judge checkpoint");
  if (value.status !== "working" && value.status !== "reviewing" && value.status !== "feedback" && value.status !== "accepted") throw new Error("Invalid authored workbook judge checkpoint.");
  const checkpoint: AuthoredWorkbookEvalJudgeCheckpoint = { status: value.status };
  if (Object.hasOwn(value, "feedback")) checkpoint.feedback = copyJudgeTextMetadata(value.feedback, "authored workbook judge checkpoint feedback");
  if (Object.hasOwn(value, "successMessage")) checkpoint.successMessage = copyJudgeTextMetadata(value.successMessage, "authored workbook judge checkpoint success message");
  if (Object.hasOwn(value, "summary")) checkpoint.summary = copyJudgeTextMetadata(value.summary, "authored workbook judge checkpoint summary");
  if (Object.hasOwn(value, "evidence")) checkpoint.evidence = copyJudgeCheckpointEvidence(value.evidence);
  return checkpoint;
}

function copyJudgeCheckpointEvidence(value: unknown): NonNullable<AuthoredWorkbookEvalJudgeCheckpoint["evidence"]> {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge checkpoint evidence.");
  assertObjectKeys(value, ["kind"], ["text", "conversationTurns"], "authored workbook judge checkpoint evidence");
  const evidence: NonNullable<AuthoredWorkbookEvalJudgeCheckpoint["evidence"]> = { kind: copyPublicAttemptKind(value.kind, "authored workbook judge checkpoint evidence kind") };
  if (Object.hasOwn(value, "text")) evidence.text = copyJudgeTextMetadata(value.text, "authored workbook judge checkpoint evidence text");
  if (Object.hasOwn(value, "conversationTurns")) evidence.conversationTurns = copyNonNegativeInteger(value.conversationTurns, "authored workbook judge checkpoint evidence conversation turns");
  return evidence;
}

function copyJudgeTerminal(value: unknown): AuthoredWorkbookEvalJudgeBlockProgress["terminal"] {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge terminal.");
  if (value.phase === "running" || value.phase === "checking") {
    assertObjectKeys(value, ["phase"], [], "authored workbook judge terminal");
    return { phase: value.phase };
  }
  if (value.phase === "feedback" || value.phase === "complete") {
    assertObjectKeys(value, ["phase", "message"], [], "authored workbook judge terminal");
    return { phase: value.phase, message: copyString(value.message, "authored workbook judge terminal message") };
  }
  throw new Error("Invalid authored workbook judge terminal.");
}

function copyJudgeEditorStatus(value: unknown): AuthoredWorkbookEvalJudgeBlockProgress["editorStatus"] {
  if (value !== "editing" && value !== "waiting" && value !== "reviewing" && value !== "feedback" && value !== "unlocked") throw new Error("Invalid authored workbook judge editor status.");
  return value;
}

function copyJudgeProgressBlock(value: unknown): AuthoredWorkbookEvalJudgeBlockProgress {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge progress block.");
  assertObjectKeys(value, ["id", "ready", "active", "completed", "verified", "emerged"], ["type", "anchorId", "origin", "kind", "title", "completedAt", "workAccepted", "checkpoint", "terminal", "terminalRevision", "terminalSnapshot", "revision", "editorStatus"], "authored workbook judge progress block");
  const block: AuthoredWorkbookEvalJudgeBlockProgress = {
    id: copyString(value.id, "authored workbook judge progress block id"),
    ready: copyBoolean(value.ready, "authored workbook judge progress block ready"),
    active: copyBoolean(value.active, "authored workbook judge progress block active"),
    completed: copyBoolean(value.completed, "authored workbook judge progress block completed"),
    verified: copyBoolean(value.verified, "authored workbook judge progress block verified"),
    emerged: copyBoolean(value.emerged, "authored workbook judge progress block emerged")
  };
  for (const key of ["type", "anchorId", "origin", "kind", "title", "completedAt"] as const) if (Object.hasOwn(value, key)) block[key] = copyString(value[key], `authored workbook judge progress block ${key}`);
  if (Object.hasOwn(value, "workAccepted")) block.workAccepted = copyBoolean(value.workAccepted, "authored workbook judge progress block workAccepted");
  if (Object.hasOwn(value, "checkpoint")) block.checkpoint = copyJudgeCheckpoint(value.checkpoint);
  if (Object.hasOwn(value, "terminal")) block.terminal = copyJudgeTerminal(value.terminal);
  if (Object.hasOwn(value, "terminalRevision")) block.terminalRevision = copyNonNegativeInteger(value.terminalRevision, "authored workbook judge terminal revision");
  if (Object.hasOwn(value, "terminalSnapshot")) block.terminalSnapshot = copyJudgeTextMetadata(value.terminalSnapshot, "authored workbook judge terminal snapshot");
  if (Object.hasOwn(value, "revision")) block.revision = copyNonNegativeInteger(value.revision, "authored workbook judge revision");
  if (Object.hasOwn(value, "editorStatus")) block.editorStatus = copyJudgeEditorStatus(value.editorStatus);
  return block;
}

function copyJudgeReflectionConversation(value: unknown): AuthoredWorkbookEvalJudgePublicState["reflectionConversations"][number] {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge reflection conversation.");
  assertObjectKeys(value, ["blockId", "turns", "roles"], [], "authored workbook judge reflection conversation");
  return {
    blockId: copyString(value.blockId, "authored workbook judge reflection conversation block id"),
    turns: copyNonNegativeInteger(value.turns, "authored workbook judge reflection conversation turns"),
    roles: copyArray(value.roles, "authored workbook judge reflection conversation roles", (role) => {
      if (role !== "learner" && role !== "tutor") throw new Error("Invalid authored workbook judge reflection conversation role.");
      return role;
    })
  };
}

function copyJudgeCanComplete(value: unknown): NonNullable<AuthoredWorkbookEvalJudgePublicState["canComplete"]> {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge canComplete.");
  assertObjectKeys(value, ["blockId", "eligible"], ["reason"], "authored workbook judge canComplete");
  const canComplete: NonNullable<AuthoredWorkbookEvalJudgePublicState["canComplete"]> = {
    blockId: copyString(value.blockId, "authored workbook judge canComplete block id"),
    eligible: copyBoolean(value.eligible, "authored workbook judge canComplete eligible")
  };
  if (Object.hasOwn(value, "reason")) canComplete.reason = copyString(value.reason, "authored workbook judge canComplete reason");
  return canComplete;
}

function copyJudgeAdapter(value: unknown): AuthoredWorkbookEvalJudgePublicState["adapter"] {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge adapter.");
  assertObjectKeys(value, [], ["modelBackedHelp", "note"], "authored workbook judge adapter");
  const adapter: AuthoredWorkbookEvalJudgePublicState["adapter"] = {};
  if (Object.hasOwn(value, "modelBackedHelp")) adapter.modelBackedHelp = copyBoolean(value.modelBackedHelp, "authored workbook judge adapter modelBackedHelp");
  if (Object.hasOwn(value, "note")) adapter.note = copyJudgeTextMetadata(value.note, "authored workbook judge adapter note");
  return adapter;
}

function copyJudgeTimelineRecord(value: unknown): AuthoredWorkbookEvalJudgeTimelineRecord {
  if (!isPlainRecord(value)) throw new Error("Invalid authored workbook judge timeline record.");
  if (value.type !== "message") throw new Error("Invalid authored workbook judge timeline record.");
  assertObjectKeys(value, ["type", "id", "sequence", "lessonId", "blockId", "role", "source", "presentation", "text"], ["blockInView"], "authored workbook judge timeline record");
  if (value.role !== "assistant" && value.role !== "user") throw new Error("Invalid authored workbook judge timeline role.");
  if (value.source !== "authored" && value.source !== "learner" && value.source !== "main_tutor") throw new Error("Invalid authored workbook judge timeline source.");
  if (value.presentation !== "course" && value.presentation !== "chat" && value.presentation !== "review") throw new Error("Invalid authored workbook judge timeline presentation.");
  const record: AuthoredWorkbookEvalJudgeTimelineRecord = {
    type: "message",
    id: copyString(value.id, "authored workbook judge timeline id"),
    sequence: copyFiniteNumber(value.sequence, "authored workbook judge timeline sequence"),
    lessonId: copyString(value.lessonId, "authored workbook judge timeline lesson id"),
    blockId: copyString(value.blockId, "authored workbook judge timeline block id"),
    role: value.role,
    source: value.source,
    presentation: value.presentation,
    text: copyJudgeTextMetadata(value.text, "authored workbook judge timeline text")
  };
  if (Object.hasOwn(value, "blockInView")) record.blockInView = copyString(value.blockInView, "authored workbook judge timeline blockInView");
  return record;
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
  return snapshots;
}

function projectBlockReference(value: unknown): AuthoredWorkbookEvalJudgeBlockReference | undefined {
  if (!isPlainRecord(value) || typeof value.id !== "string") return undefined;
  return omitUndefined({
    id: value.id,
    anchorId: typeof value.anchorId === "string" ? value.anchorId : undefined,
    origin: typeof value.origin === "string" ? value.origin : undefined,
    kind: typeof value.kind === "string" ? value.kind : undefined,
    type: typeof value.type === "string" ? value.type : undefined,
    title: typeof value.title === "string" ? value.title : undefined,
    lessonId: typeof value.lessonId === "string" ? value.lessonId : undefined,
    declaredId: typeof value.declaredId === "string" ? value.declaredId : undefined,
    order: typeof value.order === "number" ? value.order : undefined,
    path: typeof value.path === "string" ? value.path : undefined,
    workAccepted: typeof value.workAccepted === "boolean" ? value.workAccepted : undefined
  });
}

function projectProgressBlockForJudge(block: PublicWorkbookState["progress"]["blocks"][number]): AuthoredWorkbookEvalJudgeTrace["publicStates"][number]["state"]["progressBlocks"][number] {
  return omitUndefined({
    id: block.id,
    type: block.type,
    anchorId: block.anchorId,
    origin: block.origin,
    kind: block.kind,
    title: block.title,
    ready: block.ready,
    active: block.active,
    completed: block.completed,
    completedAt: block.completedAt,
    verified: block.verified,
    emerged: block.emerged,
    workAccepted: block.workAccepted,
    checkpoint: projectCheckpointForJudge(block.checkpoint),
    terminal: block.terminal,
    terminalRevision: block.terminalRevision,
    terminalSnapshot: textMetadata(block.terminalSnapshot?.transcript),
    revision: block.revision,
    editorStatus: block.editorStatus
  });
}

function projectCheckpointForJudge(checkpoint: PublicWorkbookState["progress"]["blocks"][number]["checkpoint"]): AuthoredWorkbookEvalJudgeCheckpoint | undefined {
  if (checkpoint === undefined) return undefined;
  return omitUndefined({
    status: checkpoint.status,
    feedback: textMetadata(checkpoint.feedback),
    successMessage: textMetadata(checkpoint.successMessage),
    summary: textMetadata(checkpoint.summary),
    evidence: checkpoint.evidence === undefined ? undefined : omitUndefined({
      kind: checkpoint.evidence.kind,
      text: textMetadata(checkpoint.evidence.text),
      conversationTurns: checkpoint.evidence.conversation?.length
    })
  });
}

function projectTimelineRecordForJudge(record: PublicWorkbookState["timeline"][number], seen: Set<string>): AuthoredWorkbookEvalJudgeTimelineRecord | undefined {
  const key = `${record.type}:${record.id}:${record.sequence}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  if (record.type === "message") return omitUndefined({
    type: record.type,
    id: record.id,
    sequence: record.sequence,
    lessonId: record.lessonId,
    blockId: record.blockId,
    role: record.role,
    source: record.source,
    presentation: record.presentation,
    blockInView: record.blockInView,
    text: textMetadata(record.text)!
  });
  return undefined;
}

function optionalStrings(value: string[] | undefined): string[] | undefined {
  return value === undefined ? undefined : [...value];
}

function textMetadata(text: string | undefined): AuthoredWorkbookEvalJudgeTrace["publicStates"][number]["state"]["adapter"]["note"] | undefined {
  return text === undefined ? undefined : { bytes: Buffer.byteLength(text, "utf8") };
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
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
  rejectPrivateTokenField(value, `public state trace entry at index ${index}`);
  let state: PublicWorkbookState;
  try { state = parsePublicWorkbookState(structuredClone(value.state) as unknown); }
  catch { throw new Error(`Invalid public state trace entry at index ${index}.`); }
  return { label: boundedText(value.label, "public state label"), state };
}

function copyTerminalTranscriptEntry(value: unknown, index: number): AuthoredWorkbookEvalTrace["terminalTranscript"][number] {
  if (!isPlainRecord(value) || (value.direction !== "input" && value.direction !== "output" && value.direction !== "observer") || typeof value.text !== "string") throw new Error(`Invalid terminal transcript entry at index ${index}.`);
  rejectPrivateTokenField(value, `terminal transcript entry at index ${index}`);
  const blockId = value.blockId;
  if ("blockId" in value && typeof blockId !== "string") throw new Error(`Invalid terminal transcript entry at index ${index}.`);
  const text = boundedText(value.text, "terminal transcript");
  return typeof blockId === "string" ? { blockId, direction: value.direction, text } : { direction: value.direction, text };
}

function copyReflectionEntry(value: unknown, index: number): AuthoredWorkbookEvalTrace["reflections"][number] {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || (value.role !== "learner" && value.role !== "tutor") || typeof value.text !== "string") throw new Error(`Invalid reflection transcript entry at index ${index}.`);
  rejectPrivateTokenField(value, `reflection transcript entry at index ${index}`);
  return { blockId: value.blockId, role: value.role, text: boundedText(value.text, "reflection transcript") };
}

function copyEditorEntry(value: unknown, index: number): AuthoredWorkbookEvalTrace["editors"][number] {
  if (!isPlainRecord(value) || typeof value.blockId !== "string" || !Number.isInteger(value.revision) || (value.status !== "reviewing" && value.status !== "feedback" && value.status !== "unlocked")) throw new Error(`Invalid editor trace entry at index ${index}.`);
  rejectPrivateTokenField(value, `editor trace entry at index ${index}`);
  const revision = value.revision as number;
  const feedback = value.feedback;
  if ("feedback" in value && typeof feedback !== "string") throw new Error(`Invalid editor trace entry at index ${index}.`);
  return typeof feedback === "string" ? { blockId: value.blockId, revision, status: value.status, feedback: boundedText(feedback, "editor feedback") } : { blockId: value.blockId, revision, status: value.status };
}

function copyProgressionEvent(value: unknown, index: number): AuthoredWorkbookEvalProgressionEvent {
  if (isPlainRecord(value)) rejectPrivateTokenField(value, `progression event at index ${index}`);
  const event = projectAuthoredWorkbookProgressionEvent(value);
  if (event === undefined) throw new Error(`Invalid progression event at index ${index}.`);
  return event;
}

function copyArtifactSnapshot(value: unknown, index: number): AuthoredWorkbookEvalArtifactSnapshot {
  if (!isPlainRecord(value) || typeof value.path !== "string" || typeof value.content !== "string") throw new Error(`Invalid artifact snapshot at index ${index}.`);
  rejectPrivateTokenField(value, `artifact snapshot at index ${index}`);
  const path = assertSafeRelativeArtifactFile(value.path);
  return { path, content: boundedText(value.content, `artifact '${path}'`) };
}

function assertNoKnownLessonJumpFields(record: Record<string, unknown>): void {
  for (const field of KNOWN_EVENT_BEARING_FIELDS) {
    const events = record[field];
    if (Array.isArray(events)) assertNoLessonJumpEvents(events, field);
  }
}

function rejectPrivateTokenField(record: Record<string, unknown>, label: string): void {
  if (Object.hasOwn(record, "privateToken")) throw new Error(`Invalid authored workbook ${label}.`);
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
