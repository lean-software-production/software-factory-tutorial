import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TutorialLogger } from "./runtime-log.js";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { INTRODUCTION_BLOCK_ID, INTRODUCTION_LESSON_ID, LESSON_FRAME_BLOCK_ID, PART_BLOCK_ID, partLessonId } from "./pi-history.js";
import { WORKBOOK_COMPLETE_ANCHOR_ID, WORKBOOK_INTRODUCTION_BLOCK_ID, blockText, buildWorkbookBlockStream, declaredBlockId, declaredSourceFromBlockId, successorAnchor, type AnchorId, type BlockId, type DeclaredWorkbookBlock, type OrderedWorkbookBlock } from "./workbook-blocks.js";
import { publicTerminalTranscript, type ActiveObservedTerminalBlock, type ActiveTerminalPublicSnapshot, type ActiveTerminalTranscriptContext } from "./terminal.js";
import type { TerminalObservationFact } from "./terminal-observation.js";
import { TerminalEvidenceRepository, type TerminalEvidence, type TerminalEvidenceRef } from "./terminal-evidence.js";
import { projectTerminalAttempts, type ProjectedTerminalAttempt } from "./terminal-attempt-projector.js";
import { promoteCurrentEditorAttempt, resolveEditorTarget } from "./editor.js";
import { AttemptStore, type Attempt, type AttemptEvidence } from "./attempts.js";
import type { PracticeCoach } from "./practice-coach.js";
import type { MainTutorContext, MainWorkbookTutor, PracticeCoachHandoff, TutorDecision } from "./tutor.js";
import { WorkbookTimeline, type TimelineMessage, type TutorFailure, type WorkbookTimelineRecord } from "./timeline.js";
import { submitReflectionAttempt } from "./reflection.js";
import type { EditorPracticeBlock, WorkbookBlock, WorkbookLesson } from "./contract.js";
import type { PublicCheckpoint, PublicCompleteBlockResult, PublicTerminal, PublicTerminalSnapshot, PublicTimelineRecord, PublicWorkbookBlock, PublicWorkbookBlockProgress, PublicWorkbookLesson, PublicWorkbookOrderedBlock, PublicWorkbookState } from "./public-contract.js";

const REVIEW_FAILURE_FEEDBACK = "Review is temporarily unavailable. Please try another attempt in a moment.";
const TERMINAL_REVIEW_FAILURE_FEEDBACK = "Review is temporarily unavailable. Please run the command again in a moment.";
const TUTOR_UNAVAILABLE = "The tutor is temporarily unavailable. Please retry.";
const TERMINAL_ASSESSMENT_TIMEOUT_MS = 30_000;
const WORKFLOW_CLOSE_GRACE_MS = 250;
const MAX_PUBLIC_TERMINAL_SNAPSHOT_BYTES = 16_000;

class TerminalAssessmentTimeoutError extends Error {
  constructor() { super("Terminal assessment timed out."); }
}

