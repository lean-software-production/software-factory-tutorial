import { readFile } from "node:fs/promises";
import type { TutorialLogger } from "./runtime-log.js";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { INTRODUCTION_BLOCK_ID, INTRODUCTION_LESSON_ID, LESSON_FRAME_BLOCK_ID, PART_BLOCK_ID, partLessonId } from "./pi-history.js";
import { WORKBOOK_COMPLETE_ANCHOR_ID, WORKBOOK_INTRODUCTION_BLOCK_ID, blockText, buildWorkbookBlockStream, declaredBlockId, declaredSourceFromBlockId, successorAnchor, type AnchorId, type BlockId, type DeclaredWorkbookBlock, type OrderedWorkbookBlock } from "./workbook-blocks.js";
import type { ActiveObservedTerminalBlock } from "./terminal.js";
import { promoteCurrentEditorAttempt, resolveEditorTarget } from "./editor.js";
import { AttemptStore, type Attempt, type AttemptEvidence } from "./attempts.js";
import type { PracticeCoach } from "./practice-coach.js";
import type { MainTutorContext, MainWorkbookTutor, PracticeCoachHandoff, TutorDecision } from "./tutor.js";
import { WorkbookTimeline, type TimelineMessage, type TutorFailure, type WorkbookTimelineRecord } from "./timeline.js";
import { submitReflectionAttempt } from "./reflection.js";
import type { EditorPracticeBlock, WorkbookBlock, WorkbookLesson } from "./contract.js";
import type { PublicCheckpoint, PublicCompleteBlockResult, PublicTimelineRecord, PublicWorkbookBlock, PublicWorkbookBlockProgress, PublicWorkbookLesson, PublicWorkbookOrderedBlock, PublicWorkbookState } from "./public-contract.js";

const REVIEW_FAILURE_FEEDBACK = "Review is temporarily unavailable. Please try another attempt in a moment.";
const TUTOR_UNAVAILABLE = "The tutor is temporarily unavailable. Please retry.";

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
function publicLesson(lesson: WorkbookLesson, blocks: WorkbookBlock[]): PublicWorkbookLesson { return { ...lesson, blocks: blocks.map(publicBlock) }; }
async function readTargetDraftText(workspace: string, block: EditorPracticeBlock): Promise<string> { try { return await readFile(await resolveEditorTarget(workspace, block.path), "utf8"); } catch (error: any) { if (error?.code === "ENOENT") return ""; throw error; } }
function publicAttemptEvidence(attempt: Attempt): PublicCheckpoint["evidence"] {
  if (attempt.evidence.kind === "editor") return { kind: "editor", text: attempt.evidence.text };
  if (attempt.evidence.kind === "terminal") return { kind: "terminal", terminalHtml: attempt.evidence.terminalHtml };
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

async function publicState(loaded: LoadedWorkbook, learnerWorkspace: string, records: WorkbookTimelineRecord[], attempts: AttemptStore): Promise<PublicWorkbookState> {
  const stream = buildWorkbookBlockStream(loaded);
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
    if (authored.type === "terminal-practice") return { ...withCheckpoint, verified: currentAttempt?.status === "accepted", revision: currentAttempt?.version, terminalHtml: currentAttempt?.evidence.kind === "terminal" && currentAttempt.status === "accepted" ? currentAttempt.evidence.terminalHtml : undefined };
    if (authored.type === "editor-practice" && active && !completed) {
      if (currentAttempt?.evidence.kind === "editor") return { ...withCheckpoint, revision: currentAttempt.version, draftText: currentAttempt.evidence.text, editorStatus: checkpoint?.status === "reviewing" ? "reviewing" : checkpoint?.status === "feedback" ? "feedback" : checkpoint?.status === "accepted" ? "unlocked" : "editing" };
      return { ...withCheckpoint, revision: 0, draftText: await readTargetDraftText(learnerWorkspace, authored).catch(() => ""), editorStatus: "editing" };
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
    const emergedBlocks = chapter.lesson.blocks.filter((block) => revealedBlockIds.has(declaredBlockId(chapter.lesson.id, block.id))).map((block) => publicBlock({ ...block, id: declaredBlockId(chapter.lesson.id, block.id) } as WorkbookBlock));
    return { ...chapter, lesson: publicLesson({ ...chapter.lesson, blocks: emergedBlocks as WorkbookBlock[] }, emergedBlocks as WorkbookBlock[]) };
  });
  const progress = { activeLessonId: current?.origin === "declared" ? current.lessonId : current?.chapter?.lesson.id ?? loaded.chapters[0]?.lesson.id ?? "", activeBlockId: workbookProjection.activeBlockId, activeAnchorId: workbookProjection.activeAnchorId, completedLessons, completedBlocks: [...workbookProjection.completedBlockIds], workAcceptedBlocks: [...workbookProjection.workAcceptedBlockIds], readyBlocks: [...workbookProjection.readyBlockIds], blocks, reflections, reflectionConversations, canComplete: current ? { blockId: current.id, ...canComplete } : { blockId: WORKBOOK_COMPLETE_ANCHOR_ID, eligible: false, reason: "complete" }, workbookComplete: workbookProjection.workbookComplete };
  const completionSummary = [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "workbook_completion_summary" }> => record.type === "workbook_completion_summary");
  return { workbook: loaded.identity, introduction: loaded.introduction, introductionComplete: workbookProjection.completedBlockIds.has(WORKBOOK_INTRODUCTION_BLOCK_ID), chapters, orderedBlocks, revealedBlockIds: [...revealedBlockIds], renderedBlockIds: [...renderedBlockIds], readyBlockIds: [...workbookProjection.readyBlockIds], currentBlock: current ? { ...publicOrderedBlock(current, workbookProjection.activeIndex), workAccepted: workbookProjection.workAcceptedBlockIds.has(current.id) } : undefined, completion: workbookProjection.workbookComplete ? { complete: true, anchorId: WORKBOOK_COMPLETE_ANCHOR_ID, summary: completionSummary?.text } : undefined, progress, timeline: publicTimeline(loaded, records), adapter: { modelBackedHelp: true, note: "Free-text help is block-scoped." } };
}

