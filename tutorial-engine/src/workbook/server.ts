import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LOOPBACK_HOST } from "../server/local-server.js";
import type { TutorialLogger } from "../runtime-log.js";
import { createTutorialLogger } from "../runtime-log.js";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { introductionCompleted, project, type BlockProgress } from "./events.js";
import { authoredBlockText } from "./pi-history.js";
import { assertDockerTerminalReady, createDockerPty, requireOpenCodeApiKey, WorkbookTerminalManager, type ActiveObservedTerminalBlock, type TerminalPtyFactory } from "./terminal.js";
import { submitReflectionAttempt } from "./reflection.js";
import { promoteCurrentEditorAttempt, resolveEditorTarget } from "./editor.js";
import { AttemptStore, type Attempt, type AttemptEvidence } from "./attempts.js";
import { FastWorkbookBlockTutor, type WorkbookBlockTutor } from "./block-tutor.js";
import { MainWorkbookTutor as DefaultMainWorkbookTutor, type MainTutorContext, type MainWorkbookTutor, type TutorDecision } from "./tutor.js";
import { WorkbookTimeline, type BlockTutorReadiness, type TimelineMessage, type TutorFailure, type WorkbookTimelineRecord } from "./timeline.js";
import type { EditorPracticeBlock, WorkbookBlock, WorkbookLesson } from "./contract.js";

const MIME_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGE_BYTES = 4_000;
const REVIEW_FAILURE_FEEDBACK = "Review is temporarily unavailable. Please try another attempt in a moment.";
const TUTOR_UNAVAILABLE = "The tutor is temporarily unavailable. Please retry.";

export interface WorkbookServerOptions { target: string; webRoot: string; port?: number; host?: string; logger?: TutorialLogger; embeddedTerminal?: boolean; terminalPtyFactory?: TerminalPtyFactory; terminalDebounceMs?: number; mainTutor?: MainWorkbookTutor; blockTutor?: WorkbookBlockTutor; }
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
function publicTimelineRecord(record: WorkbookTimelineRecord): PublicTimelineRecord | undefined {
  if (record.type === "message") return record;
  if (record.type !== "tutor_failed") return undefined;
  const { requestId: _privateRequestId, ...publicFailure } = record;
  return { ...publicFailure, failureId: record.id };
}
function publicTimeline(records: readonly WorkbookTimelineRecord[]): PublicTimelineRecord[] { return records.flatMap((record) => { const publicRecord = publicTimelineRecord(record); return publicRecord ? [publicRecord] : []; }); }

async function publicState(loaded: LoadedWorkbook, records: WorkbookTimelineRecord[], attempts: AttemptStore) {
  const lesson = activeLesson(loaded, records);
  const activeProgress = project(records, lesson);
  const completedLessons = completedLessonIds(loaded, records);
  const blocks = await Promise.all(activeProgress.blocks.map(async (progressBlock): Promise<PublicBlockProgress> => {
    const authored = lesson.blocks.find((candidate) => candidate.id === progressBlock.id);
    const currentAttempt = authored && isEvaluatedBlock(authored) ? await attempts.current(lesson.id, authored.id).catch(() => undefined) : undefined;
    const checkpoint = publicCheckpoint(currentAttempt, progressBlock.checkpoint);
    const base: PublicBlockProgress = checkpoint ? { ...progressBlock, checkpoint } : { ...progressBlock };
    if (authored?.type === "editor-practice" && progressBlock.active && progressBlock.ready && !progressBlock.completed) {
      if (currentAttempt?.evidence.kind === "editor") return { ...base, revision: currentAttempt.version, draftText: currentAttempt.evidence.text, editorStatus: checkpoint?.status === "reviewing" ? "reviewing" : checkpoint?.status === "feedback" ? "feedback" : "editing", feedback: checkpoint?.feedback };
      return { ...base, revision: 0, draftText: await readTargetDraftText(loaded.workspace, authored).catch(() => ""), editorStatus: "editing" };
    }
    if (authored?.type === "editor-practice" && currentAttempt?.status === "accepted") return { ...base, revision: currentAttempt.version, editorStatus: "unlocked" };
    return base;
  }));
  const progress = { ...activeProgress, completedLessons, blocks };
  const introductionComplete = introductionCompleted(records);
  const emerged = new Set(activeProgress.blocks.filter((block) => block.emerged).map((block) => block.id));
  const chapters = loaded.chapters.map((chapter) => {
    if (!chapter.lesson || !introductionComplete) return { ...chapter, lesson: undefined };
    if (completedLessons.includes(chapter.lesson.id)) return { ...chapter, lesson: publicLesson(chapter.lesson, chapter.lesson.blocks) };
    if (chapter.lesson.id === lesson.id) return { ...chapter, lesson: publicLesson(chapter.lesson, chapter.lesson.blocks.filter((block) => emerged.has(block.id))) };
    return { ...chapter, lesson: undefined };
  });
  return { workbook: loaded.identity, introduction: loaded.introduction, introductionComplete, chapters, progress, timeline: publicTimeline(records), adapter: { modelBackedHelp: true, note: "Free-text help is block-scoped." } };
}