/** Injectable so terminal assessment timeouts have deterministic fake-timer coverage. */
export interface TerminalAssessmentScheduler {
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

const terminalAssessmentScheduler: TerminalAssessmentScheduler = {
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type AcceptedCheckpoint = { summary: string; kind: AttemptEvidence["kind"] };
type CompleteBlockResult = PublicCompleteBlockResult;

type WorkbookProjectionState = {
  stream: OrderedWorkbookBlock[];
  completedBlockIds: Set<BlockId>;
  workAcceptedBlockIds: Set<BlockId>;
  readyBlockIds: Set<BlockId>;
  current?: OrderedWorkbookBlock;
  activeBlockId: BlockId;
  activeAnchorId: AnchorId;
  activeIndex: number;
  workbookComplete: boolean;
};

function isEvaluatedBlock(block: WorkbookBlock): block is Extract<WorkbookBlock, { type: "editor-practice" | "terminal-practice" | "reflection" }> { return block.type === "editor-practice" || block.type === "terminal-practice" || block.type === "reflection"; }
function evidenceMatchesBlock(evidence: AttemptEvidence, block: WorkbookBlock): boolean { return (evidence.kind === "editor" && block.type === "editor-practice") || (evidence.kind === "terminal" && block.type === "terminal-practice") || (evidence.kind === "reflection" && block.type === "reflection"); }

function acceptsWorkImmediately(block: OrderedWorkbookBlock): boolean { return block.origin === "structural" || block.kind === "narrative"; }

function publicBlock(block: WorkbookBlock): PublicWorkbookBlock { const { tutor: _privateTutor, ...visible } = block as WorkbookBlock & { tutor?: string }; return visible; }
function publicLesson(lesson: WorkbookLesson, blocks: WorkbookBlock[]): PublicWorkbookLesson {
  const { workspace: _privateWorkspace, ...visible } = lesson;
  return { ...visible, blocks: blocks.map(publicBlock) };
}
async function readTargetDraftText(workspace: string, block: EditorPracticeBlock): Promise<string> {
  try { return await readFile(await resolveEditorTarget(workspace, block.path), "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return ""; throw error; }
}
function publicAttemptEvidence(attempt: Attempt): PublicCheckpoint["evidence"] {
  if (attempt.evidence.kind === "editor") return { kind: "editor", text: attempt.evidence.text };
  if (attempt.evidence.kind === "terminal") return { kind: "terminal" };
  return { kind: "reflection", conversation: [...attempt.evidence.conversation, { role: "learner", text: attempt.evidence.response }] };
}
function publicCheckpoint(attempt: Attempt | undefined, projected: AcceptedCheckpoint | undefined): PublicCheckpoint | undefined {
  if (attempt && attempt.status !== "superseded") {
    const evidence = publicAttemptEvidence(attempt);
    if (attempt.status === "accepted") return projected ? { status: "accepted", successMessage: attempt.successMessage ?? projected.summary, evidence } : { status: "reviewing", evidence };
    return { status: attempt.status, feedback: attempt.status === "feedback" ? attempt.feedback : undefined, evidence };
  }
  return projected ? { status: "accepted", successMessage: projected.summary, evidence: { kind: projected.kind } } : undefined;
}
function timelineMessageBlockKind(loaded: LoadedWorkbook, record: TimelineMessage): OrderedWorkbookBlock["kind"] | undefined {
  const source = declaredSourceFromBlockId(record.blockId);
  const block = buildWorkbookBlockStream(loaded).find((candidate) => candidate.id === record.blockId || (source && candidate.origin === "declared" && candidate.lessonId === source.lessonId && candidate.declaredId === source.declaredId));
  return block?.kind;
}
function projectedAuthoredMessage(loaded: LoadedWorkbook, record: TimelineMessage): TimelineMessage | undefined {
  if (record.source !== "authored" || record.presentation !== "course") return record;
  const block = buildWorkbookBlockStream(loaded).find((candidate) => candidate.id === record.blockId);
  if (!block) return undefined;
  const text = blockText(block, loaded.identity.title);
  return text === record.text ? record : { ...record, text };
}
function projectedTimelineRecord(loaded: LoadedWorkbook, record: WorkbookTimelineRecord): WorkbookTimelineRecord | undefined {
  return record.type === "message" ? projectedAuthoredMessage(loaded, record) : record;
}
function projectedTimelineRecords(loaded: LoadedWorkbook, source: readonly WorkbookTimelineRecord[]): WorkbookTimelineRecord[] {
  return source.flatMap((record) => {
    const projected = projectedTimelineRecord(loaded, record);
    return projected ? [projected] : [];
  });
}
/** Terminal commands, evidence references, and Coach outputs are internal lifecycle material.
 * The Main Tutor receives the final transient attempt and an explicit ready/interesting handoff,
 * never the raw lifecycle log. */
function mainTutorTimelineRecords(loaded: LoadedWorkbook, source: readonly WorkbookTimelineRecord[]): WorkbookTimelineRecord[] {
  return projectedTimelineRecords(loaded, source).filter((record) => !(
    record.type === "terminal-command-submitted"
    || record.type === "terminal-command-finished"
    || record.type === "terminal-transcript-snapshotted"
    || record.type === "terminal-feedback-recorded"
    || record.type === "terminal-coach-handoff-recorded"
  ));
}
function publicTimelineRecord(record: WorkbookTimelineRecord, loaded?: LoadedWorkbook): PublicTimelineRecord | undefined {
  const projectedRecord = loaded ? projectedTimelineRecord(loaded, record) : record;
  if (!projectedRecord) return undefined;
  if (projectedRecord.type === "message") {
    // Every review is logged, but a practice block shows only its latest feedback, beside the
    // work surface. Letting these into the conversation would replay the whole review history as
    // chat, so they are dropped here and reach the learner through the block's checkpoint instead.
    if (loaded && projectedRecord.source === "main_tutor" && projectedRecord.presentation === "review") {
      const kind = timelineMessageBlockKind(loaded, projectedRecord);
      if (kind === "terminal-practice" || kind === "editor-practice") return undefined;
    }
    return projectedRecord;
  }
  if (projectedRecord.type !== "tutor_failed") return undefined;
  const { requestId: _privateRequestId, ...publicFailure } = projectedRecord;
  return { ...publicFailure, failureId: projectedRecord.id };
}
function authoredCourseOrder(loaded: LoadedWorkbook, record: PublicTimelineRecord): number | undefined {
  if (record.type !== "message" || record.source !== "authored" || record.presentation !== "course") return undefined;
  const canonicalIndex = buildWorkbookBlockStream(loaded).findIndex((block) => block.id === record.blockId);
  if (canonicalIndex >= 0) return canonicalIndex;
  if (record.lessonId === INTRODUCTION_LESSON_ID && record.blockId === INTRODUCTION_BLOCK_ID) return 0;
  const partIndex = loaded.chapters.findIndex((chapter) => chapter.partId && partLessonId(chapter.partId) === record.lessonId);
  if (partIndex >= 0 && record.blockId === PART_BLOCK_ID) return 1_000 + partIndex * 1_000;
  const lessonIndex = loaded.chapters.findIndex((chapter) => chapter.lesson?.id === record.lessonId);
  if (lessonIndex < 0) return undefined;
  if (record.blockId === LESSON_FRAME_BLOCK_ID) return 1_000 + lessonIndex * 1_000 + 100;
  const blockIndex = loaded.chapters[lessonIndex]?.lesson?.blocks.findIndex((block) => block.id === record.blockId) ?? -1;
  return blockIndex >= 0 ? 1_000 + lessonIndex * 1_000 + 200 + blockIndex : undefined;
}
function publicTimeline(loaded: LoadedWorkbook, records: readonly WorkbookTimelineRecord[]): PublicTimelineRecord[] {
  const projected = projectedTimelineRecords(loaded, records).flatMap((record) => { const publicRecord = publicTimelineRecord(record, loaded); return publicRecord ? [publicRecord] : []; });
  const course = projected.map((record) => ({ record, order: authoredCourseOrder(loaded, record) })).filter((entry): entry is { record: PublicTimelineRecord; order: number } => entry.order !== undefined).sort((a, b) => a.order - b.order || a.record.sequence - b.record.sequence);
  const emitted = new Set<string>();
  const output: PublicTimelineRecord[] = [];
  const emit = (record: PublicTimelineRecord) => {
    if (emitted.has(record.id)) return;
    emitted.add(record.id);
    output.push(record);
  };
  for (const record of projected) {
    const order = authoredCourseOrder(loaded, record);
    if (order !== undefined) for (const entry of course) if (!emitted.has(entry.record.id) && entry.order < order) emit(entry.record);
    emit(record);
  }
  return output;
}


function canonicalCompletedId(record: WorkbookTimelineRecord): BlockId | undefined {
  if (record.type === "block_completed") {
    if (record.blockId.includes("--")) return record.blockId;
    if (record.lessonId) return declaredBlockId(record.lessonId, record.blockId);
  }
  if (record.type === "workbook_introduction_completed") return WORKBOOK_INTRODUCTION_BLOCK_ID;
  if ((record.type === "block_continued" || record.type === "lesson_transitioned" || record.type === "reflection_completed" || record.type === "editor_practice_unlocked") && record.lessonId && record.blockId) return declaredBlockId(record.lessonId, record.blockId);
  return undefined;
}

function completedBlockTimeline(loaded: LoadedWorkbook, projection: WorkbookProjectionState, records: readonly WorkbookTimelineRecord[]): PublicTimelineRecord[] {
  if (!records.some((record) => record.type === "lesson_jump_started")) return publicTimeline(loaded, records);
  const existing = publicTimeline(loaded, records);
  const authored = new Set(existing.flatMap((record) => record.type === "message" && record.source === "authored" && record.presentation === "course" ? [record.blockId] : []));
  const completed = projection.stream.flatMap((block) => {
    if (!projection.completedBlockIds.has(block.id) || authored.has(block.id)) return [];
    const completion = [...records].reverse().find((record) => canonicalCompletedId(record) === block.id);
    return [{
      id: `completed:${block.id}`,
      sequence: completion?.sequence ?? 0,
      at: completion?.at ?? new Date(0).toISOString(),
      type: "message" as const,
      lessonId: block.lessonId,
      blockId: block.id,
      role: "assistant" as const,
      source: "authored" as const,
      presentation: "course" as const,
      text: blockText(block, loaded.identity.title),
    }];
  });
  return publicTimeline(loaded, [...records, ...completed]);
}

function canonicalWorkAcceptedId(record: WorkbookTimelineRecord): BlockId | undefined {
  if (record.type === "work_accepted") return record.blockId;
  return undefined;
}

function projectWorkbookBlocks(stream: OrderedWorkbookBlock[], records: readonly WorkbookTimelineRecord[]): WorkbookProjectionState {
  const validIds = new Set(stream.map((block) => block.id));
  const completedBlockIds = new Set<BlockId>();
  const workAcceptedBlockIds = new Set<BlockId>();
  for (const record of records) {
    const completedId = canonicalCompletedId(record);
    if (completedId && validIds.has(completedId)) completedBlockIds.add(completedId);
    const acceptedId = canonicalWorkAcceptedId(record);
    if (acceptedId && validIds.has(acceptedId)) workAcceptedBlockIds.add(acceptedId);
  }
  const activeIndex = stream.findIndex((block) => !completedBlockIds.has(block.id));
  const current = activeIndex >= 0 ? stream[activeIndex] : undefined;
  const workbookComplete = !current;
  const readyBlockIds = new Set<BlockId>();
  if (current && workAcceptedBlockIds.has(current.id)) {
    const successor = stream[activeIndex + 1];
    if (successor && !completedBlockIds.has(successor.id)) readyBlockIds.add(successor.id);
  }
  return {
    stream,
    completedBlockIds,
    workAcceptedBlockIds,
    readyBlockIds,
    current,
    activeBlockId: current?.id ?? WORKBOOK_COMPLETE_ANCHOR_ID,
    activeAnchorId: current?.anchorId ?? WORKBOOK_COMPLETE_ANCHOR_ID,
    activeIndex: activeIndex >= 0 ? activeIndex : stream.length,
    workbookComplete,
  };
}

function isNavigable(workbookProjection: WorkbookProjectionState, blockId: BlockId): boolean {
  const index = workbookProjection.stream.findIndex((block) => block.id === blockId);
  return index >= 0 && index <= workbookProjection.activeIndex;
}

function isRendered(workbookProjection: WorkbookProjectionState, blockId: BlockId): boolean {
  return isNavigable(workbookProjection, blockId) || workbookProjection.readyBlockIds.has(blockId);
}

function declaredRefForInput(workbookProjection: WorkbookProjectionState, blockId: string): DeclaredWorkbookBlock | undefined {
  const current = workbookProjection.current;
  if (current?.origin === "declared" && (current.id === blockId || current.declaredId === blockId)) return current;
  const canonical = declaredSourceFromBlockId(blockId);
  if (canonical) return workbookProjection.stream.find((block): block is DeclaredWorkbookBlock => block.origin === "declared" && block.lessonId === canonical.lessonId && block.declaredId === canonical.declaredId);
  return undefined;
}

function publicOrderedBlock(block: OrderedWorkbookBlock, index: number): PublicWorkbookOrderedBlock {
  return {
    id: block.id,
    anchorId: block.anchorId,
    origin: block.origin,
    kind: block.kind,
    title: block.title,
    lessonId: block.lessonId,
    declaredId: block.origin === "declared" ? block.declaredId : undefined,
    order: index,
  };
}

function terminalSnapshotProjection(records: readonly WorkbookTimelineRecord[]): ReadonlyMap<string, PublicTerminalSnapshot> {
  const accepted = new Map(records.flatMap((record) => record.type === "attempt_accepted" && record.kind === "terminal" ? [[record.attemptId, record] as const] : []));
  const snapshots = new Map<string, PublicTerminalSnapshot>();
  for (const record of records) {
    if (record.type !== "terminal-transcript-snapshotted") continue;
    const acceptance = accepted.get(record.attemptId);
    if (acceptance && acceptance.lessonId === record.lessonId && acceptance.blockId === record.blockId) snapshots.set(record.blockId, { transcript: record.transcript });
  }
  return snapshots;
}

function boundedPublicTerminalTranscript(output: string): string {
  const transcript = publicTerminalTranscript(output);
  return transcript.length > MAX_PUBLIC_TERMINAL_SNAPSHOT_BYTES ? transcript.slice(-MAX_PUBLIC_TERMINAL_SNAPSHOT_BYTES) : transcript;
}

async function terminalAttemptProjection(records: readonly WorkbookTimelineRecord[], terminalEvidence: TerminalEvidenceRepository, terminalSessionId: string): Promise<ReadonlyMap<string, ProjectedTerminalAttempt>> {
  const evidenceRefs = new Set<TerminalEvidenceRef>();
  for (const record of records) if (record.type === "terminal-command-finished") evidenceRefs.add(record.evidenceRef);
  const snapshots = new Map<TerminalEvidenceRef, TerminalEvidence>();
  await Promise.all([...evidenceRefs].map(async (evidenceRef) => {
    const evidence = await terminalEvidence.read(evidenceRef);
    if (evidence) snapshots.set(evidenceRef, evidence);
  }));
  return projectTerminalAttempts(records, (evidenceRef) => snapshots.get(evidenceRef), terminalSessionId);
}

async function publicState(loaded: LoadedWorkbook, workspaceRootForLesson: (lesson: WorkbookLesson) => string | undefined, records: WorkbookTimelineRecord[], attempts: AttemptStore, terminalEvidence: TerminalEvidenceRepository, terminalSessionId: string): Promise<PublicWorkbookState> {
  const stream = buildWorkbookBlockStream(loaded);
  const terminalAttempts = await terminalAttemptProjection(records, terminalEvidence, terminalSessionId);
  const terminalSnapshots = terminalSnapshotProjection(records);
  const workbookProjection = projectWorkbookBlocks(stream, records);
  const current = workbookProjection.current;
  const completedLessons = loaded.chapters.flatMap((chapter) => {
    const lessonIds = [lessonPreambleBlockIdForServer(chapter.lesson.id), ...chapter.lesson.blocks.map((block) => declaredBlockId(chapter.lesson.id, block.id))];
    return lessonIds.every((id) => workbookProjection.completedBlockIds.has(id)) ? [chapter.lesson.id] : [];
  });
  const canComplete = current ? canCompleteBlock(current, workbookProjection) : { eligible: false as const, reason: "complete" as const };
  const orderedBlocks = stream.map(publicOrderedBlock);
  const revealedBlockIds = new Set(stream.slice(0, workbookProjection.activeIndex + 1).map((block) => block.id));
  const renderedBlockIds = new Set([...revealedBlockIds, ...workbookProjection.readyBlockIds]);
  const completionTimes = new Map<string, string>();
  for (const record of records) if (record.type === "block_completed") completionTimes.set(record.blockId, record.at);

  const blocks = await Promise.all(stream.map(async (ordered): Promise<PublicWorkbookBlockProgress> => {
    const completed = workbookProjection.completedBlockIds.has(ordered.id);
    const active = current?.id === ordered.id;
    const ready = workbookProjection.readyBlockIds.has(ordered.id);
    const completedAt = completed ? completionTimes.get(ordered.id) : undefined;
    const base = { id: ordered.id, type: ordered.kind, anchorId: ordered.anchorId, origin: ordered.origin, kind: ordered.kind, title: ordered.title, ready, active, completed, ...(completedAt ? { completedAt } : {}), verified: false, emerged: renderedBlockIds.has(ordered.id), workAccepted: workbookProjection.workAcceptedBlockIds.has(ordered.id) };
    if (ordered.origin !== "declared") return base;
    const authored = ordered.block;
    const currentAttempt = isEvaluatedBlock(authored) ? await attempts.current(ordered.lessonId, ordered.id).catch(() => undefined) : undefined;
    const acceptedRecord = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "attempt_accepted" }> => record.type === "attempt_accepted" && record.blockId === ordered.id);
    const acceptedProjection = currentAttempt?.status === "accepted" && acceptedRecord && workbookProjection.workAcceptedBlockIds.has(ordered.id) ? { status: "accepted" as const, summary: currentAttempt.successMessage ?? acceptedRecord.summary, kind: currentAttempt.evidence.kind } : undefined;
    const checkpoint = publicCheckpoint(currentAttempt, acceptedProjection);
    const withCheckpoint = checkpoint ? { ...base, checkpoint } : base;
    if (authored.type === "terminal-practice") {
      const terminalAttempt = terminalAttempts.get(ordered.id);
      // Terminal lifecycle rows supersede the legacy AttemptStore projection for this block. The
      // lifecycle projection deliberately exposes only learner-facing state, never commands,
      // evidence snapshots, or attempt identities.
      // Terminal practice is projected only from Bash lifecycle records. In particular, an old
      // AttemptStore checkpoint is never a browser fallback: unfinished legacy work reopens idle.
      const terminal = terminalAttempt?.state === "running" ? { phase: "running" as const }
        : terminalAttempt?.state === "checking" ? { phase: "checking" as const }
          : terminalAttempt?.state === "feedback" && terminalAttempt.feedback ? { phase: "feedback" as const, message: terminalAttempt.feedback }
            : terminalAttempt?.state === "complete" && terminalAttempt.successMessage ? { phase: "complete" as const, message: terminalAttempt.successMessage }
              : undefined;
      return {
        ...base,
        verified: terminal?.phase === "complete",
        ...(terminal ? { terminal, terminalRevision: terminalAttempt!.revision } : {}),
        ...(terminal?.phase === "complete" && terminalSnapshots.has(ordered.id) ? { terminalSnapshot: terminalSnapshots.get(ordered.id)! } : {})
      };
    }
    if (authored.type === "editor-practice" && active && !completed) {
      if (currentAttempt?.evidence.kind === "editor") return { ...withCheckpoint, revision: currentAttempt.version, draftText: currentAttempt.evidence.text, editorStatus: checkpoint?.status === "reviewing" ? "reviewing" : checkpoint?.status === "feedback" ? "feedback" : checkpoint?.status === "accepted" ? "unlocked" : "editing" };
      const workspaceRoot = workspaceRootForLesson(ordered.chapter.lesson);
      return { ...withCheckpoint, revision: 0, draftText: workspaceRoot ? await readTargetDraftText(workspaceRoot, authored).catch(() => "") : "", editorStatus: "editing" };
    }
    if (authored.type === "editor-practice" && currentAttempt?.status === "accepted") return { ...withCheckpoint, revision: currentAttempt.version, editorStatus: "unlocked" };
    return withCheckpoint;
  }));

  const reflections: Record<string, string> = {};
  const reflectionConversations: Record<string, Array<{ role: "learner" | "tutor"; text: string }>> = {};
  for (const record of records) {
    if (record.type !== "message") continue;
    const ref = stream.find((block): block is DeclaredWorkbookBlock => block.origin === "declared" && block.id === record.blockId && block.kind === "reflection");
    if (!ref) continue;
    if (record.source === "learner") { reflections[ref.id] = record.text; (reflectionConversations[ref.id] ??= []).push({ role: "learner", text: record.text }); }
    if (record.source === "main_tutor" && record.presentation === "review") (reflectionConversations[ref.id] ??= []).push({ role: "tutor", text: record.text });
  }

  const chapters = loaded.chapters.map((chapter) => {
    const lessonPreambleRevealed = revealedBlockIds.has(lessonPreambleBlockIdForServer(chapter.lesson.id));
    if (!lessonPreambleRevealed) return { ...chapter, lesson: undefined };
    // A ready successor already has its authored timeline record. Its public block data is needed
    // to render that record's practice surface, but later blocks remain absent until they render.
    const renderedBlocks = chapter.lesson.blocks.filter((block) => renderedBlockIds.has(declaredBlockId(chapter.lesson.id, block.id))).map((block) => publicBlock({ ...block, id: declaredBlockId(chapter.lesson.id, block.id) } as WorkbookBlock));
    return { ...chapter, lesson: publicLesson({ ...chapter.lesson, blocks: renderedBlocks as WorkbookBlock[] }, renderedBlocks as WorkbookBlock[]) };
  });
  const progress = { activeLessonId: current?.origin === "declared" ? current.lessonId : current?.chapter?.lesson.id ?? loaded.chapters[0]?.lesson.id ?? "", activeBlockId: workbookProjection.activeBlockId, activeAnchorId: workbookProjection.activeAnchorId, completedLessons, completedBlocks: [...workbookProjection.completedBlockIds], workAcceptedBlocks: [...workbookProjection.workAcceptedBlockIds], readyBlocks: [...workbookProjection.readyBlockIds], blocks, reflections, reflectionConversations, canComplete: current ? { blockId: current.id, ...canComplete } : { blockId: WORKBOOK_COMPLETE_ANCHOR_ID, eligible: false, reason: "complete" }, workbookComplete: workbookProjection.workbookComplete };
  const completionSummary = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "workbook_completion_summary" }> => record.type === "workbook_completion_summary");
  return { workbook: loaded.identity, introduction: loaded.introduction, introductionComplete: workbookProjection.completedBlockIds.has(WORKBOOK_INTRODUCTION_BLOCK_ID), chapters, orderedBlocks, revealedBlockIds: [...revealedBlockIds], renderedBlockIds: [...renderedBlockIds], readyBlockIds: [...workbookProjection.readyBlockIds], currentBlock: current ? { ...publicOrderedBlock(current, workbookProjection.activeIndex), workAccepted: workbookProjection.workAcceptedBlockIds.has(current.id) } : undefined, completion: workbookProjection.workbookComplete ? { complete: true, anchorId: WORKBOOK_COMPLETE_ANCHOR_ID, summary: completionSummary?.text } : undefined, progress, timeline: completedBlockTimeline(loaded, workbookProjection, records), adapter: { modelBackedHelp: true, note: "Free-text help is block-scoped." } };
}

