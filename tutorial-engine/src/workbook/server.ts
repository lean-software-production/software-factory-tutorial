import { createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { TutorialLogger } from "./runtime-log.js";
import { createTutorialLogger } from "./runtime-log.js";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { project, type BlockProgress } from "./events.js";
import { INTRODUCTION_BLOCK_ID, INTRODUCTION_LESSON_ID, LESSON_FRAME_BLOCK_ID, PART_BLOCK_ID, authoredBlockText, authoredIntroductionText, authoredLessonFrameText, authoredPartText, partLessonId } from "./pi-history.js";
import { WORKBOOK_COMPLETE_ANCHOR_ID, WORKBOOK_INTRODUCTION_BLOCK_ID, blockText, buildWorkbookBlockStream, declaredBlockId, declaredSourceFromBlockId, successorAnchor, type AnchorId, type BlockId, type DeclaredWorkbookBlock, type OrderedWorkbookBlock } from "./workbook-blocks.js";
import { assertDockerTerminalReady, createDockerPty, requireOpenCodeApiKey, WorkbookTerminalManager, type ActiveObservedTerminalBlock, type TerminalPtyFactory } from "./terminal.js";
import { NO_RUNTIME_PROVISION, trustRuntimeProvision, type RuntimeProvisionProfile, type TrustedRuntimeProvision } from "./runtime-provision.js";
import { submitReflectionAttempt } from "./reflection.js";
import { promoteCurrentEditorAttempt, resolveEditorTarget } from "./editor.js";
import { AttemptStore, type Attempt, type AttemptEvidence } from "./attempts.js";
import { FastWorkbookBlockTutor, type WorkbookBlockTutor } from "./block-tutor.js";
import { DefaultMainWorkbookTutor, type MainTutorContext, type MainWorkbookTutor, type TutorDecision } from "./tutor.js";
import { tutorialStatePath } from "./tutorial-state.js";
import { WorkbookTimeline, type BlockTutorReadiness, type TimelineMessage, type TutorFailure, type WorkbookTimelineRecord } from "./timeline.js";
import { watchWorkbookContent, type ContentWatch, type ContentWatchFactory } from "./content-watch.js";
import type { EditorPracticeBlock, WorkbookBlock, WorkbookLesson } from "./contract.js";

const LOOPBACK_HOST = "127.0.0.1";
const MIME_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGE_BYTES = 4_000;
const REVIEW_FAILURE_FEEDBACK = "Review is temporarily unavailable. Please try another attempt in a moment.";
const TUTOR_UNAVAILABLE = "The tutor is temporarily unavailable. Please retry.";

export interface WorkbookRuntimeDescriptor { contentRoot: string; sessionRoot: string; workspaceRoot: string; runtimeProvision?: TrustedRuntimeProvision; }
export interface WorkbookServerOptions { target: string; webRoot: string; session?: WorkbookRuntimeDescriptor; runtimeProvision?: RuntimeProvisionProfile; port?: number; host?: string; logger?: TutorialLogger; embeddedTerminal?: boolean; terminalPtyFactory?: TerminalPtyFactory; terminalDebounceMs?: number; mainTutor?: MainWorkbookTutor; blockTutor?: WorkbookBlockTutor; watchContent?: boolean; contentWatchFactory?: ContentWatchFactory; contentWatchDebounceMs?: number; }
export interface StartedWorkbookServer { url: string; port: number; host: string; close(): Promise<void>; }

type PublicCheckpoint = {
  status: "working" | "reviewing" | "feedback" | "accepted";
  feedback?: string;
  successMessage?: string;
  evidence?: { kind: AttemptEvidence["kind"]; text?: string; terminalHtml?: string; conversation?: Array<{ role: "learner" | "tutor"; text: string }> };
};
type PublicBlockProgress = Omit<BlockProgress, "checkpoint"> & { checkpoint?: PublicCheckpoint; draftText?: string; revision?: number; editorStatus?: "editing" | "reviewing" | "feedback" | "unlocked" };
type PublicTutorFailure = Omit<TutorFailure, "requestId"> & { failureId: string };
type PublicTimelineRecord = TimelineMessage | PublicTutorFailure;
type CompleteBlockResult =
  | { outcome: "completed"; state: Awaited<ReturnType<typeof publicState>>; navigationTarget: AnchorId }
  | { outcome: "already-completed"; state: Awaited<ReturnType<typeof publicState>> }
  | { outcome: "rejected"; state: Awaited<ReturnType<typeof publicState>>; reason: "unrevealed" | "not-current" | "ineligible" };

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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
function headers(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'");
}
function isRoute(pathname: string, route: string): boolean { return pathname === `/api/workbook/${route}` || pathname.endsWith(`/api/workbook/${route}`); }
async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += buffer.length; if (length > MAX_BODY_BYTES) throw new Error("Request body is too large."); chunks.push(buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function assetPaths(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return ["/index.html"];
  const paths = segments.map((_, index) => `/${segments.slice(index).join("/")}`);
  return pathname.endsWith("/") ? [...paths, "/index.html"] : paths;
}
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === LOOPBACK_HOST || normalized === "localhost" || normalized === "::1";
}
function hostHeaderName(request: IncomingMessage): string | undefined { return request.headers.host?.split(":")[0]?.replace(/^\[/, "").replace(/\]$/, ""); }
function isTerminalRoute(pathname: string): boolean { return pathname === "/api/workbook/terminal" || pathname.endsWith("/api/workbook/terminal"); }
function originAllowed(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const parsed = new URL(origin); return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname) && Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) === port; }
  catch { return false; }
}
function parseTerminalMessage(data: RawData) { try { return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as any).toString("utf8")); } catch { return undefined; } }
function isEvaluatedBlock(block: WorkbookBlock): block is Extract<WorkbookBlock, { type: "editor-practice" | "terminal-practice" | "reflection" }> { return block.type === "editor-practice" || block.type === "terminal-practice" || block.type === "reflection"; }
function evidenceMatchesBlock(evidence: AttemptEvidence, block: WorkbookBlock): boolean { return (evidence.kind === "editor" && block.type === "editor-practice") || (evidence.kind === "terminal" && block.type === "terminal-practice") || (evidence.kind === "reflection" && block.type === "reflection"); }
function acceptsWorkImmediately(block: OrderedWorkbookBlock): boolean { return block.origin === "structural" || block.kind === "narrative" || block.kind === "lesson-transition"; }