function lessonPreambleBlockIdForServer(lessonId: string): string { return `lesson--${lessonId}`; }

function canCompleteBlock(block: OrderedWorkbookBlock, projection: WorkbookProjectionState): { eligible: boolean; reason?: "ineligible" | "awaiting-acceptance" } {
  return projection.workAcceptedBlockIds.has(block.id) ? { eligible: true } : { eligible: false, reason: "awaiting-acceptance" };
}

export interface WorkbookWorkflowDependencies {
  contentRoot: string;
  learnerWorkspace: string;
  timeline: WorkbookTimeline;
  attempts: AttemptStore;
  mainTutor: MainWorkbookTutor;
  practiceCoach: PracticeCoach;
  log: TutorialLogger;
}

export class WorkbookWorkflowCommandError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

export interface WorkbookWorkflow {
  start(): Promise<void>;
  close(): Promise<void>;
  state(): ReturnType<typeof publicState>;
  timeline(): PublicTimelineRecord[];
  subscribe(listener: (record: PublicTimelineRecord) => void): () => void;
  activeObservedBlock(): ActiveObservedTerminalBlock | undefined;
  submitAttempt(input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt>;
  completeBlock(blockId: string): Promise<CompleteBlockResult>;
  reloadContent(): Promise<{ outcome: "reloaded"; generation: number } | { outcome: "error"; message: string } | { outcome: "closed" }>;
  sendMessage(input: { blockId: string; text: string; blockInView?: string }): Promise<Awaited<ReturnType<typeof publicState>>>;
  submitEditor(blockId: string, text: string): Promise<Awaited<ReturnType<typeof publicState>>>;
  submitEvent(input: { blockId: string; action: string; response?: string }): Promise<Awaited<ReturnType<typeof publicState>>>;
  retry(failureId: string): Promise<Awaited<ReturnType<typeof publicState>>>;
}

export async function createWorkbookWorkflow({ contentRoot, learnerWorkspace, timeline, attempts, mainTutor, practiceCoach, log }: WorkbookWorkflowDependencies): Promise<WorkbookWorkflow> {
  let loaded = await loadWorkbook(contentRoot);
  let stream = buildWorkbookBlockStream(loaded);
  let records = await timeline.read();
  let closed = false;
  const reviewFinalizers = new Set<Promise<unknown>>();
  const ordinaryCommands = new Set<Promise<unknown>>();
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
  const ensureReadySuccessor = async (block: OrderedWorkbookBlock): Promise<void> => {
    const successor = successorOf(block);
    if (successor) await ensureAuthoredBlock(successor);
  };
  const recordWorkAccepted = async (block: OrderedWorkbookBlock): Promise<WorkbookTimelineRecord | undefined> => {
    let accepted: WorkbookTimelineRecord | undefined;
    if (!hasWorkAccepted(block.id)) accepted = await append({ type: "work_accepted", blockId: block.id });
    await ensureReadySuccessor(block);
    return accepted;
  };
  const ensureAuthoredCurrentBlock = async (): Promise<void> => {
    const active = activeOrderedBlock();
    if (!active) return;
    await ensureAuthoredBlock(active);
  };
  const ensureActiveWorkAcceptance = async (): Promise<void> => {
    const active = activeOrderedBlock();
    if (!active) return;
    await ensureAuthoredCurrentBlock();
    if (acceptsWorkImmediately(active)) await recordWorkAccepted(active);
    else if (hasWorkAccepted(active.id)) await ensureReadySuccessor(active);
  };

  const activeBlockContext = async (source = records) => {
    const active = activeDeclaredBlock(source);
    if (!active) return undefined;
    return {
      lessonId: active.lessonId,
      blockId: active.id,
      title: active.block.title,
      markdown: active.block.markdown,
      authorGuidance: "tutor" in active.block ? active.block.tutor : "",
      attempts: isEvaluatedBlock(active.block) ? (await attempts.list(active.lessonId, active.id)).filter((attempt) => !attempt.privateQuickFeedback) : []
    };
  };
  const mainContext = async (): Promise<MainTutorContext> => {
    const projection = currentWorkbookProjection();
    const active = projection.current;
    const completeStatus = active ? canCompleteBlock(active, projection) : { eligible: false };
    return { records: projectedTimelineRecords(loaded, records), activeContext: await activeBlockContext(), completionTool: active && completeStatus.eligible ? { blockId: active.id } : undefined };
  };
  const mainContextForTarget = async (_lessonId: string, blockId: string): Promise<MainTutorContext> => {
    const active = activeOrderedBlock();
    return active?.id === blockId ? mainContext() : { records: projectedTimelineRecords(loaded, records), activeContext: undefined };
  };
  const requireTutorText = (text: string, label: TutorFailure["operation"]): string => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`Empty tutor response for ${label}.`);
    return trimmed.slice(0, 1_000);
  };
  const currentPublicState = () => publicState(loaded, learnerWorkspace, records, attempts);
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

  const trackFinalizer = (finalizer: Promise<unknown>): void => {
    reviewFinalizers.add(finalizer); void finalizer.finally(() => reviewFinalizers.delete(finalizer));
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
          if (advice.outcome === "working") { await attempts.markQuickWorking(current.id); return null; }
          if (advice.outcome === "feedback") { await attempts.markQuickFeedback(current.id, requireTutorText(advice.text, "review")); return null; }
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
        if (feedback) await appendFailure({ lessonId: feedback.lessonId, blockId: feedback.blockId, requestId: feedback.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK });
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
        await attempts.markWorking(current.id);
        return;
      }

      let message: string;
      try { message = requireTutorText(decision.message, "review"); }
      catch {
        log.info(`Workbook tutor review returned empty text for ${attempt.lessonId}/${attempt.blockId}.`);
        await attempts.markFeedback(current.id, REVIEW_FAILURE_FEEDBACK);
        await appendFailure({ lessonId: current.lessonId, blockId: current.blockId, requestId: current.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK });
        return;
      }

      if (decision.outcome === "accepted") {
        if (current.evidence.kind === "editor" && active.block.type === "editor-practice") {
          try {
            if (!await promoteCurrentEditorAttempt({ workspace: learnerWorkspace, attempts, lessonId: active.lessonId, block: { ...active.block, id: active.id }, attemptId: current.id })) {
              await attempts.markFeedback(current.id, REVIEW_FAILURE_FEEDBACK);
              await appendFailure({ lessonId: current.lessonId, blockId: current.blockId, requestId: current.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK });
              return;
            }
          } catch (error) {
            log.info(`Accepted editor attempt could not be promoted: ${error instanceof Error ? error.message : String(error)}`);
            await attempts.markFeedback(current.id, REVIEW_FAILURE_FEEDBACK);
            await appendFailure({ lessonId: current.lessonId, blockId: current.blockId, requestId: current.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK });
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
        return;
      }

      const feedback = await attempts.markFeedback(current.id, message);
      if (!feedback) return;
      await appendReviewMessage(feedback, feedback.feedback ?? message);
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
  const requeueActiveAttempt = async (options: { includeFeedback?: boolean } = { includeFeedback: true }): Promise<void> => {
    const active = activeDeclaredBlock();
    if (!active || !isEvaluatedBlock(active.block)) return;
    const current = await attempts.current(active.lessonId, active.id).catch(() => undefined);
    if (!current || current.status === "accepted" || current.status === "superseded" || (!options.includeFeedback && current.status === "feedback")) return;
    const reviewing = await attempts.markReviewing(current.id) ?? current;
    void finishReview(reviewing, active.block.tutor);
  };

  const activeObservedBlock = (): ActiveObservedTerminalBlock | undefined => {
    const active = activeDeclaredBlock();
    return active?.block.type === "terminal-practice" ? { lessonId: active.lessonId, blockId: active.id, command: active.block.markdown, context: active.block.markdown, expectedObservation: active.block.tutor } : undefined;
  };


  const summarizeDeparture = async (leaving: DeclaredWorkbookBlock, workflowId: string): Promise<void> => {
    try { await append({ type: "block_summarized", lessonId: leaving.lessonId, blockId: leaving.id, text: requireTutorText(await mainTutor.summarizeBlock({ ...(await mainContext()), lessonId: leaving.lessonId, blockId: leaving.id, coveredThroughId: workflowId }), "block_summary"), coveredThroughId: workflowId }); }
    catch (error) {
      logSummaryFailure("block_summary", { lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId }, error);
      await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE });
    }
    const projection = currentWorkbookProjection();
    const lessonComplete = stream.filter((block) => block.origin === "declared" && block.lessonId === leaving.lessonId).every((block) => projection.completedBlockIds.has(block.id));
    if (lessonComplete) {
      try { await append({ type: "lesson_summarized", lessonId: leaving.lessonId, text: requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: leaving.lessonId, coveredThroughId: workflowId }), "lesson_summary"), coveredThroughId: workflowId }); }
      catch (error) {
        logSummaryFailure("lesson_summary", { lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId }, error);
        await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE });
      }
    }
  };

  const requestCompletionSummary = async (workflowId: string): Promise<void> => {
    try {
      const text = requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: "workbook", coveredThroughId: workflowId }), "completion_summary");
      await append({ type: "workbook_completion_summary", text });
    } catch (error) {
      logSummaryFailure("completion_summary", { lessonId: WORKBOOK_COMPLETE_ANCHOR_ID, blockId: WORKBOOK_COMPLETE_ANCHOR_ID, requestId: workflowId }, error);
      await appendFailure({ lessonId: WORKBOOK_COMPLETE_ANCHOR_ID, blockId: WORKBOOK_COMPLETE_ANCHOR_ID, requestId: workflowId, operation: "completion_summary", publicMessage: TUTOR_UNAVAILABLE });
    }
  };

  const completeBlock = async (blockId: string): Promise<CompleteBlockResult> => {
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
    const nextProjection = currentWorkbookProjection();
    if (requested.origin === "declared") await summarizeDeparture(requested, written.id);
    if (!nextProjection.current) await requestCompletionSummary(written.id);
    if (nextProjection.current) await ensureActiveWorkAcceptance();
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
    const generation = await transact(async () => {
      if (closed) return reloadGeneration;
      reloadGeneration += 1;
      loaded = candidate;
      stream = buildWorkbookBlockStream(loaded);
      records = await timeline.read();
      await recoverAcceptedActiveAttempt();
      await ensureActiveWorkAcceptance();
      return reloadGeneration;
    });
    // Restoring a model session is deliberately outside the timeline transaction. Its finalizer
    // checks the generation before it changes durable workflow state.
    try {
      await mainTutor.restore(await mainContext());
      await transact(async () => {
        if (!generationIsCurrent(generation)) return;
        await requeueActiveAttempt({ includeFeedback: false });
      });
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
    try { await resolveEditorTarget(learnerWorkspace, active.block.path); }
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
    if (failure.operation === "reply") {
      const index = records.findIndex((record) => record.id === failure.id);
      const learnerMessage = [...records.slice(0, index)].reverse().find((record): record is TimelineMessage => record.type === "message" && record.source === "learner" && record.lessonId === failure.lessonId && record.blockId === failure.blockId);
      if (!learnerMessage) throw new WorkbookWorkflowCommandError(409, "The original learner message is unavailable.");
      try {
        const active = activeDeclaredBlock();
        const reply = await mainTutor.reply({ ...(await mainContextForTarget(failure.lessonId, failure.blockId)), learnerMessage });
        if (typeof reply !== "string" && reply.outcome === "complete-block") { await completeBlock(reply.blockId); return await currentPublicState(); }
        const textReply = requireTutorText(reply as string, "reply");
        await append({ type: "message", lessonId: failure.lessonId, blockId: failure.blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: textReply, inReplyTo: learnerMessage.id }) as TimelineMessage;
      } catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE }); }
    } else if (failure.operation === "restore") {
      try { await mainTutor.restore(await mainContext()); await requeueActiveAttempt(); }
      catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE }); }
    } else if (failure.operation === "review") {
      await requeueActiveAttempt();
    } else if (failure.operation === "block_summary") {
      const leaving = stream.find((block): block is DeclaredWorkbookBlock => block.origin === "declared" && block.lessonId === failure.lessonId && block.id === failure.blockId);
      if (leaving) {
        try { await append({ type: "block_summarized", lessonId: leaving.lessonId, blockId: leaving.id, text: requireTutorText(await mainTutor.summarizeBlock({ ...(await mainContext()), lessonId: leaving.lessonId, blockId: leaving.id, coveredThroughId: failure.requestId }), "block_summary"), coveredThroughId: failure.requestId }); }
        catch (error) {
          logSummaryFailure("block_summary", { lessonId: leaving.lessonId, blockId: leaving.id, requestId: failure.requestId }, error);
          await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: failure.requestId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE });
        }
      }
    } else if (failure.operation === "lesson_summary") {
      try { await append({ type: "lesson_summarized", lessonId: failure.lessonId, text: requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: failure.lessonId, coveredThroughId: failure.requestId }), "lesson_summary"), coveredThroughId: failure.requestId }); }
      catch (error) {
        logSummaryFailure("lesson_summary", { lessonId: failure.lessonId, blockId: failure.blockId, requestId: failure.requestId }, error);
        await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: failure.requestId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE });
      }
    } else if (failure.operation === "completion_summary") {
      await requestCompletionSummary(failure.requestId);
    }
    return await currentPublicState();
  }));


  return {
    start: async () => {
      if (records.length === 0) await transact(async () => { if (records.length === 0) await append({ type: "session_started" }); });
      await transact(async () => { await recoverAcceptedActiveAttempt(); await ensureActiveWorkAcceptance(); });
      try {
        await mainTutor.restore(await mainContext());
        await transact(async () => { if (!closed) await requeueActiveAttempt(); });
      } catch (error) {
        if (!closed) {
          log.info(`Workbook tutor restoration failed: ${error instanceof Error ? error.message : String(error)}`);
          const active = activeOrderedBlock();
          await transact(() => appendFailure({ lessonId: active?.lessonId ?? WORKBOOK_INTRODUCTION_BLOCK_ID, blockId: active?.id ?? WORKBOOK_INTRODUCTION_BLOCK_ID, requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE }));
        }
      }
    },
    close: async () => {
      // New/queued ordinary commands observe `closed` when they enter either phase. Commands
      // already awaiting a provider are drained here; their guarded finalizer rejects rather than
      // appending into a closed workflow.
      closed = true;
      await Promise.allSettled([...ordinaryCommands, ...reviewFinalizers]);
    },
    state: currentPublicState,
    timeline: () => publicTimeline(loaded, records),
    subscribe: (listener) => timeline.subscribe((record) => { const publicRecord = publicTimelineRecord(record, loaded); if (publicRecord) listener(publicRecord); }),
    activeObservedBlock,
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