function lessonPreambleBlockIdForServer(lessonId: string): string { return `lesson--${lessonId}`; }

function canCompleteBlock(block: OrderedWorkbookBlock, projection: WorkbookProjectionState): { eligible: boolean; reason?: "ineligible" | "awaiting-acceptance" } {
  return projection.workAcceptedBlockIds.has(block.id) ? { eligible: true } : { eligible: false, reason: "awaiting-acceptance" };
}

export interface WorkbookWorkflowDependencies {
  contentRoot: string;
  workspaceRootForId: (workspaceId: string) => string | undefined;
  timeline: WorkbookTimeline;
  attempts: AttemptStore;
  mainTutor: MainWorkbookTutor;
  practiceCoach: PracticeCoach;
  terminalEvidence: TerminalEvidenceRepository;
  terminalAssessmentScheduler?: TerminalAssessmentScheduler;
  activeTerminalContext?: () => ActiveTerminalTranscriptContext | undefined;
  activeTerminalSnapshot?: () => ActiveTerminalPublicSnapshot | undefined;
  onTerminalContinued?: (block: ActiveObservedTerminalBlock) => void;
  log: TutorialLogger;
}

export class WorkbookWorkflowCommandError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export interface WorkbookWorkflowStateEvent { lessonId?: string; blockId?: string; revision?: number; status?: PublicCheckpoint["status"]; terminalPhase?: PublicTerminal["phase"]; }

export interface WorkbookWorkflow {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ReturnType<typeof publicState>;
  timeline(): PublicTimelineRecord[];
  subscribe(listener: (record: PublicTimelineRecord) => void): () => void;
  subscribeState(listener: (event: WorkbookWorkflowStateEvent) => void): () => void;
  activeObservedBlock(): ActiveObservedTerminalBlock | undefined;
  observeTerminalFact(fact: TerminalObservationFact): Promise<void>;
  submitAttempt(input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt>;
  completeBlock(blockId: string): Promise<CompleteBlockResult>;
  reloadContent(): Promise<{ outcome: "reloaded"; generation: number } | { outcome: "error"; message: string } | { outcome: "closed" }>;
  sendMessage(input: { blockId: string; text: string; blockInView?: string }): Promise<Awaited<ReturnType<typeof publicState>>>;
  submitEditor(blockId: string, text: string): Promise<Awaited<ReturnType<typeof publicState>>>;
  submitEvent(input: { blockId: string; action: string; response?: string }): Promise<Awaited<ReturnType<typeof publicState>>>;
  retry(failureId: string): Promise<Awaited<ReturnType<typeof publicState>>>;
}

export async function createWorkbookWorkflow({ contentRoot, workspaceRootForId, timeline, attempts, mainTutor, practiceCoach, terminalEvidence, terminalAssessmentScheduler: injectedTerminalAssessmentScheduler, activeTerminalContext: currentActiveTerminalContext, activeTerminalSnapshot: currentActiveTerminalSnapshot, onTerminalContinued, log }: WorkbookWorkflowDependencies): Promise<WorkbookWorkflow> {
  const assessmentScheduler = injectedTerminalAssessmentScheduler ?? terminalAssessmentScheduler;
  let loaded = await loadWorkbook(contentRoot);
  let stream = buildWorkbookBlockStream(loaded);
  let records = await timeline.read();
  let closed = false;
  const reviewFinalizers = new Set<Promise<unknown>>();
  const ordinaryCommands = new Set<Promise<unknown>>();
  const stateListeners = new Set<(event: WorkbookWorkflowStateEvent) => void>();
  const terminalSessionId = randomUUID();
  let reloadGeneration = 0;

  const append = async (input: Parameters<WorkbookTimeline["append"]>[0]): Promise<WorkbookTimelineRecord> => {
    const record = await timeline.appendWithinRun(input);
    records = [...records, record];
    return record;
  };
  const transact = <T>(operation: () => Promise<T>): Promise<T> => timeline.run(operation);
  const trackOrdinaryCommand = <T>(operation: () => Promise<T>): Promise<T> => {
    const command = operation();
    ordinaryCommands.add(command);
    void command.then(() => ordinaryCommands.delete(command), () => ordinaryCommands.delete(command));
    return command;
  };
  const publicReloadError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").trim().slice(0, 500) || "The workbook content could not be loaded yet.";
  };
  const generationIsCurrent = (generation: number): boolean => !closed && generation === reloadGeneration;
  const currentGeneration = (): number => reloadGeneration;
  const authoredMessageExists = (lessonId: string, blockId: string): boolean => records.some((record) => record.type === "message" && record.source === "authored" && record.lessonId === lessonId && record.blockId === blockId);
  const currentWorkbookProjection = (source = records) => projectWorkbookBlocks(stream, source);
  const activeOrderedBlock = (source = records) => currentWorkbookProjection(source).current;
  const activeDeclaredBlock = (source = records): DeclaredWorkbookBlock | undefined => {
    const active = activeOrderedBlock(source);
    return active?.origin === "declared" ? active : undefined;
  };
  const ensureAuthoredBlock = async (block: OrderedWorkbookBlock): Promise<TimelineMessage | undefined> => {
    if (authoredMessageExists(block.lessonId, block.id)) return undefined;
    return await append({ type: "message", lessonId: block.lessonId, blockId: block.id, role: "assistant", source: "authored", presentation: "course", text: blockText(block, loaded.identity.title) }) as TimelineMessage;
  };
  const successorOf = (block: OrderedWorkbookBlock): OrderedWorkbookBlock | undefined => {
    const index = stream.findIndex((candidate) => candidate.id === block.id);
    return index >= 0 ? stream[index + 1] : undefined;
  };
  const hasWorkAccepted = (blockId: string): boolean => records.some((record) => record.type === "work_accepted" && record.blockId === blockId);
  const ensureReadySuccessor = async (block: OrderedWorkbookBlock, generation = currentGeneration()): Promise<void> => {
    if (!generationIsCurrent(generation)) return;
    const successor = successorOf(block);
    if (successor && generationIsCurrent(generation)) await ensureAuthoredBlock(successor);
  };
  const recordWorkAccepted = async (block: OrderedWorkbookBlock, generation = currentGeneration()): Promise<WorkbookTimelineRecord | undefined> => {
    if (!generationIsCurrent(generation)) return undefined;
    let accepted: WorkbookTimelineRecord | undefined;
    if (!hasWorkAccepted(block.id)) accepted = await append({ type: "work_accepted", blockId: block.id });
    if (!generationIsCurrent(generation)) return accepted;
    await ensureReadySuccessor(block, generation);
    return accepted;
  };
  const ensureAuthoredCurrentBlock = async (): Promise<void> => {
    const active = activeOrderedBlock();
    if (!active) return;
    await ensureAuthoredBlock(active);
  };
  const ensureActiveWorkAcceptance = async (generation = currentGeneration()): Promise<void> => {
    if (!generationIsCurrent(generation)) return;
    const active = activeOrderedBlock();
    if (!active) return;
    await ensureAuthoredCurrentBlock();
    if (!generationIsCurrent(generation)) return;
    if (acceptsWorkImmediately(active)) await recordWorkAccepted(active, generation);
    else if (hasWorkAccepted(active.id)) await ensureReadySuccessor(active, generation);
  };