function activeLesson(loaded: LoadedWorkbook, records: readonly WorkbookTimelineRecord[] = []): WorkbookLesson {
  const lessons = loaded.chapters.map((chapter) => chapter.lesson).filter((lesson): lesson is WorkbookLesson => Boolean(lesson));
  const lesson = lessons.find((candidate) => !project(records, candidate).completedLessons.includes(candidate.id)) ?? lessons.at(-1);
  if (!lesson) throw new Error("No workbook lesson is migrated.");
  return lesson;
}
function completedLessonIds(loaded: LoadedWorkbook, records: readonly WorkbookTimelineRecord[]): string[] {
  return loaded.chapters.flatMap((chapter) => chapter.lesson && project(records, chapter.lesson).completedLessons.includes(chapter.lesson.id) ? [chapter.lesson.id] : []);
}
function publicBlock(block: WorkbookBlock) { const { tutor: _privateTutor, ...visible } = block as WorkbookBlock & { tutor?: string }; return visible; }
function publicLesson(lesson: WorkbookLesson, blocks: WorkbookBlock[]) { return { ...lesson, blocks: blocks.map(publicBlock) }; }
async function readTargetDraftText(workspace: string, block: EditorPracticeBlock): Promise<string> { try { return await readFile(await resolveEditorTarget(workspace, block.path), "utf8"); } catch (error: any) { if (error?.code === "ENOENT") return ""; throw error; } }
function publicAttemptEvidence(attempt: Attempt): PublicCheckpoint["evidence"] {
  if (attempt.evidence.kind === "editor") return { kind: "editor", text: attempt.evidence.text };
  if (attempt.evidence.kind === "terminal") return { kind: "terminal", terminalHtml: attempt.evidence.terminalHtml };
  return { kind: "reflection", conversation: [...attempt.evidence.conversation, { role: "learner", text: attempt.evidence.response }] };
}
function publicCheckpoint(attempt: Attempt | undefined, projected: BlockProgress["checkpoint"]): PublicCheckpoint | undefined {
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
function publicTimelineRecord(record: WorkbookTimelineRecord, loaded?: LoadedWorkbook): PublicTimelineRecord | undefined {
  if (record.type === "message") {
    // Every review is logged, but a practice block shows only its latest feedback, beside the
    // work surface. Letting these into the conversation would replay the whole review history as
    // chat, so they are dropped here and reach the learner through the block's checkpoint instead.
    if (loaded && record.source === "main_tutor" && record.presentation === "review") {
      const kind = timelineMessageBlockKind(loaded, record);
      if (kind === "terminal-practice" || kind === "editor-practice") return undefined;
    }
    return record;
  }
  if (record.type !== "tutor_failed") return undefined;
  const { requestId: _privateRequestId, ...publicFailure } = record;
  return { ...publicFailure, failureId: record.id };
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
  const projected = records.flatMap((record) => { const publicRecord = publicTimelineRecord(record, loaded); return publicRecord ? [publicRecord] : []; });
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


async function requireDirectoryRoot(path: string, label: string): Promise<string> {
  const real = await realpath(resolve(path));
  if (!(await stat(real)).isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  return real;
}

async function resolveRuntime(options: WorkbookServerOptions): Promise<Required<WorkbookRuntimeDescriptor>> {
  const contentRoot = await requireDirectoryRoot(options.session?.contentRoot ?? options.target, "Workbook content root");
  const sessionRoot = options.session ? await requireDirectoryRoot(options.session.sessionRoot, "Workbook session root") : resolve(tutorialStatePath(options.target));
  const workspaceRoot = await requireDirectoryRoot(options.session?.workspaceRoot ?? options.target, "Workbook workspace root");
  const runtimeProvision = options.session?.runtimeProvision ?? (options.runtimeProvision ? trustRuntimeProvision(options.runtimeProvision) : NO_RUNTIME_PROVISION);
  return { contentRoot, sessionRoot, workspaceRoot, runtimeProvision };
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

function publicOrderedBlock(block: OrderedWorkbookBlock, index: number) {
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

async function publicState(loaded: LoadedWorkbook, learnerWorkspace: string, records: WorkbookTimelineRecord[], attempts: AttemptStore) {
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

  const blocks = await Promise.all(stream.map(async (ordered): Promise<PublicBlockProgress & { anchorId: string; origin: string; kind: string; title: string; workAccepted: boolean; completedAt?: string }> => {
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

export async function startWorkbookServer(options: WorkbookServerOptions): Promise<StartedWorkbookServer> {
  const log = options.logger ?? createTutorialLogger();
  await access(resolve(options.webRoot, "index.html"));
  const runtime = await resolveRuntime(options);
  let loaded = await loadWorkbook(runtime.contentRoot);
  let stream = buildWorkbookBlockStream(loaded);
  const learnerWorkspace = runtime.workspaceRoot;
  const embeddedTerminalEnabled = options.embeddedTerminal ?? true;
  const host = options.host ?? LOOPBACK_HOST;
  if (embeddedTerminalEnabled && !isLoopbackHost(host)) throw new Error("The embedded terminal can only be enabled on a loopback host; it exposes an isolated container shell.");
  if (embeddedTerminalEnabled) { requireOpenCodeApiKey(); if (!options.terminalPtyFactory) assertDockerTerminalReady({ workspace: learnerWorkspace, runtimeProvision: runtime.runtimeProvision }); }

  const timeline = new WorkbookTimeline({ stateRoot: runtime.sessionRoot });
  const attempts = new AttemptStore({ stateRoot: runtime.sessionRoot });
  const mainTutor = options.mainTutor ?? new DefaultMainWorkbookTutor({ workspace: runtime.contentRoot, log });
  const blockTutor = options.blockTutor ?? new FastWorkbookBlockTutor({ workspace: learnerWorkspace, contentRoot: runtime.contentRoot, log });
  let records = await timeline.read();
  let closed = false;
  let restoringFailed = false;
  const reviewFinalizers = new Set<Promise<unknown>>();
  let reloadGeneration = 0;
  let contentWatch: ContentWatch | undefined;
  let contentReloads: Promise<void> = Promise.resolve();
  const sseClients = new Set<ServerResponse>();

  const append = async (input: Parameters<WorkbookTimeline["append"]>[0]): Promise<WorkbookTimelineRecord> => {
    const record = await timeline.appendWithinRun(input);
    records = [...records, record];
    return record;
  };
  const transact = <T>(operation: () => Promise<T>): Promise<T> => timeline.run(operation);
  const sendSse = (response: ServerResponse, event: string, data: unknown): void => {
    if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcastSse = (event: string, data: unknown): void => {
    for (const client of sseClients) sendSse(client, event, data);
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
  const blockSupportsHints = (block: WorkbookBlock): block is Extract<WorkbookBlock, { type: "editor-practice" | "terminal-practice" }> => block.type === "editor-practice" || block.type === "terminal-practice";
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
    const authored = await ensureAuthoredBlock(active);
    if (active.origin === "declared" && blockSupportsHints(active.block) && !newestBriefing(active.lessonId, active.id)) await refreshBlockBriefing(active, authored?.id ?? records.at(-1)?.id ?? active.id);
  };
  const ensureActiveWorkAcceptance = async (): Promise<void> => {
    const active = activeOrderedBlock();
    if (!active) return;
    await ensureAuthoredCurrentBlock();
    if (acceptsWorkImmediately(active)) await recordWorkAccepted(active);
    else if (hasWorkAccepted(active.id)) await ensureReadySuccessor(active);
  };
  if (records.length === 0) await append({ type: "session_started" });

  const activeBlockContext = async (source = records) => {
    const active = activeDeclaredBlock(source);
    if (!active) return undefined;
    return {
      lessonId: active.lessonId,
      blockId: active.id,
      title: active.block.title,
      markdown: active.block.markdown,
      authorGuidance: "tutor" in active.block ? active.block.tutor : "",
      attempts: isEvaluatedBlock(active.block) ? await attempts.list(active.lessonId, active.id) : []
    };
  };
  const mainContext = async (): Promise<MainTutorContext> => {
    const projection = currentWorkbookProjection();
    const active = projection.current;
    const completeStatus = active ? canCompleteBlock(active, projection) : { eligible: false };
    return { records, activeContext: await activeBlockContext(), completionTool: active && completeStatus.eligible ? { blockId: active.id } : undefined };
  };
  const mainContextForTarget = async (_lessonId: string, blockId: string): Promise<MainTutorContext> => {
    const active = activeOrderedBlock();
    return active?.id === blockId ? mainContext() : { records, activeContext: undefined };
  };
  const requireTutorText = (text: string, label: TutorFailure["operation"]): string => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`Empty tutor response for ${label}.`);
    return trimmed.slice(0, 1_000);
  };
  const newestBriefing = (lessonId: string, blockId: string) => [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "block_tutor_briefed" }> => record.type === "block_tutor_briefed" && record.lessonId === lessonId && record.blockId === blockId);
  const currentPublicState = () => publicState(loaded, learnerWorkspace, records, attempts);
  const appendFailure = async (input: Omit<TutorFailure, "id" | "sequence" | "at" | "type"> & { operation: TutorFailure["operation"] }): Promise<void> => {
    await append({ type: "tutor_failed", ...input });
  };
  const refreshBlockBriefing = async (active: DeclaredWorkbookBlock, coveredThroughId: string, options: { silentFailure?: boolean } = {}): Promise<void> => {
    if (!blockSupportsHints(active.block)) return;
    const generation = reloadGeneration;
    try {
      const context = await activeBlockContext();
      const text = requireTutorText(await mainTutor.prepareBlockBriefing({ ...(await mainContext()), lessonId: active.lessonId, blockId: active.id, activeContext: context }), "briefing");
      if (!generationIsCurrent(generation)) return;
      await append({ type: "block_tutor_briefed", lessonId: active.lessonId, blockId: active.id, text, coveredThroughId });
    } catch (error) {
      if (!generationIsCurrent(generation)) return;
      log.info(`Workbook tutor briefing failed for ${active.lessonId}/${active.id}: ${error instanceof Error ? error.message : String(error)}`);
      if (!options.silentFailure) await appendFailure({ lessonId: active.lessonId, blockId: active.id, requestId: coveredThroughId, operation: "briefing", publicMessage: TUTOR_UNAVAILABLE });
    }
  };
  const appendReviewMessage = async (attempt: Attempt, text: string): Promise<TimelineMessage> => {
    const message = await append({ type: "message", lessonId: attempt.lessonId, blockId: attempt.blockId, role: "assistant", source: "main_tutor", presentation: "review", text }) as TimelineMessage;
    if (attempt.evidence.kind === "reflection") await append({ type: "reflection_reply_recorded", lessonId: attempt.lessonId, blockId: attempt.blockId, response: text });
    return message;
  };
  const appendAcceptedCheckpoint = async (accepted: Attempt): Promise<void> => {
    await append({ type: "attempt_accepted", lessonId: accepted.lessonId, blockId: accepted.blockId, attemptId: accepted.id, version: accepted.version, kind: accepted.evidence.kind, summary: accepted.successMessage ?? "Nice work — this attempt is accepted." });
  };

  await transact(ensureActiveWorkAcceptance);

  const trackFinalizer = (finalizer: Promise<unknown>): void => {
    reviewFinalizers.add(finalizer); void finalizer.finally(() => reviewFinalizers.delete(finalizer));
  };
  const finishReview = async (attempt: Attempt, privateGuidance: string, generation = reloadGeneration): Promise<void> => {
    if (!generationIsCurrent(generation)) return;
    const activeBeforeAssessment = activeDeclaredBlock();
    const currentBeforeAssessment = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
    if (!activeBeforeAssessment || activeBeforeAssessment.lessonId !== attempt.lessonId || activeBeforeAssessment.id !== attempt.blockId || !currentBeforeAssessment || currentBeforeAssessment.id !== attempt.id || !isEvaluatedBlock(activeBeforeAssessment.block) || !evidenceMatchesBlock(currentBeforeAssessment.evidence, activeBeforeAssessment.block)) return;

    let readiness: BlockTutorReadiness | undefined;
    if (currentBeforeAssessment.evidence.kind === "terminal" && blockTutor.assessTerminal) {
      try {
        const context = await activeBlockContext();
        if (!context) return;
        const advice = await blockTutor.assessTerminal({ context, attempt: currentBeforeAssessment });
        const quickCoachFinalizer = transact(async () => {
          if (!generationIsCurrent(generation)) return { continueToMain: false as const, readiness: undefined };
          const active = activeDeclaredBlock();
          const current = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
          if (!active || active.lessonId !== attempt.lessonId || active.id !== attempt.blockId || !current || current.id !== attempt.id || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(current.evidence, active.block)) return { continueToMain: false as const, readiness: undefined };
          if (advice.outcome === "feedback") {
            await attempts.markFeedback(current.id, requireTutorText(advice.text, "review"));
            return { continueToMain: false as const, readiness: undefined };
          }
          if (advice.outcome === "working") {
            await attempts.markWorking(current.id);
            return { continueToMain: false as const, readiness: undefined };
          }
          const recorded = await append({ type: "block_tutor_readiness", lessonId: current.lessonId, blockId: current.blockId, attemptId: current.id, readiness: advice.outcome, text: requireTutorText(advice.text, "readiness") }) as BlockTutorReadiness;
          return { continueToMain: true as const, readiness: recorded };
        });
        reviewFinalizers.add(quickCoachFinalizer); void quickCoachFinalizer.finally(() => reviewFinalizers.delete(quickCoachFinalizer));
        const quickCoach = await quickCoachFinalizer;
        if (!quickCoach.continueToMain || !generationIsCurrent(generation)) return;
        readiness = quickCoach.readiness;
      } catch (error) {
        log.info(`Workbook terminal quick coach unavailable for ${attempt.lessonId}/${attempt.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        if (!generationIsCurrent(generation)) return;
      }
    }

    let decision: TutorDecision;
    try { decision = await mainTutor.review({ ...(await mainContext()), attempt: currentBeforeAssessment, privateGuidance, readiness }); }
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
        const accepted = await attempts.acceptCurrent(current.id, message);
        if (!accepted) return;
        await appendReviewMessage(accepted, message);
        await appendAcceptedCheckpoint(accepted);
        await recordWorkAccepted(active);
        return;
      }

      const feedback = await attempts.markFeedback(current.id, message);
      if (!feedback) return;
      await appendReviewMessage(feedback, feedback.feedback ?? message);
      if (feedback.evidence.kind !== "reflection") await refreshBlockBriefing(active, feedback.id, { silentFailure: true });
    });
    trackFinalizer(finalizer);
  };

  const createAttempt = async (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt> => {
    if (closed) throw new Error("Workbook server is closed.");
    const active = activeDeclaredBlock();
    if (!active || active.lessonId !== input.lessonId || active.id !== input.blockId || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(input.evidence, active.block)) throw new Error("This block is not active yet.");
    const attempt = await attempts.create({ lessonId: input.lessonId, blockId: input.blockId, evidence: input.evidence });
    const reviewing = await attempts.markReviewing(attempt.id) ?? attempt;
    void finishReview(reviewing, input.privateGuidance);
    return reviewing;
  };
  const submitAttempt = (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt> => transact(() => createAttempt(input));
  const requeueActiveAttempt = async (): Promise<void> => {
    const active = activeDeclaredBlock();
    if (!active || !isEvaluatedBlock(active.block)) return;
    const current = await attempts.current(active.lessonId, active.id).catch(() => undefined);
    if (!current || current.status === "accepted" || current.status === "superseded") return;
    const reviewing = await attempts.markReviewing(current.id) ?? current;
    void finishReview(reviewing, active.block.tutor);
  };

  try { await mainTutor.restore(await mainContext()); await requeueActiveAttempt(); }
  catch (error) {
    restoringFailed = true;
    log.info(`Workbook tutor restoration failed: ${error instanceof Error ? error.message : String(error)}`);
    const active = activeOrderedBlock();
    await appendFailure({ lessonId: active?.lessonId ?? WORKBOOK_INTRODUCTION_BLOCK_ID, blockId: active?.id ?? WORKBOOK_INTRODUCTION_BLOCK_ID, requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE });
  }

  const activeObservedBlock = (): ActiveObservedTerminalBlock | undefined => {
    const active = activeDeclaredBlock();
    return active?.block.type === "terminal-practice" ? { lessonId: active.lessonId, blockId: active.id, command: active.block.markdown, context: active.block.markdown, expectedObservation: active.block.tutor } : undefined;
  };
  const terminal = embeddedTerminalEnabled ? new WorkbookTerminalManager({ workspace: learnerWorkspace, runtimeProvision: runtime.runtimeProvision, getActiveBlock: activeObservedBlock, submitAttempt: async (input) => { await submitAttempt(input); }, ptyFactory: options.terminalPtyFactory ?? createDockerPty, debounceMs: options.terminalDebounceMs, logger: log }) : undefined;

  const appendHintForActiveBlock = async (blockId: string, requestId: string): Promise<"ok" | "inactive"> => {
    const active = activeDeclaredBlock();
    if (!active || (active.id !== blockId && active.declaredId !== blockId) || !blockSupportsHints(active.block)) return "inactive";
    const briefing = newestBriefing(active.lessonId, active.id);
    if (!briefing) {
      await appendFailure({ lessonId: active.lessonId, blockId: active.id, requestId, operation: "briefing", publicMessage: TUTOR_UNAVAILABLE });
      return "ok";
    }
    try {
      const context = await activeBlockContext();
      if (!context) return "inactive";
      const hint = requireTutorText(await blockTutor.hint({ context, briefing: briefing.text }), "hint");
      await append({ type: "message", lessonId: active.lessonId, blockId: active.id, role: "assistant", source: "block_tutor", presentation: "hint", text: hint });
    } catch (error) {
      log.info(`Workbook block tutor hint failed for ${active.lessonId}/${active.id}: ${error instanceof Error ? error.message : String(error)}`);
      await appendFailure({ lessonId: active.lessonId, blockId: active.id, requestId, operation: "hint", publicMessage: TUTOR_UNAVAILABLE });
    }
    return "ok";
  };

  const summarizeDeparture = async (leaving: DeclaredWorkbookBlock, workflowId: string): Promise<void> => {
    try { await append({ type: "block_summarized", lessonId: leaving.lessonId, blockId: leaving.id, text: requireTutorText(await mainTutor.summarizeBlock({ ...(await mainContext()), lessonId: leaving.lessonId, blockId: leaving.id, coveredThroughId: workflowId }), "block_summary"), coveredThroughId: workflowId }); }
    catch { await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE }); }
    const projection = currentWorkbookProjection();
    const lessonComplete = stream.filter((block) => block.origin === "declared" && block.lessonId === leaving.lessonId).every((block) => projection.completedBlockIds.has(block.id));
    if (lessonComplete) {
      try { await append({ type: "lesson_summarized", lessonId: leaving.lessonId, text: requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: leaving.lessonId, coveredThroughId: workflowId }), "lesson_summary"), coveredThroughId: workflowId }); }
      catch { await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: workflowId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE }); }
    }
  };

  const requestCompletionSummary = async (workflowId: string): Promise<void> => {
    try {
      const text = requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: "workbook", coveredThroughId: workflowId }), "completion_summary");
      await append({ type: "workbook_completion_summary", text });
    } catch {
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

  const reloadContent = async (): Promise<void> => {
    if (closed) return;
    let candidate: LoadedWorkbook;
    try {
      candidate = await loadWorkbook(runtime.contentRoot);
    } catch (error) {
      const message = publicReloadError(error);
      log.info(`Workbook content reload failed: ${message}`);
      broadcastSse("content-reload-error", { message });
      return;
    }
    await transact(async () => {
      if (closed) return;
      reloadGeneration += 1;
      loaded = candidate;
      stream = buildWorkbookBlockStream(loaded);
      await attempts.resetPresentationState();
      await timeline.resetWithinRun();
      records = [];
      await append({ type: "session_started" });
      await ensureActiveWorkAcceptance();
      try {
        await mainTutor.restore(await mainContext());
        restoringFailed = false;
      } catch (error) {
        restoringFailed = true;
        log.info(`Workbook tutor restoration after content reload failed: ${error instanceof Error ? error.message : String(error)}`);
        const active = activeOrderedBlock();
        await appendFailure({ lessonId: active?.lessonId ?? WORKBOOK_INTRODUCTION_BLOCK_ID, blockId: active?.id ?? WORKBOOK_INTRODUCTION_BLOCK_ID, requestId: "content-reload", operation: "restore", publicMessage: TUTOR_UNAVAILABLE });
      }
    });
    if (closed) return;
    await contentWatch?.rescan().catch((error) => log.info(`Workbook content watcher rescan failed: ${error instanceof Error ? error.message : String(error)}`));
    broadcastSse("content-reloaded", { generation: reloadGeneration });
  };
  const queueContentReload = (): void => {
    contentReloads = contentReloads.then(reloadContent, reloadContent).catch((error) => {
      const message = publicReloadError(error);
      log.info(`Workbook content reload failed: ${message}`);
      broadcastSse("content-reload-error", { message });
    });
  };

  const server = createServer(async (request, response) => {
    headers(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && isRoute(url.pathname, "timeline")) {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      sseClients.add(response);
      sendSse(response, "timeline", publicTimeline(loaded, records));
      const unsubscribe = timeline.subscribe((record) => {
        const publicRecord = publicTimelineRecord(record, loaded);
        if (publicRecord) sendSse(response, "record", publicRecord);
      });
      request.on("close", () => { unsubscribe(); sseClients.delete(response); });
      return;
    }
    if (request.method === "GET" && isRoute(url.pathname, "state")) return transact(async () => sendJson(response, 200, await currentPublicState()));
    if (request.method === "POST" && isRoute(url.pathname, "introduction")) {
      return transact(async () => {
        const result = await completeBlock(WORKBOOK_INTRODUCTION_BLOCK_ID);
        sendJson(response, 202, result.state);
      });
    }
    if (request.method === "POST" && (isRoute(url.pathname, "complete-block") || isRoute(url.pathname, "completeBlock") || url.pathname.endsWith("/api/workbook/blocks/complete"))) {
      try {
        const body = await readJson(request);
        const blockId = typeof body.blockId === "string" ? body.blockId : "";
        if (!blockId) return sendJson(response, 400, { error: "blockId is required." });
        return transact(async () => sendJson(response, 202, await completeBlock(blockId)));
      } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "messages")) {
      try {
        const body = await readJson(request);
        const blockId = typeof body.blockId === "string" ? body.blockId : "";
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) return sendJson(response, 400, { error: "Message text is required." });
        if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return sendJson(response, 400, { error: "Message text is too large." });
        return transact(async () => {
          const active = activeOrderedBlock();
          const projection = currentWorkbookProjection();
          const target = active && active.id === blockId
            ? { lessonId: active.lessonId, blockId: active.id, active }
            : (!active && blockId === WORKBOOK_COMPLETE_ANCHOR_ID ? { lessonId: WORKBOOK_COMPLETE_ANCHOR_ID, blockId: WORKBOOK_COMPLETE_ANCHOR_ID, active: undefined } : undefined);
          if (!target) return sendJson(response, 409, { error: "This block is not active yet." });
          const blockInView = typeof body.blockInView === "string" && (isNavigable(projection, body.blockInView) || body.blockInView === WORKBOOK_COMPLETE_ANCHOR_ID && projection.workbookComplete) ? body.blockInView : undefined;
          const learnerMessage = await append({ type: "message", lessonId: target.lessonId, blockId: target.blockId, role: "user", source: "learner", presentation: "chat", text, blockInView });
          try {
            const reply = await mainTutor.reply({ ...(await mainContextForTarget(target.lessonId, target.blockId)), learnerMessage: learnerMessage as TimelineMessage });
            if (typeof reply !== "string" && reply.outcome === "complete-block") {
              await completeBlock(reply.blockId);
              return sendJson(response, 202, await currentPublicState());
            }
            const textReply = requireTutorText(reply as string, "reply");
            const tutorMessage = await append({ type: "message", lessonId: target.lessonId, blockId: target.blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: textReply, inReplyTo: learnerMessage.id });
            if (target.active?.origin === "declared") await refreshBlockBriefing(target.active, tutorMessage.id);
          } catch (error) {
            log.info(`Workbook tutor reply failed for ${target.lessonId}/${target.blockId}: ${error instanceof Error ? error.message : String(error)}`);
            await appendFailure({ lessonId: target.lessonId, blockId: target.blockId, requestId: learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE });
          }
          sendJson(response, 202, await currentPublicState());
        });
      } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "hints")) {
      try {
        const body = await readJson(request);
        const blockId = typeof body.blockId === "string" ? body.blockId : "";
        return transact(async () => {
          const result = await appendHintForActiveBlock(blockId, blockId || "hint");
          if (result === "inactive") return sendJson(response, 409, { error: "Hints are available only for the active editor or terminal block." });
          sendJson(response, 202, await currentPublicState());
        });
      } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "retry")) {
      try {
        const body = await readJson(request);
        return transact(async () => {
          const failure = records.find((record): record is TutorFailure => record.type === "tutor_failed" && record.id === body.failureId);
          if (!failure) return sendJson(response, 404, { error: "Unknown tutor failure." });
          if (failure.operation === "reply") {
            const index = records.findIndex((record) => record.id === failure.id);
            const learnerMessage = [...records.slice(0, index)].reverse().find((record): record is TimelineMessage => record.type === "message" && record.source === "learner" && record.lessonId === failure.lessonId && record.blockId === failure.blockId);
            if (!learnerMessage) return sendJson(response, 409, { error: "The original learner message is unavailable." });
            try {
              const active = activeDeclaredBlock();
              const reply = await mainTutor.reply({ ...(await mainContextForTarget(failure.lessonId, failure.blockId)), learnerMessage });
              if (typeof reply !== "string" && reply.outcome === "complete-block") { await completeBlock(reply.blockId); return sendJson(response, 202, await currentPublicState()); }
              const textReply = requireTutorText(reply as string, "reply");
              const tutorMessage = await append({ type: "message", lessonId: failure.lessonId, blockId: failure.blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: textReply, inReplyTo: learnerMessage.id });
              if (active && active.lessonId === failure.lessonId && active.id === failure.blockId) await refreshBlockBriefing(active, tutorMessage.id);
            } catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE }); }
          } else if (failure.operation === "hint") {
            await appendHintForActiveBlock(failure.blockId, failure.id);
          } else if (failure.operation === "briefing") {
            const active = activeDeclaredBlock();
            if (active && active.lessonId === failure.lessonId && active.id === failure.blockId) await refreshBlockBriefing(active, failure.id);
          } else if (failure.operation === "restore") {
            try { await mainTutor.restore(await mainContext()); restoringFailed = false; await requeueActiveAttempt(); }
            catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE }); }
          } else if (failure.operation === "readiness" || failure.operation === "review") {
            await requeueActiveAttempt();
          } else if (failure.operation === "block_summary") {
            const leaving = stream.find((block): block is DeclaredWorkbookBlock => block.origin === "declared" && block.lessonId === failure.lessonId && block.id === failure.blockId);
            if (leaving) {
              try { await append({ type: "block_summarized", lessonId: leaving.lessonId, blockId: leaving.id, text: requireTutorText(await mainTutor.summarizeBlock({ ...(await mainContext()), lessonId: leaving.lessonId, blockId: leaving.id, coveredThroughId: failure.requestId }), "block_summary"), coveredThroughId: failure.requestId }); }
              catch { await appendFailure({ lessonId: leaving.lessonId, blockId: leaving.id, requestId: failure.requestId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE }); }
            }
          } else if (failure.operation === "lesson_summary") {
            try { await append({ type: "lesson_summarized", lessonId: failure.lessonId, text: requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: failure.lessonId, coveredThroughId: failure.requestId }), "lesson_summary"), coveredThroughId: failure.requestId }); }
            catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: failure.requestId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE }); }
          } else if (failure.operation === "completion_summary") {
            await requestCompletionSummary(failure.requestId);
          }
          sendJson(response, 202, await currentPublicState());
        });
      } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "editor")) {
      try {
        const body = await readJson(request); const blockId = typeof body.blockId === "string" ? body.blockId : ""; const text = typeof body.text === "string" ? body.text : undefined;
        if (text === undefined) return sendJson(response, 400, { error: "Editor text must be a string." });
        if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return sendJson(response, 400, { error: "Editor text is too large." });
        const active = activeDeclaredBlock();
        if (!active || active.block.type !== "editor-practice" || (active.id !== blockId && active.declaredId !== blockId)) return sendJson(response, 409, { error: "This editor block is not active yet." });
        try { await resolveEditorTarget(learnerWorkspace, active.block.path); } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Unsafe editor target path." }); }
        await submitAttempt({ lessonId: active.lessonId, blockId: active.id, evidence: { kind: "editor", text }, privateGuidance: active.block.tutor });
        return sendJson(response, 202, await currentPublicState());
      } catch (error) { const message = error instanceof Error ? error.message : "Bad request."; return sendJson(response, /accepted work|not active/i.test(message) ? 409 : 400, { error: message }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "events")) {
      try {
        const body = await readJson(request);
        return transact(async () => {
          const projection = currentWorkbookProjection();
          const active = declaredRefForInput(projection, typeof body.blockId === "string" ? body.blockId : "");
          if (!active || projection.current?.id !== active.id) return sendJson(response, 409, { error: "This block is not active yet." });
          const block = active.block;
          if ((body.action === "reflection-submit" || body.action === "reflection-follow-up") && block.type === "reflection") {
            const responseText = typeof body.response === "string" ? body.response : "";
            const priorConversation = records.filter((record): record is TimelineMessage => record.type === "message" && record.blockId === active.id && (record.source === "learner" || (record.source === "main_tutor" && record.presentation === "review"))).map((record) => ({ role: record.source === "learner" ? "learner" as const : "tutor" as const, text: record.text }));
            const first = body.action === "reflection-submit";
            if ((first && priorConversation.length > 0) || (!first && priorConversation.length === 0)) return sendJson(response, 409, { error: "Use a follow-up after the first reflection message." });
            const currentAttempt = await attempts.current(active.lessonId, active.id).catch(() => undefined);
            if (!first && currentAttempt?.status === "reviewing") return sendJson(response, 409, { error: "Wait for the tutor to finish reviewing before sending a follow-up." });
            const learnerTurns = await submitReflectionAttempt({ lessonId: active.lessonId, blockId: active.id, privateGuidance: block.tutor, response: responseText, conversation: priorConversation, submitAttempt: async () => undefined });
            const learnerText = learnerTurns.at(-1)!.text;
            await append({ type: "message", lessonId: active.lessonId, blockId: active.id, role: "user", source: "learner", presentation: "chat", text: learnerText });
            await append({ type: first ? "reflection_submitted" : "reflection_follow_up_submitted", lessonId: active.lessonId, blockId: active.id, response: learnerText });
            await createAttempt({ lessonId: active.lessonId, blockId: active.id, privateGuidance: block.tutor, evidence: { kind: "reflection", response: learnerText, conversation: priorConversation } });
            return sendJson(response, 202, await currentPublicState());
          }
          if (body.action !== "continue") return sendJson(response, 400, { error: "Invalid workbook action for this block." });
          const result = await completeBlock(active.id);
          return sendJson(response, 202, result.state);
        });
      } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed." });
    const webRoot = resolve(options.webRoot);
    for (const requestPath of assetPaths(url.pathname)) {
      const candidate = resolve(webRoot, `.${requestPath}`);
      if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) return sendJson(response, 403, { error: "Forbidden." });
      try { await access(candidate); } catch { continue; }
      response.writeHead(200, { "Content-Type": MIME_TYPES[extname(candidate)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      if (request.method === "HEAD") response.end(); else createReadStream(candidate).pipe(response);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    if (request.method === "HEAD") response.end(); else createReadStream(resolve(webRoot, "index.html")).pipe(response);
  });
  const wss = terminal ? new WebSocketServer({ noServer: true }) : undefined;
  if (wss && terminal) {
    wss.on("connection", (socket: WebSocket) => {
      const client = { send: (message: string) => { if (socket.readyState === socket.OPEN) socket.send(message); }, close: (code?: number, reason?: string) => socket.close(code, reason) };
      if (!terminal.attach(client)) { socket.send(JSON.stringify({ type: "busy", message: "Another browser is already connected to this terminal." })); socket.close(1013, "Terminal already connected."); return; }
      socket.on("message", (data) => { const message = parseTerminalMessage(data); if (message?.type === "input" || message?.type === "resize") terminal.receive(message); });
      socket.on("close", () => terminal.detach(client));
      socket.on("error", (error) => log.info(`Workbook terminal WebSocket error: ${error instanceof Error ? error.message : String(error)}`));
    });
    server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? LOOPBACK_HOST}`); const address = server.address(); const portNumber = address && typeof address !== "string" ? address.port : 0;
      if (!isTerminalRoute(requestUrl.pathname) || !isLoopbackHost(hostHeaderName(request)) || !originAllowed(request, portNumber)) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
    });
  }
  const port = options.port ?? 0;
  await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolvePromise(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not determine workbook server address.");
  if (options.watchContent) {
    contentWatch = watchWorkbookContent(runtime.contentRoot, queueContentReload, (error) => log.info(`Workbook content watcher failed: ${error.message}`), { watchFactory: options.contentWatchFactory, debounceMs: options.contentWatchDebounceMs });
  }
  const url = `http://${LOOPBACK_HOST}:${address.port}`;
  log.info(`Workbook tutor listening on ${url}. State: ${timeline.eventPath}${terminal ? " Embedded terminal enabled on loopback only." : ""}${contentWatch ? " Content watch enabled." : ""}`);
  return { url, port: address.port, host, close: async () => { closed = true; contentWatch?.close(); terminal?.dispose(); mainTutor.dispose(); wss?.close(); for (const client of sseClients) client.end(); sseClients.clear(); await Promise.allSettled([contentReloads, ...reviewFinalizers]); const closing = new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())); server.closeAllConnections(); await closing; } };
}