export async function startWorkbookServer(options: WorkbookServerOptions): Promise<StartedWorkbookServer> {
  const log = options.logger ?? createTutorialLogger();
  await access(resolve(options.webRoot, "index.html"));
  const loaded = await loadWorkbook(options.target);
  const embeddedTerminalEnabled = options.embeddedTerminal ?? true;
  const host = options.host ?? LOOPBACK_HOST;
  if (embeddedTerminalEnabled && !isLoopbackHost(host)) throw new Error("The embedded terminal can only be enabled on a loopback host; it exposes an isolated container shell.");
  if (embeddedTerminalEnabled) { requireOpenCodeApiKey(); if (!options.terminalPtyFactory) assertDockerTerminalReady(loaded.workspace); }

  const timeline = new WorkbookTimeline(loaded.workspace);
  const attempts = new AttemptStore(loaded.workspace);
  const mainTutor = options.mainTutor ?? new DefaultMainWorkbookTutor({ workspace: loaded.workspace, log });
  const blockTutor = options.blockTutor ?? new FastWorkbookBlockTutor({ workspace: loaded.workspace, log });
  let records = await timeline.read();
  let closed = false;
  let restoringFailed = false;
  const reviewFinalizers = new Set<Promise<unknown>>();

  const append = async (input: Parameters<WorkbookTimeline["append"]>[0]): Promise<WorkbookTimelineRecord> => {
    const record = await timeline.appendWithinRun(input);
    records = [...records, record];
    return record;
  };
  const transact = <T>(operation: () => Promise<T>): Promise<T> => timeline.run(operation);
  if (records.length === 0) await append({ type: "session_started" });

  const activeAuthoredBlock = (source = records): { lesson: WorkbookLesson; progress: ReturnType<typeof project>; blockProgress: BlockProgress; block: WorkbookBlock } | undefined => {
    if (!introductionCompleted(source)) return undefined;
    const lesson = activeLesson(loaded, source);
    const progress = project(source, lesson);
    const blockProgress = progress.blocks.find((block) => block.active && block.ready);
    const block = lesson.blocks.find((candidate) => candidate.id === blockProgress?.id);
    return blockProgress && block ? { lesson, progress, blockProgress, block } : undefined;
  };
  const blockSupportsHints = (block: WorkbookBlock): block is Extract<WorkbookBlock, { type: "editor-practice" | "terminal-practice" }> => block.type === "editor-practice" || block.type === "terminal-practice";
  const activeBlockContext = async (source = records) => {
    const active = activeAuthoredBlock(source);
    if (!active) return undefined;
    return {
      lessonId: active.lesson.id,
      blockId: active.block.id,
      title: active.block.title,
      markdown: active.block.markdown,
      authorGuidance: "tutor" in active.block ? active.block.tutor : "",
      attempts: isEvaluatedBlock(active.block) ? await attempts.list(active.lesson.id, active.block.id) : []
    };
  };
  const mainContext = async (): Promise<MainTutorContext> => ({ records, activeContext: await activeBlockContext() });
  const requireTutorText = (text: string, label: TutorFailure["operation"]): string => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`Empty tutor response for ${label}.`);
    return trimmed.slice(0, 1_000);
  };
  const newestBriefing = (lessonId: string, blockId: string) => [...records].reverse().find((record): record is Extract<WorkbookTimelineRecord, { type: "block_tutor_briefed" }> => record.type === "block_tutor_briefed" && record.lessonId === lessonId && record.blockId === blockId);
  const ensureAuthoredActiveBlock = async (): Promise<void> => {
    const active = activeAuthoredBlock();
    if (!active) return;
    let coveredThroughId = records.at(-1)?.id ?? active.block.id;
    if (!records.some((record) => record.type === "message" && record.source === "authored" && record.lessonId === active.lesson.id && record.blockId === active.block.id)) {
      const authored = await append({ type: "message", lessonId: active.lesson.id, blockId: active.block.id, role: "assistant", source: "authored", presentation: "course", text: authoredBlockText(active.block) });
      coveredThroughId = authored.id;
    }
    if (blockSupportsHints(active.block) && !newestBriefing(active.lesson.id, active.block.id)) await refreshBlockBriefing(active, coveredThroughId);
  };
  const currentPublicState = () => publicState(loaded, records, attempts);
  const appendFailure = async (input: Omit<TutorFailure, "id" | "sequence" | "at" | "type"> & { operation: TutorFailure["operation"] }): Promise<void> => {
    await append({ type: "tutor_failed", ...input });
  };
  const refreshBlockBriefing = async (active: ReturnType<typeof activeAuthoredBlock> extends infer T ? NonNullable<T> : never, coveredThroughId: string): Promise<void> => {
    if (!blockSupportsHints(active.block)) return;
    try {
      const context = await activeBlockContext();
      const text = requireTutorText(await mainTutor.prepareBlockBriefing({ ...(await mainContext()), lessonId: active.lesson.id, blockId: active.block.id, activeContext: context }), "briefing");
      await append({ type: "block_tutor_briefed", lessonId: active.lesson.id, blockId: active.block.id, text, coveredThroughId });
    } catch (error) {
      log.info(`Workbook tutor briefing failed for ${active.lesson.id}/${active.block.id}: ${error instanceof Error ? error.message : String(error)}`);
      await appendFailure({ lessonId: active.lesson.id, blockId: active.block.id, requestId: coveredThroughId, operation: "briefing", publicMessage: TUTOR_UNAVAILABLE });
    }
  };
  const appendReviewMessage = async (attempt: Attempt, text: string): Promise<TimelineMessage> => {
    return await append({ type: "message", lessonId: attempt.lessonId, blockId: attempt.blockId, role: "assistant", source: "main_tutor", presentation: "review", text }) as TimelineMessage;
  };
  const appendAcceptedCheckpoint = async (accepted: Attempt): Promise<void> => {
    await append({ type: "attempt_accepted", lessonId: accepted.lessonId, blockId: accepted.blockId, attemptId: accepted.id, version: accepted.version, kind: accepted.evidence.kind, summary: accepted.successMessage ?? "Nice work — this attempt is accepted." });
  };

  const trackFinalizer = (finalizer: Promise<unknown>): void => {
    reviewFinalizers.add(finalizer); void finalizer.finally(() => reviewFinalizers.delete(finalizer));
  };
  const finishReview = async (attempt: Attempt, privateGuidance: string): Promise<void> => {
    if (closed) return;
    const activeBeforeAssessment = activeAuthoredBlock();
    const currentBeforeAssessment = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
    if (!activeBeforeAssessment || activeBeforeAssessment.lesson.id !== attempt.lessonId || activeBeforeAssessment.block.id !== attempt.blockId || !currentBeforeAssessment || currentBeforeAssessment.id !== attempt.id || !isEvaluatedBlock(activeBeforeAssessment.block) || !evidenceMatchesBlock(currentBeforeAssessment.evidence, activeBeforeAssessment.block)) return;

    let readiness: BlockTutorReadiness | undefined;
    try {
      const context = await activeBlockContext();
      if (!context) return;
      const advice = await blockTutor.assess({ context, attempt: currentBeforeAssessment });
      const readinessFinalizer = transact(async () => {
        if (closed) return undefined;
        const active = activeAuthoredBlock();
        const current = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
        if (!active || active.lesson.id !== attempt.lessonId || active.block.id !== attempt.blockId || !current || current.id !== attempt.id || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(current.evidence, active.block)) return undefined;
        return await append({ type: "block_tutor_readiness", lessonId: current.lessonId, blockId: current.blockId, attemptId: current.id, readiness: advice.readiness, text: requireTutorText(advice.text, "readiness") }) as BlockTutorReadiness;
      });
      reviewFinalizers.add(readinessFinalizer); void readinessFinalizer.finally(() => reviewFinalizers.delete(readinessFinalizer));
      readiness = await readinessFinalizer;
      if (!readiness || closed) return;
    } catch (error) {
      await transact(async () => {
        if (closed) return;
        log.info(`Workbook block tutor readiness failed for ${attempt.lessonId}/${attempt.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        await appendFailure({ lessonId: attempt.lessonId, blockId: attempt.blockId, requestId: attempt.id, operation: "readiness", publicMessage: REVIEW_FAILURE_FEEDBACK });
      });
      if (closed) return;
    }

    let decision: TutorDecision;
    try { decision = await mainTutor.review({ ...(await mainContext()), attempt: currentBeforeAssessment, privateGuidance, readiness }); }
    catch (error) {
      const failure = transact(async () => {
        if (closed) return;
        log.info(`Workbook tutor review failed for ${attempt.lessonId}/${attempt.blockId}: ${error instanceof Error ? error.message : String(error)}`);
        const feedback = await attempts.markFeedback(attempt.id, REVIEW_FAILURE_FEEDBACK);
        if (feedback) await appendFailure({ lessonId: feedback.lessonId, blockId: feedback.blockId, requestId: feedback.id, operation: "review", publicMessage: REVIEW_FAILURE_FEEDBACK });
      });
      trackFinalizer(failure);
      return;
    }

    const finalizer = transact(async () => {
      if (closed) return;
      const active = activeAuthoredBlock();
      const current = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
      if (!active || active.lesson.id !== attempt.lessonId || active.block.id !== attempt.blockId || !current || current.id !== attempt.id || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(current.evidence, active.block)) return;
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
            if (!await promoteCurrentEditorAttempt({ workspace: loaded.workspace, attempts, lessonId: active.lesson.id, block: active.block, attemptId: current.id })) {
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
        return;
      }

      const feedback = await attempts.markFeedback(current.id, message);
      if (feedback) {
        const reviewMessage = await appendReviewMessage(feedback, feedback.feedback ?? message);
        await refreshBlockBriefing(active, reviewMessage.id);
      }
    });
    trackFinalizer(finalizer);
  };

  const createAttempt = async (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt> => {
    if (closed) throw new Error("Workbook server is closed.");
    const active = activeAuthoredBlock();
    if (!active || active.lesson.id !== input.lessonId || active.block.id !== input.blockId || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(input.evidence, active.block)) throw new Error("This block is not active yet.");
    const attempt = await attempts.create({ lessonId: input.lessonId, blockId: input.blockId, evidence: input.evidence });
    const reviewing = await attempts.markReviewing(attempt.id) ?? attempt;
    void finishReview(reviewing, input.privateGuidance);
    return reviewing;
  };
  const submitAttempt = (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt> => transact(() => createAttempt(input));
  const requeueActiveAttempt = async (): Promise<void> => {
    const active = activeAuthoredBlock();
    if (!active || !isEvaluatedBlock(active.block)) return;
    const current = await attempts.current(active.lesson.id, active.block.id).catch(() => undefined);
    if (!current || current.status === "accepted" || current.status === "superseded") return;
    const reviewing = await attempts.markReviewing(current.id) ?? current;
    void finishReview(reviewing, active.block.tutor);
  };

  try { await mainTutor.restore(await mainContext()); await requeueActiveAttempt(); }
  catch (error) {
    restoringFailed = true;
    log.info(`Workbook tutor restoration failed: ${error instanceof Error ? error.message : String(error)}`);
    await appendFailure({ lessonId: activeAuthoredBlock()?.lesson.id ?? "workbook", blockId: activeAuthoredBlock()?.block.id ?? "introduction", requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE });
  }

  const activeObservedBlock = (): ActiveObservedTerminalBlock | undefined => {
    const active = activeAuthoredBlock();
    return active?.block.type === "terminal-practice" ? { lessonId: active.lesson.id, blockId: active.block.id, command: active.block.markdown, context: active.block.markdown, expectedObservation: active.block.tutor } : undefined;
  };
  const terminal = embeddedTerminalEnabled ? new WorkbookTerminalManager({ workspace: loaded.workspace, getActiveBlock: activeObservedBlock, submitAttempt: async (input) => { await submitAttempt(input); }, ptyFactory: options.terminalPtyFactory ?? createDockerPty, debounceMs: options.terminalDebounceMs, logger: log }) : undefined;

  const appendHintForActiveBlock = async (blockId: string, requestId: string): Promise<"ok" | "inactive"> => {
    const active = activeAuthoredBlock();
    if (!active || active.block.id !== blockId || !blockSupportsHints(active.block)) return "inactive";
    const briefing = newestBriefing(active.lesson.id, active.block.id);
    if (!briefing) {
      await appendFailure({ lessonId: active.lesson.id, blockId: active.block.id, requestId, operation: "briefing", publicMessage: TUTOR_UNAVAILABLE });
      return "ok";
    }
    try {
      const context = await activeBlockContext();
      if (!context) return "inactive";
      const hint = requireTutorText(await blockTutor.hint({ context, briefing: briefing.text }), "hint");
      await append({ type: "message", lessonId: active.lesson.id, blockId: active.block.id, role: "assistant", source: "block_tutor", presentation: "hint", text: hint });
    } catch (error) {
      log.info(`Workbook block tutor hint failed for ${active.lesson.id}/${active.block.id}: ${error instanceof Error ? error.message : String(error)}`);
      await appendFailure({ lessonId: active.lesson.id, blockId: active.block.id, requestId, operation: "hint", publicMessage: TUTOR_UNAVAILABLE });
    }
    return "ok";
  };

  const summarizeDeparture = async (leaving: WorkbookBlock, workflowId: string): Promise<void> => {
    const lesson = activeLesson(loaded, records);
    try { await append({ type: "block_summarized", lessonId: lesson.id, blockId: leaving.id, text: requireTutorText(await mainTutor.summarizeBlock({ ...(await mainContext()), lessonId: lesson.id, blockId: leaving.id, coveredThroughId: workflowId }), "block_summary"), coveredThroughId: workflowId }); }
    catch { await appendFailure({ lessonId: lesson.id, blockId: leaving.id, requestId: workflowId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE }); }
    if (!project(records, lesson).completedLessons.includes(lesson.id)) { await ensureAuthoredActiveBlock(); return; }
    try { await append({ type: "lesson_summarized", lessonId: lesson.id, text: requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: lesson.id, coveredThroughId: workflowId }), "lesson_summary"), coveredThroughId: workflowId }); }
    catch { await appendFailure({ lessonId: lesson.id, blockId: leaving.id, requestId: workflowId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE }); }
    await ensureAuthoredActiveBlock();
  };

  const server = createServer(async (request, response) => {
    headers(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && isRoute(url.pathname, "timeline")) {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      response.write(`event: timeline\ndata: ${JSON.stringify(publicTimeline(records))}\n\n`);
      const unsubscribe = timeline.subscribe((record) => {
        const publicRecord = publicTimelineRecord(record);
        if (publicRecord) response.write(`event: record\ndata: ${JSON.stringify(publicRecord)}\n\n`);
      });
      request.on("close", unsubscribe);
      return;
    }
    if (request.method === "GET" && isRoute(url.pathname, "state")) return sendJson(response, 200, await currentPublicState());
    if (request.method === "POST" && isRoute(url.pathname, "introduction")) {
      return transact(async () => {
        if (!introductionCompleted(records)) await append({ type: "workbook_introduction_completed" });
        await ensureAuthoredActiveBlock();
        sendJson(response, 202, await currentPublicState());
      });
    }
    if (request.method === "POST" && isRoute(url.pathname, "messages")) {
      try {
        const body = await readJson(request);
        const blockId = typeof body.blockId === "string" ? body.blockId : "";
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) return sendJson(response, 400, { error: "Message text is required." });
        if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return sendJson(response, 400, { error: "Message text is too large." });
        return transact(async () => {
          const active = activeAuthoredBlock();
          if (!active || active.block.id !== blockId) return sendJson(response, 409, { error: "This block is not active yet." });
          const learnerMessage = await append({ type: "message", lessonId: active.lesson.id, blockId, role: "user", source: "learner", presentation: "chat", text });
          try {
            const reply = requireTutorText(await mainTutor.reply({ ...(await mainContext()), learnerMessage: learnerMessage as TimelineMessage }), "reply");
            const tutorMessage = await append({ type: "message", lessonId: active.lesson.id, blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: reply, inReplyTo: learnerMessage.id });
            await refreshBlockBriefing(active, tutorMessage.id);
          } catch (error) {
            log.info(`Workbook tutor reply failed for ${active.lesson.id}/${blockId}: ${error instanceof Error ? error.message : String(error)}`);
            await appendFailure({ lessonId: active.lesson.id, blockId, requestId: learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE });
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
              const active = activeAuthoredBlock();
              const reply = requireTutorText(await mainTutor.reply({ ...(await mainContext()), learnerMessage }), "reply");
              const tutorMessage = await append({ type: "message", lessonId: failure.lessonId, blockId: failure.blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: reply, inReplyTo: learnerMessage.id });
              if (active && active.lesson.id === failure.lessonId && active.block.id === failure.blockId) await refreshBlockBriefing(active, tutorMessage.id);
            } catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: learnerMessage.id, operation: "reply", publicMessage: TUTOR_UNAVAILABLE }); }
          } else if (failure.operation === "hint") {
            await appendHintForActiveBlock(failure.blockId, failure.id);
          } else if (failure.operation === "briefing") {
            const active = activeAuthoredBlock();
            if (active && active.lesson.id === failure.lessonId && active.block.id === failure.blockId) await refreshBlockBriefing(active, failure.id);
          } else if (failure.operation === "restore") {
            try { await mainTutor.restore(await mainContext()); restoringFailed = false; await requeueActiveAttempt(); }
            catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: "restore", operation: "restore", publicMessage: TUTOR_UNAVAILABLE }); }
          } else if (failure.operation === "readiness" || failure.operation === "review") {
            await requeueActiveAttempt();
          } else if (failure.operation === "block_summary") {
            const lesson = loaded.chapters.map((chapter) => chapter.lesson).find((candidate): candidate is WorkbookLesson => candidate?.id === failure.lessonId);
            const leaving = lesson?.blocks.find((block) => block.id === failure.blockId);
            if (lesson && leaving) {
              try { await append({ type: "block_summarized", lessonId: lesson.id, blockId: leaving.id, text: requireTutorText(await mainTutor.summarizeBlock({ ...(await mainContext()), lessonId: lesson.id, blockId: leaving.id, coveredThroughId: failure.requestId }), "block_summary"), coveredThroughId: failure.requestId }); }
              catch { await appendFailure({ lessonId: lesson.id, blockId: leaving.id, requestId: failure.requestId, operation: "block_summary", publicMessage: TUTOR_UNAVAILABLE }); }
            }
          } else if (failure.operation === "lesson_summary") {
            try { await append({ type: "lesson_summarized", lessonId: failure.lessonId, text: requireTutorText(await mainTutor.summarizeLesson({ ...(await mainContext()), lessonId: failure.lessonId, coveredThroughId: failure.requestId }), "lesson_summary"), coveredThroughId: failure.requestId }); }
            catch { await appendFailure({ lessonId: failure.lessonId, blockId: failure.blockId, requestId: failure.requestId, operation: "lesson_summary", publicMessage: TUTOR_UNAVAILABLE }); }
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
        const active = activeAuthoredBlock();
        if (!active || active.block.type !== "editor-practice" || active.block.id !== blockId) return sendJson(response, 409, { error: "This editor block is not active yet." });
        try { await resolveEditorTarget(loaded.workspace, active.block.path); } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Unsafe editor target path." }); }
        await submitAttempt({ lessonId: active.lesson.id, blockId: active.block.id, evidence: { kind: "editor", text }, privateGuidance: active.block.tutor });
        return sendJson(response, 202, await currentPublicState());
      } catch (error) { const message = error instanceof Error ? error.message : "Bad request."; return sendJson(response, /accepted work|not active/i.test(message) ? 409 : 400, { error: message }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "events")) {
      try {
        const body = await readJson(request);
        return transact(async () => {
          if (!introductionCompleted(records)) return sendJson(response, 409, { error: "Complete the workbook introduction first." });
          const lesson = activeLesson(loaded, records); const block = lesson.blocks.find((candidate) => candidate.id === body.blockId);
          if (!block) return sendJson(response, 400, { error: "Unknown blockId." });
          const current = project(records, lesson); const progress = current.blocks.find((candidate) => candidate.id === block.id);
          if (body.action !== "help" && (!progress?.active || !progress.ready)) return sendJson(response, 409, { error: "This block is not active yet." });
          if ((body.action === "reflection-submit" || body.action === "reflection-follow-up") && block.type === "reflection") {
            const responseText = typeof body.response === "string" ? body.response : "";
            const priorConversation = current.reflectionConversations[block.id] ?? [];
            const first = body.action === "reflection-submit";
            if ((first && priorConversation.length > 0) || (!first && priorConversation.length === 0)) return sendJson(response, 409, { error: "Use a follow-up after the first reflection message." });
            const currentAttempt = await attempts.current(lesson.id, block.id).catch(() => undefined);
            if (!first && currentAttempt?.status === "reviewing") return sendJson(response, 409, { error: "Wait for the tutor to finish reviewing before sending a follow-up." });
            const learnerTurns = await submitReflectionAttempt({ lessonId: lesson.id, blockId: block.id, privateGuidance: block.tutor, response: responseText, conversation: priorConversation, submitAttempt: async () => undefined });
            await append({ type: "message", lessonId: lesson.id, blockId: block.id, role: "user", source: "learner", presentation: "chat", text: learnerTurns.at(-1)!.text });
            await createAttempt({ lessonId: lesson.id, blockId: block.id, privateGuidance: block.tutor, evidence: { kind: "reflection", response: learnerTurns.at(-1)!.text, conversation: priorConversation } });
            return sendJson(response, 202, await currentPublicState());
          }
          let event: Parameters<typeof append>[0] | undefined;
          if (body.action === "continue" && (block.type === "narrative" || block.type === "lesson-transition")) event = { type: "block_continued", lessonId: lesson.id, blockId: block.id };
          if (body.action === "continue" && isEvaluatedBlock(block)) {
            const currentAttempt = await attempts.current(lesson.id, block.id).catch(() => undefined);
            if (!currentAttempt || currentAttempt.status !== "accepted" || !progress?.checkpoint) return sendJson(response, 409, { error: "This block has not been accepted yet." });
            event = { type: "block_continued", lessonId: lesson.id, blockId: block.id };
          }
          if (body.action === "unexpected" && block.type === "terminal-practice" && typeof body.evidence === "string") event = { type: "unexpected_output_submitted", lessonId: lesson.id, blockId: block.id, evidence: body.evidence };
          if (body.action === "help" && typeof body.request === "string") event = { type: "help_requested", lessonId: lesson.id, blockId: block.id, request: body.request };
          if (!event) return sendJson(response, 400, { error: "Invalid workbook action for this block." });
          const written = await append(event);
          if (written.type === "block_continued") await summarizeDeparture(block, written.id);
          sendJson(response, 202, await currentPublicState());
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
  const url = `http://${LOOPBACK_HOST}:${address.port}`;
  log.info(`Workbook tutor listening on ${url}. State: ${timeline.eventPath}${terminal ? " Embedded terminal enabled on loopback only." : ""}`);
  return { url, port: address.port, host, close: async () => { closed = true; terminal?.dispose(); mainTutor.dispose(); wss?.close(); await Promise.allSettled([...reviewFinalizers]); const closing = new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())); server.closeAllConnections(); await closing; } };
}