  const activeTerminalPrivateContext = async (active: DeclaredWorkbookBlock) => {
    if (active.block.type !== "terminal-practice") return undefined;
    const transcriptContext = currentActiveTerminalContext?.();
    if (!transcriptContext || transcriptContext.lessonId !== active.lessonId || transcriptContext.blockId !== active.id) return undefined;
    const finishedForAttempt = (attemptId: string) => records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }> =>
      record.type === "terminal-command-finished" && record.attemptId === attemptId);
    const submissions = [...records].reverse().filter((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-submitted" }> =>
      record.type === "terminal-command-submitted" &&
      record.lessonId === active.lessonId &&
      record.blockId === active.id);
    for (const submission of submissions) {
      const finished = finishedForAttempt(submission.attemptId);
      const runningCommand = { attemptId: submission.attemptId, command: submission.command, status: "running" as const };
      if (submission.terminalSessionId === terminalSessionId && !finished) return { transcript: transcriptContext.transcript, latestCommand: runningCommand };
      if (!finished) continue;
      const finishedEvidence = await terminalEvidence.read(finished.evidenceRef);
      if (!finishedEvidence || finishedEvidence.kind !== "finished" || finishedEvidence.command !== submission.command || finishedEvidence.exitStatus !== finished.exitStatus) {
        if (submission.terminalSessionId === terminalSessionId) return { transcript: transcriptContext.transcript, latestCommand: runningCommand };
        continue;
      }
      return {
        transcript: transcriptContext.transcript,
        latestCommand: {
          attemptId: submission.attemptId,
          command: submission.command,
          status: "finished" as const,
          exitStatus: finished.exitStatus,
          evidenceRef: finished.evidenceRef,
          finishedEvidence
        }
      };
    }
    return { transcript: transcriptContext.transcript };
  };
  const activeBlockContext = async (source = records, options: { includeTerminalContext?: boolean } = {}) => {
    const active = activeDeclaredBlock(source);
    if (!active) return undefined;
    const terminal = options.includeTerminalContext === false ? undefined : await activeTerminalPrivateContext(active);
    return {
      lessonId: active.lessonId,
      blockId: active.id,
      title: active.block.title,
      markdown: active.block.markdown,
      authorGuidance: "tutor" in active.block ? active.block.tutor : "",
      attempts: isEvaluatedBlock(active.block) && active.block.type !== "terminal-practice"
        ? (await attempts.list(active.lessonId, active.id)).filter((attempt) => !attempt.privateQuickFeedback)
        : [],
      ...(terminal ? { terminal } : {})
    };
  };
  const mainContext = async (options: { includeTerminalContext?: boolean } = {}): Promise<MainTutorContext> => {
    const projection = currentWorkbookProjection();
    const active = projection.current;
    const completeStatus = active ? canCompleteBlock(active, projection) : { eligible: false };
    return { records: mainTutorTimelineRecords(loaded, records), activeContext: await activeBlockContext(records, options), completionTool: active && completeStatus.eligible ? { blockId: active.id } : undefined };
  };
  const mainContextForTarget = async (_lessonId: string, blockId: string): Promise<MainTutorContext> => {
    const active = activeOrderedBlock();
    return active?.id === blockId ? mainContext() : { records: mainTutorTimelineRecords(loaded, records), activeContext: undefined };
  };
  const requireTutorText = (text: string, label: TutorFailure["operation"]): string => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`Empty tutor response for ${label}.`);
    return trimmed.slice(0, 1_000);
  };
  const workspaceRootForLesson = (lesson: WorkbookLesson): string | undefined => lesson.workspace ? workspaceRootForId(lesson.workspace) : undefined;
  const unavailableInteractiveWorkspaces = (workbook: LoadedWorkbook): string[] => {
    const unavailable = new Set<string>();
    for (const chapter of workbook.chapters) {
      const lesson = chapter.lesson;
      if (!lesson.workspace || !lesson.blocks.some((block) => block.type === "terminal-practice" || block.type === "editor-practice")) continue;
      if (!workspaceRootForId(lesson.workspace)) unavailable.add(lesson.workspace);
    }
    return [...unavailable].sort();
  };
  const unavailableInteractiveWorkspaceMessage = (workspaceIds: readonly string[]): string => {
    const quoted = workspaceIds.map((id) => `'${id}'`).join(", ");
    return `Workbook content declares interactive workspace ${quoted} that is not available in this running session. Start a new session to use newly declared workspaces.`;
  };
  const currentPublicState = () => publicState(loaded, workspaceRootForLesson, records, attempts, terminalEvidence, terminalSessionId);
  const attemptStateEvent = (attempt: Attempt): WorkbookWorkflowStateEvent => ({ lessonId: attempt.lessonId, blockId: attempt.blockId, revision: attempt.version, status: attempt.status === "superseded" ? undefined : attempt.status });
  const notifyStateChanged = (event: WorkbookWorkflowStateEvent): void => { if (!closed) for (const listener of stateListeners) listener(event); };
  const appendFailure = async (input: Omit<TutorFailure, "id" | "sequence" | "at" | "type"> & { operation: TutorFailure["operation"] }): Promise<void> => {
    await append({ type: "tutor_failed", ...input });
  };
  const logSummaryFailure = (operation: Extract<TutorFailure["operation"], "block_summary" | "lesson_summary" | "completion_summary">, { lessonId, blockId, requestId }: Pick<TutorFailure, "lessonId" | "blockId" | "requestId">, error: unknown): void => {
    log.info(`Workbook tutor ${operation} failed for ${lessonId}/${blockId} (request ${requestId}): ${error instanceof Error ? error.message : String(error)}`);
  };
  const appendReviewMessage = async (attempt: Attempt, text: string): Promise<TimelineMessage> => {
    const message = await append({ type: "message", lessonId: attempt.lessonId, blockId: attempt.blockId, role: "assistant", source: "main_tutor", presentation: "review", text }) as TimelineMessage;
    if (attempt.evidence.kind === "reflection") await append({ type: "reflection_reply_recorded", lessonId: attempt.lessonId, blockId: attempt.blockId, response: text });
    return message;
  };
  /**
   * This row is the acceptance commit record. Write it before mutating AttemptStore: if a later
   * store or timeline write fails, startup/reload can finish this declared decision rather than
   * leaving an accepted attempt that cannot be replaced or continued.
   */
  const appendAcceptedCheckpoint = async (attempt: Attempt, summary: string): Promise<void> => {
    const existing = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "attempt_accepted" }> => record.type === "attempt_accepted" && record.attemptId === attempt.id);
    if (existing) return;
    await append({ type: "attempt_accepted", lessonId: attempt.lessonId, blockId: attempt.blockId, attemptId: attempt.id, version: attempt.version, kind: attempt.evidence.kind, summary });
  };
  /** Terminal lifecycle attempts are not AttemptStore rows. Their durable Main Tutor acceptance
   * uses the same write-ahead checkpoint event without treating the transient model adapter as
   * stored attempt state. */
  const appendTerminalAcceptedCheckpoint = async (input: { lessonId: string; blockId: string; attemptId: string }, summary: string): Promise<void> => {
    const existing = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "attempt_accepted" }> => record.type === "attempt_accepted" && record.attemptId === input.attemptId);
    if (existing) return;
    await append({ type: "attempt_accepted", lessonId: input.lessonId, blockId: input.blockId, attemptId: input.attemptId, version: 1, kind: "terminal", summary });
  };
  /** Replay an interrupted two-store acceptance commit for the one block that can still advance. */
  const recoverAcceptedActiveAttempt = async (): Promise<void> => {
    const active = activeDeclaredBlock();
    if (!active || !isEvaluatedBlock(active.block)) return;
    let current = await attempts.current(active.lessonId, active.id).catch(() => undefined);
    if (!current || !evidenceMatchesBlock(current.evidence, active.block)) return;
    const pending = current;
    const commit = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "attempt_accepted" }> =>
      record.type === "attempt_accepted" && record.lessonId === active.lessonId && record.blockId === active.id && record.attemptId === pending.id && record.version === pending.version);
    if (commit && pending.status !== "accepted") current = await attempts.acceptCurrent(pending.id, commit.summary) ?? pending;
    if (current.status !== "accepted") return;
    // This also repairs legacy sessions interrupted after AttemptStore accepted but before its
    // timeline checkpoint was appended.
    await appendAcceptedCheckpoint(current, current.successMessage ?? commit?.summary ?? "Nice work — this attempt is accepted.");
    await recordWorkAccepted(active);
  };

  /** Replay the second half of a terminal Main Tutor acceptance if a process stopped after its
   * write-ahead `attempt_accepted` row but before `work_accepted` could advance the workbook. */
  const recoverAcceptedTerminalAttempt = async (): Promise<void> => {
    const active = activeDeclaredBlock();
    if (!active || active.block.type !== "terminal-practice" || hasWorkAccepted(active.id)) return;
    const submission = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-submitted" }> =>
      record.type === "terminal-command-submitted" && record.blockId === active.id);
    if (!submission || submission.lessonId !== active.lessonId) return;
    const finished = records.some((record) => record.type === "terminal-command-finished" && record.attemptId === submission.attemptId);
    const accepted = records.some((record) =>
      record.type === "attempt_accepted"
      && record.kind === "terminal"
      && record.attemptId === submission.attemptId
      && record.lessonId === active.lessonId
      && record.blockId === active.id
    );
    if (finished && accepted) await recordWorkAccepted(active);
  };

  const trackFinalizer = (finalizer: Promise<unknown>): void => {
    reviewFinalizers.add(finalizer);
    void finalizer.then(
      () => { reviewFinalizers.delete(finalizer); },
      () => { reviewFinalizers.delete(finalizer); }
    );
  };
  const finishReview = async (attempt: Attempt, privateGuidance: string, generation = reloadGeneration): Promise<void> => {
    if (!generationIsCurrent(generation)) return;
    const activeBeforeAssessment = activeDeclaredBlock();
    const currentBeforeAssessment = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
    if (!activeBeforeAssessment || activeBeforeAssessment.lessonId !== attempt.lessonId || activeBeforeAssessment.id !== attempt.blockId || !currentBeforeAssessment || currentBeforeAssessment.id !== attempt.id || !isEvaluatedBlock(activeBeforeAssessment.block) || !evidenceMatchesBlock(currentBeforeAssessment.evidence, activeBeforeAssessment.block)) return;

    let practiceCoachHandoff: PracticeCoachHandoff | undefined;
    if (currentBeforeAssessment.evidence.kind === "terminal") {
      try {
        // Provider work stays outside the timeline lock. The guarded finalizer below uses the
        // terminal observation's attempt identity as its stale-response generation.
        const advice = await practiceCoach.assess({ attempt: currentBeforeAssessment, rubric: privateGuidance });
        const routed = await transact(async () => {
          if (!generationIsCurrent(generation)) return undefined;
          const active = activeDeclaredBlock();
          const current = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
          if (!active || active.lessonId !== attempt.lessonId || active.id !== attempt.blockId || !current || current.id !== attempt.id || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(current.evidence, active.block)) return undefined;
          if (advice.outcome === "working") {
            const updated = await attempts.markQuickWorking(current.id);
            if (updated) notifyStateChanged(attemptStateEvent(updated));
            return null;
          }
          if (advice.outcome === "feedback") {
            const updated = await attempts.markQuickFeedback(current.id, requireTutorText(advice.text, "review"));
            if (updated) notifyStateChanged(attemptStateEvent(updated));
            return null;
          }
          return { outcome: advice.outcome, text: requireTutorText(advice.text, "review") } as PracticeCoachHandoff;
        });
        if (routed === undefined || routed === null || !generationIsCurrent(generation)) return;
        practiceCoachHandoff = routed;
      } catch (error) {
        // Coach failure is deliberately ordinary Main Tutor review, not a learner-visible failure.
        log.info(`Practice Coach unavailable for ${attempt.lessonId}/${attempt.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        if (!generationIsCurrent(generation)) return;
      }
    }

    let decision: TutorDecision;
    try { decision = await mainTutor.review({ ...(await mainContext()), attempt: currentBeforeAssessment, privateGuidance, practiceCoachHandoff }); }
    catch (error) {
      const failure = transact(async () => {
        if (!generationIsCurrent(generation)) return;
        log.info(`Workbook tutor review failed for ${attempt.lessonId}/${attempt.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        const feedback = await attempts.markFeedback(attempt.id, REVIEW_FAILURE_FEEDBACK);
        if (feedback) {
          try { await appendFailure({ lessonId: feedback.lessonId, blockId: feedback.blockId, requestId: feedback.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK }); }
          finally { notifyStateChanged(attemptStateEvent(feedback)); }
        }
      });
      trackFinalizer(failure);
      return;
    }

    const finalizer = transact(async () => {
      if (!generationIsCurrent(generation)) return;
      const active = activeDeclaredBlock();
      const current = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
      if (!active || active.lessonId !== attempt.lessonId || active.id !== attempt.blockId || !current || current.id !== attempt.id || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(current.evidence, active.block)) return;
      if (decision.outcome === "working") {
        const updated = await attempts.markWorking(current.id);
        if (updated) notifyStateChanged(attemptStateEvent(updated));
        return;
      }

      let message: string;
      try { message = requireTutorText(decision.message, "review"); }
      catch {
        log.info(`Workbook tutor review returned empty text for ${attempt.lessonId}/${attempt.blockId}.`);
        const updated = await attempts.markFeedback(current.id, REVIEW_FAILURE_FEEDBACK);
        try { await appendFailure({ lessonId: current.lessonId, blockId: current.blockId, requestId: current.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK }); }
        finally { if (updated) notifyStateChanged(attemptStateEvent(updated)); }
        return;
      }

      if (decision.outcome === "accepted") {
        if (current.evidence.kind === "editor" && active.block.type === "editor-practice") {
          try {
            const workspaceRoot = workspaceRootForLesson(active.chapter.lesson);
            if (!workspaceRoot) throw new Error(`Lesson '${active.lessonId}' has no live workspace.`);
            if (!await promoteCurrentEditorAttempt({ workspace: workspaceRoot, attempts, lessonId: active.lessonId, block: { ...active.block, id: active.id }, attemptId: current.id })) {
              const updated = await attempts.markFeedback(current.id, REVIEW_FAILURE_FEEDBACK);
              try { await appendFailure({ lessonId: current.lessonId, blockId: current.blockId, requestId: current.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK }); }
              finally { if (updated) notifyStateChanged(attemptStateEvent(updated)); }
              return;
            }
          } catch (error) {
            log.info(`Accepted editor attempt could not be promoted: ${error instanceof Error ? error.message : String(error)}`);
            const updated = await attempts.markFeedback(current.id, REVIEW_FAILURE_FEEDBACK);
            try { await appendFailure({ lessonId: current.lessonId, blockId: current.blockId, requestId: current.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK }); }
            finally { if (updated) notifyStateChanged(attemptStateEvent(updated)); }
            return;
          }
        }
        // `attempt_accepted` is a write-ahead acceptance commit. Recovery replays it into the
        // AttemptStore and work_accepted projection if any subsequent write is interrupted.
        await appendAcceptedCheckpoint(current, message);
        const accepted = await attempts.acceptCurrent(current.id, message);
        if (!accepted) return;
        await appendReviewMessage(accepted, message);
        await recordWorkAccepted(active);
        notifyStateChanged(attemptStateEvent(accepted));
        return;
      }

      const feedback = await attempts.markFeedback(current.id, message);
      if (!feedback) return;
      try { await appendReviewMessage(feedback, feedback.feedback ?? message); }
      finally { notifyStateChanged(attemptStateEvent(feedback)); }
    });
    trackFinalizer(finalizer);
  };

  const createAttempt = async (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt> => {
    if (closed) throw new Error("Workbook server is closed.");
    // This runs inside timeline.run(). Never trust guidance captured by a terminal/browser caller:
    // a reload can change the declared block while that caller is queued. The active declaration is
    // the only authority for the review prompt.
    const active = activeDeclaredBlock();
    if (!active || active.lessonId !== input.lessonId || active.id !== input.blockId || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(input.evidence, active.block)) throw new Error("This block is not active yet.");
    const attempt = await attempts.create({ lessonId: input.lessonId, blockId: input.blockId, evidence: input.evidence });
    const reviewing = await attempts.markReviewing(attempt.id) ?? attempt;
    void finishReview(reviewing, active.block.tutor);
    return reviewing;
  };
  const submitAttempt = (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt> => transact(() => createAttempt(input));
  const requeueActiveAttempt = async (options: { includeFeedback?: boolean; generation?: number } = { includeFeedback: true }): Promise<void> => {
    const generation = options.generation ?? currentGeneration();
    if (!generationIsCurrent(generation)) return;
    const active = activeDeclaredBlock();
    if (!active || !isEvaluatedBlock(active.block)) return;
    const current = await attempts.current(active.lessonId, active.id).catch(() => undefined);
    if (!generationIsCurrent(generation)) return;
    if (!current || current.status === "accepted" || current.status === "superseded" || (!options.includeFeedback && current.status === "feedback")) return;
    const reviewing = await attempts.markReviewing(current.id) ?? current;
    if (!generationIsCurrent(generation)) return;
    void finishReview(reviewing, active.block.tutor, generation);
  };

  const activeObservedBlock = (): ActiveObservedTerminalBlock | undefined => {
    const active = activeDeclaredBlock();
    if (active?.block.type !== "terminal-practice") return undefined;
    const workspaceRoot = workspaceRootForLesson(active.chapter.lesson);
    return workspaceRoot ? { lessonId: active.lessonId, blockId: active.id, workspaceId: active.chapter.lesson.workspace!, workspaceRoot } : undefined;
  };

  // One workflow owns one embedded terminal session. Bash submission starts an attempt; only its
  // immutable finished evidence can begin Practice Coach or Main Tutor work.
  type TerminalAssessmentRequest = {
    attemptId: string;
    lessonId: string;
    blockId: string;
    command: string;
    rubric: string;
    generation: number;
    evidenceRef: TerminalEvidenceRef;
  };
  const terminalAssessmentTimeouts = new Set<unknown>();
  const terminalAssessmentTasks = new Set<Promise<void>>();

  const trackTerminalAssessment = (task: Promise<void>): void => {
    terminalAssessmentTasks.add(task);
    void task.then(
      () => terminalAssessmentTasks.delete(task),
      (error) => {
        terminalAssessmentTasks.delete(task);
        log.info(`Terminal assessment task failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    );
  };
  const cancelAllTerminalAssessmentTimeouts = (): void => {
    for (const handle of [...terminalAssessmentTimeouts]) {
      assessmentScheduler.cancel(handle);
      terminalAssessmentTimeouts.delete(handle);
    }
  };
  const boundedDrain = async (promises: Promise<unknown>[], timeoutMs: number): Promise<void> => {
    if (promises.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const withTerminalAssessmentTimeout = async <T>(operation: Promise<T>): Promise<T> => {
    let handle: unknown;
    const timeout = new Promise<T>((_resolve, reject) => {
      handle = assessmentScheduler.schedule(TERMINAL_ASSESSMENT_TIMEOUT_MS, () => {
        terminalAssessmentTimeouts.delete(handle);
        reject(new TerminalAssessmentTimeoutError());
      });
      terminalAssessmentTimeouts.add(handle);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      assessmentScheduler.cancel(handle);
      terminalAssessmentTimeouts.delete(handle);
    }
  };
  const terminalRequestIsCurrent = (request: TerminalAssessmentRequest): DeclaredWorkbookBlock | undefined => {
    if (!generationIsCurrent(request.generation)) return undefined;
    const active = activeDeclaredBlock();
    if (!active || active.block.type !== "terminal-practice" || active.lessonId !== request.lessonId || active.id !== request.blockId) return undefined;
    const submission = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-submitted" }> =>
      record.type === "terminal-command-submitted" && record.attemptId === request.attemptId);
    const latestSubmission = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-submitted" }> =>
      record.type === "terminal-command-submitted" && record.blockId === request.blockId);
    if (!submission || latestSubmission?.attemptId !== request.attemptId || submission.lessonId !== request.lessonId || submission.blockId !== request.blockId || submission.command !== request.command) return undefined;
    if (records.some((record) => record.type === "attempt_accepted" && record.attemptId === request.attemptId) || records.some((record) => record.type === "work_accepted" && record.blockId === request.blockId)) return undefined;
    if (records.some((record) => record.type === "terminal-feedback-recorded" && record.attemptId === request.attemptId)) return undefined;
    const finished = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }> =>
      record.type === "terminal-command-finished" && record.attemptId === request.attemptId);
    return finished?.evidenceRef === request.evidenceRef ? active : undefined;
  };
  const terminalAttemptForAssessment = async (request: TerminalAssessmentRequest): Promise<Attempt | undefined> => {
    const evidence = await terminalEvidence.read(request.evidenceRef);
    if (!evidence || evidence.kind !== "finished" || evidence.command !== request.command) return undefined;
    // This object adapts immutable lifecycle evidence to the current model APIs. It is deliberately
    // never written to AttemptStore and its transcript never enters the browser contract.
    return {
      id: request.attemptId,
      lessonId: request.lessonId,
      blockId: request.blockId,
      version: 1,
      status: "reviewing",
      evidence: { kind: "terminal", transcript: JSON.stringify(evidence), terminalHtml: "" }
    };
  };
  const recordTerminalAssessmentFailure = async (request: TerminalAssessmentRequest): Promise<void> => {
    await transact(async () => {
      if (!terminalRequestIsCurrent(request)) return;
      await append({ type: "terminal-feedback-recorded", attemptId: request.attemptId, text: TERMINAL_REVIEW_FAILURE_FEEDBACK });
      notifyStateChanged({ lessonId: request.lessonId, blockId: request.blockId, status: "feedback", terminalPhase: "feedback" });
    });
  };
  const launchTerminalMainReview = (request: TerminalAssessmentRequest, handoff: PracticeCoachHandoff, attempt: Attempt): void => {
    const task = (async () => {
      const review = await transact(async () => {
        const active = terminalRequestIsCurrent(request);
        const recordedHandoff = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-coach-handoff-recorded" }> =>
          record.type === "terminal-coach-handoff-recorded" && record.attemptId === request.attemptId);
        if (!active || !recordedHandoff || recordedHandoff.outcome !== handoff.outcome || recordedHandoff.text !== handoff.text) return undefined;
        return { context: await mainContext({ includeTerminalContext: false }), active };
      });
      if (!review) return;

      let decision: TutorDecision;
      try {
        decision = await withTerminalAssessmentTimeout(mainTutor.review({ ...review.context, attempt, privateGuidance: request.rubric, practiceCoachHandoff: handoff }));
      } catch (error) {
        log.info(`Workbook tutor terminal review failed for ${request.lessonId}/${request.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        await recordTerminalAssessmentFailure(request);
        return;
      }

      let shouldRecordFailure = false;
      await transact(async () => {
        const active = terminalRequestIsCurrent(request);
        const recordedHandoff = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-coach-handoff-recorded" }> =>
          record.type === "terminal-coach-handoff-recorded" && record.attemptId === request.attemptId);
        if (!active || !recordedHandoff || recordedHandoff.outcome !== handoff.outcome || recordedHandoff.text !== handoff.text) return;
        if (decision.outcome === "working") { shouldRecordFailure = true; return; }
        let message: string;
        try { message = requireTutorText(decision.message, "review"); }
        catch {
          log.info(`Workbook tutor terminal review returned empty text for ${request.lessonId}/${request.blockId}.`);
          shouldRecordFailure = true;
          return;
        }
        if (decision.outcome === "feedback") {
          await append({ type: "terminal-feedback-recorded", attemptId: request.attemptId, text: message });
          notifyStateChanged({ lessonId: request.lessonId, blockId: request.blockId, status: "feedback", terminalPhase: "feedback" });
          return;
        }
        const activeSnapshot = currentActiveTerminalSnapshot?.();
        const evidence = activeSnapshot ? undefined : await terminalEvidence.read(request.evidenceRef);
        const transcript = activeSnapshot && activeSnapshot.lessonId === request.lessonId && activeSnapshot.blockId === request.blockId
          ? activeSnapshot.transcript
          : evidence?.kind === "finished"
            ? boundedPublicTerminalTranscript(evidence.interactions.filter((interaction) => interaction.kind === "output").map((interaction) => interaction.data).join(""))
            : "";
        // This is intentionally written for every terminal acceptance, even when the command
        // produced no output or a process restart lost the live manager. It never includes the
        // command, evidence reference, Coach handoff, rubric, or private transcript.
        await append({ type: "terminal-transcript-snapshotted", attemptId: request.attemptId, lessonId: request.lessonId, blockId: request.blockId, transcript });
        await appendTerminalAcceptedCheckpoint(request, message);
        await recordWorkAccepted(active);
        notifyStateChanged({ lessonId: request.lessonId, blockId: request.blockId, status: "accepted", terminalPhase: "complete" });
      });
      if (shouldRecordFailure) await recordTerminalAssessmentFailure(request);
    })();
    trackTerminalAssessment(task);
  };
  const launchTerminalAssessment = (request: TerminalAssessmentRequest): void => {
    const task = (async () => {
      const current = await transact(async () => terminalRequestIsCurrent(request));
      if (!current) return;
      const attempt = await terminalAttemptForAssessment(request);
      if (!attempt) { await recordTerminalAssessmentFailure(request); return; }

      let advice: Awaited<ReturnType<PracticeCoach["assess"]>>;
      try {
        advice = await withTerminalAssessmentTimeout(practiceCoach.assess({ attempt, rubric: request.rubric }));
      } catch (error) {
        log.info(`Practice Coach unavailable for ${request.lessonId}/${request.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        await recordTerminalAssessmentFailure(request);
        return;
      }

      let handoff: PracticeCoachHandoff | undefined;
      let shouldRecordFailure = false;
      await transact(async () => {
        if (!terminalRequestIsCurrent(request)) return;
        if (advice.outcome === "working") { shouldRecordFailure = true; return; }
        let text: string;
        try { text = requireTutorText(advice.text, "review"); }
        catch {
          log.info(`Practice Coach returned empty terminal feedback for ${request.lessonId}/${request.blockId}.`);
          shouldRecordFailure = true;
          return;
        }
        if (advice.outcome === "feedback") {
          await append({ type: "terminal-feedback-recorded", attemptId: request.attemptId, text });
          notifyStateChanged({ lessonId: request.lessonId, blockId: request.blockId, status: "feedback", terminalPhase: "feedback" });
          return;
        }
        await append({ type: "terminal-coach-handoff-recorded", attemptId: request.attemptId, outcome: advice.outcome, text });
        // The private handoff does not create a new browser phase; Checking covers Main Tutor work.
        handoff = { outcome: advice.outcome, text };
      });
      if (shouldRecordFailure) await recordTerminalAssessmentFailure(request);
      if (handoff) launchTerminalMainReview(request, handoff, attempt);
    })();
    trackTerminalAssessment(task);
  };

  const observeTerminalFact = (fact: TerminalObservationFact): Promise<void> => trackOrdinaryCommand(async () => {
    const request = await transact(async (): Promise<TerminalAssessmentRequest | undefined> => {
      if (closed) return undefined;
      const active = activeDeclaredBlock();
      if (!active || active.block.type !== "terminal-practice" || active.id !== fact.blockId) return undefined;

      if (fact.type === "terminal-command-submitted") {
        if (records.some((record) => record.type === "terminal-command-submitted" && record.attemptId === fact.attemptId)) return undefined;
        await append({
          type: "terminal-command-submitted",
          attemptId: fact.attemptId,
          lessonId: active.lessonId,
          blockId: active.id,
          command: fact.command,
          terminalSessionId
        });
        notifyStateChanged({ lessonId: active.lessonId, blockId: active.id, status: "working", terminalPhase: "running" });
        // Bash submission alone starts Running; no model can inspect it before final evidence.
        return undefined;
      }

      const submitted = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-submitted" }> =>
        record.type === "terminal-command-submitted" && record.attemptId === fact.attemptId);
      const currentSubmission = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-submitted" }> =>
        record.type === "terminal-command-submitted" && record.blockId === active.id);
      if (!submitted || currentSubmission?.attemptId !== fact.attemptId || submitted.lessonId !== active.lessonId || submitted.blockId !== active.id || submitted.command !== fact.evidence.command || fact.evidence.blockId !== active.id || fact.evidence.attemptId !== fact.attemptId) return undefined;

      const interactions = fact.evidence.interactions.map((interaction) => ({
        kind: interaction.type === "interactive-input" ? "input" as const : "output" as const,
        data: interaction.data
      }));
      if (records.some((record) => record.type === "terminal-command-finished" && record.attemptId === fact.attemptId)) return undefined;
      // The only terminal snapshot is the final, self-contained Bash-finished evidence.
      const evidenceRef = await terminalEvidence.writeFinished({ command: fact.evidence.command, interactions, exitStatus: fact.evidence.exitStatus });
      await append({ type: "terminal-command-finished", attemptId: fact.attemptId, exitStatus: fact.evidence.exitStatus, evidenceRef });
      notifyStateChanged({ lessonId: active.lessonId, blockId: active.id, status: "reviewing", terminalPhase: "checking" });
      return { attemptId: fact.attemptId, lessonId: active.lessonId, blockId: active.id, command: submitted.command, rubric: active.block.tutor, generation: reloadGeneration, evidenceRef };
    });
    if (!request) return;
    // Model calls begin only after their event write and timeline transaction have completed.
    launchTerminalAssessment(request);
  });
  /** Rebuild a completed command's pending final lifecycle after server restart/reload. */
  const requeueTerminalLifecycle = async (): Promise<void> => {
    const resume = await transact(async (): Promise<{ request: TerminalAssessmentRequest; handoff?: PracticeCoachHandoff } | undefined> => {
      const active = activeDeclaredBlock();
      if (!active || active.block.type !== "terminal-practice") return undefined;
      const submission = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-submitted" }> =>
        record.type === "terminal-command-submitted" && record.blockId === active.id);
      if (!submission || records.some((record) => record.type === "attempt_accepted" && record.attemptId === submission.attemptId) || hasWorkAccepted(active.id)) return undefined;
      const finished = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }> =>
        record.type === "terminal-command-finished" && record.attemptId === submission.attemptId);
      if (!finished) return undefined;
      const request: TerminalAssessmentRequest = {
        attemptId: submission.attemptId,
        lessonId: submission.lessonId,
        blockId: submission.blockId,
        command: submission.command,
        rubric: active.block.tutor,
        generation: reloadGeneration,
        evidenceRef: finished.evidenceRef
      };
      if (records.some((record) => record.type === "terminal-feedback-recorded" && record.attemptId === submission.attemptId)) return undefined;
      const handoff = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-coach-handoff-recorded" }> =>
        record.type === "terminal-coach-handoff-recorded" && record.attemptId === submission.attemptId);
      return handoff ? { request, handoff: { outcome: handoff.outcome, text: handoff.text } } : { request };
    });
    if (!resume) return;
    if (!resume.handoff) {
      launchTerminalAssessment(resume.request);
      return;
    }
    const attempt = await terminalAttemptForAssessment(resume.request);
    if (attempt) launchTerminalMainReview(resume.request, resume.handoff, attempt);
  };

  const summarizeDeparture = async (leaving: DeclaredWorkbookBlock, workflowId: string, generation = currentGeneration()): Promise<void> => {
    if (!generationIsCurrent(generation)) return;
    if (isEvaluatedBlock(leaving.block)) {
      try {
        const text = requireTutorText(await mainTutor.summarizeBlock({ ...(await mainContext()), lessonId: leaving.lessonId, blockId: leaving.id, coveredThroughId: workflowId }), "block_summary");
        if (!generationIsCurrent(generation)) return;
        await append({ type: "block_summarized", lessonId: leaving.lessonId, blockId: leaving.id, text, coveredThroughId: workflowId });
      } catch (error) {
        if (!generationIsCurrent(generation)) return;
        logSummaryFailure("block_summary", { lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId }, error);
        if (!generationIsCurrent(generation)) return;
        await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE });
      }
    }
    if (!generationIsCurrent(generation)) return;
    const projection = currentWorkbookProjection();
    const lessonComplete = stream.filter((block) => block.origin === "declared" && block.lessonId === leaving.lessonId).every((block) => projection.completedBlockIds.has(block.id));
    if (lessonComplete) {
      try {
        const text = requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: leaving.lessonId, coveredThroughId: workflowId }), "lesson_summary");
        if (!generationIsCurrent(generation)) return;
        await append({ type: "lesson_summarized", lessonId: leaving.lessonId, text, coveredThroughId: workflowId });
      } catch (error) {
        if (!generationIsCurrent(generation)) return;
        logSummaryFailure("lesson_summary", { lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId }, error);
        if (!generationIsCurrent(generation)) return;
        await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE });
      }
    }
  };

  const requestCompletionSummary = async (workflowId: string, generation = currentGeneration()): Promise<void> => {
    if (!generationIsCurrent(generation)) return;
    try {
      const text = requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: "workbook", coveredThroughId: workflowId }), "completion_summary");
      if (!generationIsCurrent(generation)) return;
      await append({ type: "workbook_completion_summary", text });
    } catch (error) {
      if (!generationIsCurrent(generation)) return;
      logSummaryFailure("completion_summary", { lessonId: WORKBOOK_COMPLETE_ANCHOR_ID, blockId: WORKBOOK_COMPLETE_ANCHOR_ID, requestId: workflowId }, error);
      if (!generationIsCurrent(generation)) return;
      await appendFailure({ lessonId: WORKBOOK_COMPLETE_ANCHOR_ID, blockId: WORKBOOK_COMPLETE_ANCHOR_ID, requestId: workflowId, operation: "completion_summary", publicMessage: TUTOR_UNAVAILABLE });
    }
  };

  const completeBlock = async (blockId: string, generation = currentGeneration()): Promise<CompleteBlockResult> => {
    if (!generationIsCurrent(generation)) return { outcome: "rejected", state: await currentPublicState(), reason: "not-current" };
    const projection = currentWorkbookProjection();
    const stateBefore = async () => await currentPublicState();
    if (projection.completedBlockIds.has(blockId)) return { outcome: "already-completed", state: await stateBefore() };
    const requested = stream.find((block) => block.id === blockId) ?? declaredRefForInput(projection, blockId);
    if (!requested) return { outcome: "rejected", state: await stateBefore(), reason: "unrevealed" };
    if (!isRendered(projection, requested.id) && requested.id !== projection.current?.id) return { outcome: "rejected", state: await stateBefore(), reason: "unrevealed" };
    if (projection.current?.id !== requested.id) return { outcome: "rejected", state: await stateBefore(), reason: "not-current" };
    const eligibility = canCompleteBlock(requested, projection);
    if (!eligibility.eligible) return { outcome: "rejected", state: await stateBefore(), reason: "ineligible" };
    const written = await append({ type: "block_completed", blockId: requested.id });
    if (requested.origin === "declared" && requested.block.type === "terminal-practice") {
      const workspaceRoot = workspaceRootForLesson(requested.chapter.lesson);
      try { if (workspaceRoot) onTerminalContinued?.({ lessonId: requested.lessonId, blockId: requested.id, workspaceId: requested.chapter.lesson.workspace!, workspaceRoot }); }
      catch (error) { log.info(`Could not reset completed terminal ${requested.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const nextProjection = currentWorkbookProjection();
    if (requested.origin === "declared") await summarizeDeparture(requested, written.id, generation);
    if (!generationIsCurrent(generation)) return { outcome: "completed", state: await currentPublicState(), navigationTarget: successorAnchor(stream, requested.id) };
    if (!nextProjection.current) await requestCompletionSummary(written.id, generation);
    if (!generationIsCurrent(generation)) return { outcome: "completed", state: await currentPublicState(), navigationTarget: successorAnchor(stream, requested.id) };
    if (nextProjection.current) await ensureActiveWorkAcceptance(generation);
    return { outcome: "completed", state: await currentPublicState(), navigationTarget: successorAnchor(stream, requested.id) };
  };

  const reloadContent = async (): Promise<{ outcome: "reloaded"; generation: number } | { outcome: "error"; message: string } | { outcome: "closed" }> => {
    if (closed) return { outcome: "closed" };
    let candidate: LoadedWorkbook;
    try {
      candidate = await loadWorkbook(contentRoot);
    } catch (error) {
      const message = publicReloadError(error);
      log.info(`Workbook content reload failed: ${message}`);
      return { outcome: "error", message };
    }
    const unavailable = unavailableInteractiveWorkspaces(candidate);
    if (unavailable.length) {
      const message = unavailableInteractiveWorkspaceMessage(unavailable);
      log.info(`Workbook content reload failed: ${message}`);
      return { outcome: "error", message };
    }
    const generation = await transact(async () => {
      if (closed) return reloadGeneration;
      reloadGeneration += 1;
      loaded = candidate;
      stream = buildWorkbookBlockStream(loaded);
      records = await timeline.read();
      await recoverAcceptedActiveAttempt();
      await recoverAcceptedTerminalAttempt();
      await ensureActiveWorkAcceptance();
      return reloadGeneration;
    });
    // Restoring a model session is deliberately outside the timeline transaction. Its finalizer
    // checks the generation before it changes durable workflow state.
    try {
      await mainTutor.restore(await mainContext());
      await transact(async () => {
        if (!generationIsCurrent(generation)) return;
        await requeueActiveAttempt({ includeFeedback: false, generation });
      });
      await requeueTerminalLifecycle();
    } catch (error) {
      if (!closed) await transact(async () => {
        if (!generationIsCurrent(generation)) return;
        log.info(`Workbook tutor restoration after content reload failed: ${error instanceof Error ? error.message : String(error)}`);
        const active = activeOrderedBlock();
        await appendFailure({ lessonId: active?.lessonId ?? WORKBOOK_INTRODUCTION_BLOCK_ID, blockId: active?.id ?? WORKBOOK_INTRODUCTION_BLOCK_ID, requestId: "content-reload", operation: "restore", publicMessage: TUTOR_UNAVAILABLE });
      });
    }
    return closed ? { outcome: "closed" } : { outcome: "reloaded", generation };
  };

  const sendMessage = ({ blockId, text, blockInView }: { blockId: string; text: string; blockInView?: string }) => trackOrdinaryCommand(async () => {
    const snapshot = await transact(async () => {
      if (closed) throw new Error("Workbook server is closed.");
      const active = activeOrderedBlock();
      const projection = currentWorkbookProjection();
      const target = active && active.id === blockId
        ? { lessonId: active.lessonId, blockId: active.id, active }
        : (!active && blockId === WORKBOOK_COMPLETE_ANCHOR_ID ? { lessonId: WORKBOOK_COMPLETE_ANCHOR_ID, blockId: WORKBOOK_COMPLETE_ANCHOR_ID, active: undefined } : undefined);
      if (!target) throw new WorkbookWorkflowCommandError(409, "This block is not active yet.");
      const visibleBlock = blockInView && (isNavigable(projection, blockInView) || blockInView === WORKBOOK_COMPLETE_ANCHOR_ID && projection.workbookComplete) ? blockInView : undefined;
      const learnerMessage = await append({ type: "message", lessonId: target.lessonId, blockId: target.blockId, role: "user", source: "learner", presentation: "chat", text, blockInView: visibleBlock }) as TimelineMessage;
      return { generation: reloadGeneration, target, learnerMessage, tutorContext: await mainContextForTarget(target.lessonId, target.blockId) };
    });
    let reply: Awaited<ReturnType<MainWorkbookTutor["reply"]>> | undefined;
    let providerError: unknown;
    try { reply = await mainTutor.reply({ ...snapshot.tutorContext, learnerMessage: snapshot.learnerMessage }); }
    catch (error) { providerError = error; }
    return await transact(async () => {
      if (closed) throw new Error("Workbook server is closed.");
      const active = activeOrderedBlock();
      const stillActive = snapshot.target.active
        ? active?.id === snapshot.target.blockId && active.lessonId === snapshot.target.lessonId
        : !active && snapshot.target.blockId === WORKBOOK_COMPLETE_ANCHOR_ID;
      if (!generationIsCurrent(snapshot.generation) || !stillActive) return await currentPublicState();
      if (providerError) {
        log.info(`Workbook tutor reply failed for ${snapshot.target.lessonId}/${snapshot.target.blockId}: ${providerError instanceof Error ? providerError.message : String(providerError)}`);
        await appendFailure({ lessonId: snapshot.target.lessonId, blockId: snapshot.target.blockId, requestId: snapshot.learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE });
        return await currentPublicState();
      }
      if (typeof reply !== "string" && reply!.outcome === "complete-block") {
        await completeBlock(reply!.blockId);
        return await currentPublicState();
      }
      try {
        const textReply = requireTutorText(reply as string, "reply");
        await append({ type: "message", lessonId: snapshot.target.lessonId, blockId: snapshot.target.blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: textReply, inReplyTo: snapshot.learnerMessage.id }) as TimelineMessage;
      } catch (error) {
        log.info(`Workbook tutor reply failed for ${snapshot.target.lessonId}/${snapshot.target.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        await appendFailure({ lessonId: snapshot.target.lessonId, blockId: snapshot.target.blockId, requestId: snapshot.learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE });
      }
      return await currentPublicState();
    });
  });


  const submitEditor = async (blockId: string, text: string) => {
    const active = activeDeclaredBlock();
    if (!active || active.block.type !== "editor-practice" || (active.id !== blockId && active.declaredId !== blockId)) throw new WorkbookWorkflowCommandError(409, "This editor block is not active yet.");
    const workspaceRoot = workspaceRootForLesson(active.chapter.lesson);
    if (!workspaceRoot) throw new WorkbookWorkflowCommandError(400, `Lesson '${active.lessonId}' has no live workspace.`);
    try { await resolveEditorTarget(workspaceRoot, active.block.path); }
    catch (error) { throw new WorkbookWorkflowCommandError(400, error instanceof Error ? error.message : "Unsafe editor target path."); }
    await submitAttempt({ lessonId: active.lessonId, blockId: active.id, evidence: { kind: "editor", text }, privateGuidance: active.block.tutor });
    return await currentPublicState();
  };

  const submitEvent = async ({ blockId, action, response }: { blockId: string; action: string; response?: string }) => transact(async () => {
    const projection = currentWorkbookProjection();
    const active = declaredRefForInput(projection, blockId);
    if (!active || projection.current?.id !== active.id) throw new WorkbookWorkflowCommandError(409, "This block is not active yet.");
    const block = active.block;
    if ((action === "reflection-submit" || action === "reflection-follow-up") && block.type === "reflection") {
      const responseText = response ?? "";
      const priorConversation = records.filter((record): record is TimelineMessage => record.type === "message" && record.blockId === active.id && (record.source === "learner" || (record.source === "main_tutor" && record.presentation === "review"))).map((record) => ({ role: record.source === "learner" ? "learner" as const : "tutor" as const, text: record.text }));
      const first = action === "reflection-submit";
      if ((first && priorConversation.length > 0) || (!first && priorConversation.length === 0)) throw new WorkbookWorkflowCommandError(409, "Use a follow-up after the first reflection message.");
      const currentAttempt = await attempts.current(active.lessonId, active.id).catch(() => undefined);
      if (!first && currentAttempt?.status === "reviewing") throw new WorkbookWorkflowCommandError(409, "Wait for the tutor to finish reviewing before sending a follow-up.");
      const learnerTurns = await submitReflectionAttempt({ lessonId: active.lessonId, blockId: active.id, privateGuidance: block.tutor, response: responseText, conversation: priorConversation, submitAttempt: async () => undefined });
      const learnerText = learnerTurns.at(-1)!.text;
      await append({ type: "message", lessonId: active.lessonId, blockId: active.id, role: "user", source: "learner", presentation: "chat", text: learnerText });
      await append({ type: first ? "reflection_submitted" : "reflection_follow_up_submitted", lessonId: active.lessonId, blockId: active.id, response: learnerText });
      await createAttempt({ lessonId: active.lessonId, blockId: active.id, privateGuidance: block.tutor, evidence: { kind: "reflection", response: learnerText, conversation: priorConversation } });
      return await currentPublicState();
    }
    if (action !== "continue") throw new WorkbookWorkflowCommandError(400, "Invalid workbook action for this block.");
    return (await completeBlock(active.id)).state;
  });

  const retry = (failureId: string) => trackOrdinaryCommand(async () => transact(async () => {
    const failure = records.find((record): record is TutorFailure => record.type === "tutor_failed" && record.id === failureId);
    if (!failure) throw new WorkbookWorkflowCommandError(404, "Unknown tutor failure.");
    const generation = currentGeneration();
    if (!generationIsCurrent(generation)) return await currentPublicState();
    if (failure.operation === "reply") {
      const index = records.findIndex((record) => record.id === failure.id);
      const learnerMessage = [...records.slice(0, index)].reverse().find((record): record is TimelineMessage => record.type === "message" && record.source === "learner" && record.lessonId === failure.lessonId && record.blockId === failure.blockId);
      if (!learnerMessage) throw new WorkbookWorkflowCommandError(409, "The original learner message is unavailable.");
      try {
        const context = await mainContextForTarget(failure.lessonId, failure.blockId);
        if (!generationIsCurrent(generation)) return await currentPublicState();
        const reply = await mainTutor.reply({ ...context, learnerMessage });
        if (!generationIsCurrent(generation)) return await currentPublicState();
        if (typeof reply !== "string" && reply.outcome === "complete-block") { await completeBlock(reply.blockId, generation); return await currentPublicState(); }
        const textReply = requireTutorText(reply as string, "reply");
        if (!generationIsCurrent(generation)) return await currentPublicState();
        await append({ type: "message", lessonId: failure.lessonId, blockId: failure.blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: textReply, inReplyTo: learnerMessage.id }) as TimelineMessage;
      } catch {
        if (!generationIsCurrent(generation)) return await currentPublicState();
        await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE });
      }
    } else if (failure.operation === "restore") {
      try {
        const context = await mainContext();
        if (!generationIsCurrent(generation)) return await currentPublicState();
        await mainTutor.restore(context);
        if (!generationIsCurrent(generation)) return await currentPublicState();
        await requeueActiveAttempt({ generation });
      } catch {
        if (!generationIsCurrent(generation)) return await currentPublicState();
        await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE });
      }
    } else if (failure.operation === "review") {
      await requeueActiveAttempt({ generation });
    } else if (failure.operation === "block_summary") {
      const leaving = stream.find((block): block is DeclaredWorkbookBlock => block.origin === "declared" && block.lessonId === failure.lessonId && block.id === failure.blockId);
      if (leaving) {
        try {
          const context = await mainContext();
          if (!generationIsCurrent(generation)) return await currentPublicState();
          const text = requireTutorText(await mainTutor.summarizeBlock({ ...context, lessonId: leaving.lessonId, blockId: leaving.id, coveredThroughId: failure.requestId }), "block_summary");
          if (!generationIsCurrent(generation)) return await currentPublicState();
          await append({ type: "block_summarized", lessonId: leaving.lessonId, blockId: leaving.id, text, coveredThroughId: failure.requestId });
        } catch (error) {
          if (!generationIsCurrent(generation)) return await currentPublicState();
          logSummaryFailure("block_summary", { lessonId: leaving.lessonId, blockId: leaving.id, requestId: failure.requestId }, error);
          if (!generationIsCurrent(generation)) return await currentPublicState();
          await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: failure.requestId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE });
        }
      }
    } else if (failure.operation === "lesson_summary") {
      try {
        const context = await mainContext();
        if (!generationIsCurrent(generation)) return await currentPublicState();
        const text = requireTutorText(await mainTutor.summarizeLesson({ ...context, lessonId: failure.lessonId, coveredThroughId: failure.requestId }), "lesson_summary");
        if (!generationIsCurrent(generation)) return await currentPublicState();
        await append({ type: "lesson_summarized", lessonId: failure.lessonId, text, coveredThroughId: failure.requestId });
      } catch (error) {
        if (!generationIsCurrent(generation)) return await currentPublicState();
        logSummaryFailure("lesson_summary", { lessonId: failure.lessonId, blockId: failure.blockId, requestId: failure.requestId }, error);
        if (!generationIsCurrent(generation)) return await currentPublicState();
        await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: failure.requestId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE });
      }
    } else if (failure.operation === "completion_summary") {
      await requestCompletionSummary(failure.requestId, generation);
    }
    return await currentPublicState();
  }));


  return {
    start: async () => {
      if (records.length === 0) await transact(async () => { if (records.length === 0) await append({ type: "session_started" }); });
      await transact(async () => { await recoverAcceptedActiveAttempt(); await recoverAcceptedTerminalAttempt(); await ensureActiveWorkAcceptance(); });
      try {
        await mainTutor.restore(await mainContext());
        await transact(async () => { if (!closed) await requeueActiveAttempt(); });
        await requeueTerminalLifecycle();
      } catch (error) {
        if (!closed) {
          log.info(`Workbook tutor restoration failed: ${error instanceof Error ? error.message : String(error)}`);
          const active = activeOrderedBlock();
          await transact(() => appendFailure({ lessonId: active?.lessonId ?? WORKBOOK_INTRODUCTION_BLOCK_ID, blockId: active?.id ?? WORKBOOK_INTRODUCTION_BLOCK_ID, requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE }));
        }
      }
    },
    close: async () => {
      // New/queued ordinary commands observe `closed` when they enter either phase. Dispose model
      // roles first so active or racing provider sessions are cancelled before the short drain.
      closed = true;
      reloadGeneration += 1;
      cancelAllTerminalAssessmentTimeouts();
      mainTutor.dispose();
      practiceCoach.dispose();
      // Guarded callbacks observe `closed`; do not let a stalled provider prevent terminal close.
      await boundedDrain([...ordinaryCommands, ...reviewFinalizers, ...terminalAssessmentTasks], WORKFLOW_CLOSE_GRACE_MS);
    },
    state: currentPublicState,
    timeline: () => publicTimeline(loaded, records),
    subscribe: (listener) => timeline.subscribe((record) => { const publicRecord = publicTimelineRecord(record, loaded); if (publicRecord) listener(publicRecord); }),
    subscribeState: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    activeObservedBlock,
    observeTerminalFact,
    submitAttempt,
    completeBlock: (blockId) => trackOrdinaryCommand(async () => {
      const result = await transact(() => completeBlock(blockId));
      return result;
    }),
    reloadContent,
    sendMessage,
    submitEditor,
    submitEvent,
    retry,
  };
}
