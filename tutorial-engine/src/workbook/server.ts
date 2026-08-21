import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LOOPBACK_HOST } from "../server/local-server.js";
import type { TutorialLogger } from "../runtime-log.js";
import { createTutorialLogger } from "../runtime-log.js";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { introductionCompleted, nowEvent, project, WorkbookEventStore, type BlockProgress, type WorkbookEvent } from "./events.js";
import { assertDockerTerminalReady, createDockerPty, requireOpenCodeApiKey, WorkbookTerminalManager, type ActiveObservedTerminalBlock, type TerminalPtyFactory } from "./terminal.js";
import { appendTutorFeedback, submitReflectionAttempt } from "./reflection.js";
import { promoteAcceptedEditorAttempt, resolveEditorTarget } from "./editor.js";
import { AttemptStore, type Attempt, type AttemptEvidence } from "./attempts.js";
import { RestrictedWorkbookTutor, type WorkbookTutor } from "./tutor.js";
import type { EditorPracticeBlock, WorkbookBlock, WorkbookLesson } from "./contract.js";

const MIME_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 16_384;
const REVIEW_FAILURE_FEEDBACK = "Review is temporarily unavailable. Please try another attempt in a moment.";

export interface WorkbookServerOptions { target: string; webRoot: string; port?: number; host?: string; logger?: TutorialLogger; embeddedTerminal?: boolean; terminalPtyFactory?: TerminalPtyFactory; terminalDebounceMs?: number; workbookTutor?: WorkbookTutor; }
export interface StartedWorkbookServer { url: string; port: number; host: string; close(): Promise<void>; }

type PublicCheckpoint = {
  status: "working" | "reviewing" | "feedback" | "accepted";
  feedback?: string;
  successMessage?: string;
  evidence?: { kind: AttemptEvidence["kind"]; text?: string; terminalHtml?: string; conversation?: Array<{ role: "learner" | "tutor"; text: string }> };
};

type PublicBlockProgress = Omit<BlockProgress, "checkpoint"> & { checkpoint?: PublicCheckpoint; draftText?: string; revision?: number; editorStatus?: "editing" | "reviewing" | "feedback" | "unlocked" };

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
function hostHeaderName(request: IncomingMessage): string | undefined {
  const host = request.headers.host?.split(":")[0];
  return host?.replace(/^\[/, "").replace(/\]$/, "");
}
function isTerminalRoute(pathname: string): boolean { return pathname === "/api/workbook/terminal" || pathname.endsWith("/api/workbook/terminal"); }
function originAllowed(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname) && Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) === port;
  } catch { return false; }
}
function parseTerminalMessage(data: RawData) {
  try { return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as any).toString("utf8")); }
  catch { return undefined; }
}
function isEvaluatedBlock(block: WorkbookBlock): block is Extract<WorkbookBlock, { type: "editor-practice" | "terminal-practice" | "reflection" }> {
  return block.type === "editor-practice" || block.type === "terminal-practice" || block.type === "reflection";
}
function evidenceMatchesBlock(evidence: AttemptEvidence, block: WorkbookBlock): boolean {
  return (evidence.kind === "editor" && block.type === "editor-practice") || (evidence.kind === "terminal" && block.type === "terminal-practice") || (evidence.kind === "reflection" && block.type === "reflection");
}

/** The lesson whose progression is live: the first incomplete lesson in the authored rail. */
function activeLesson(loaded: LoadedWorkbook, events: WorkbookEvent[] = []): WorkbookLesson {
  const lessons = loaded.chapters.map((chapter) => chapter.lesson).filter((lesson): lesson is WorkbookLesson => Boolean(lesson));
  const lesson = lessons.find((candidate) => !project(events, candidate).completedLessons.includes(candidate.id)) ?? lessons.at(-1);
  if (!lesson) throw new Error("No workbook lesson is migrated.");
  return lesson;
}
function completedLessonIds(loaded: LoadedWorkbook, events: WorkbookEvent[]): string[] {
  return loaded.chapters.flatMap((chapter) => chapter.lesson && project(events, chapter.lesson).completedLessons.includes(chapter.lesson.id) ? [chapter.lesson.id] : []);
}
function publicBlock(block: WorkbookBlock) {
  const { tutor: _privateTutor, ...visible } = block as WorkbookBlock & { tutor?: string };
  return visible;
}
function publicLesson(lesson: WorkbookLesson, blocks: WorkbookBlock[]) {
  return { ...lesson, blocks: blocks.map(publicBlock) };
}
async function readTargetDraftText(workspace: string, block: EditorPracticeBlock): Promise<string> {
  const target = await resolveEditorTarget(workspace, block.path);
  try { return await readFile(target, "utf8"); }
  catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}
function publicAttemptEvidence(attempt: Attempt): PublicCheckpoint["evidence"] {
  if (attempt.evidence.kind === "editor") return { kind: "editor", text: attempt.evidence.text };
  if (attempt.evidence.kind === "terminal") return { kind: "terminal", terminalHtml: attempt.evidence.terminalHtml };
  return { kind: "reflection", conversation: [...attempt.evidence.conversation, { role: "learner", text: attempt.evidence.response }] };
}
function publicCheckpoint(attempt: Attempt | undefined, projected: BlockProgress["checkpoint"]): PublicCheckpoint | undefined {
  if (attempt && attempt.status !== "superseded") {
    return {
      status: attempt.status === "accepted" ? "accepted" : attempt.status,
      feedback: attempt.status === "feedback" ? attempt.feedback : undefined,
      successMessage: attempt.status === "accepted" ? attempt.successMessage ?? projected?.summary : undefined,
      evidence: publicAttemptEvidence(attempt)
    };
  }
  return projected ? { status: "accepted", successMessage: projected.summary, evidence: { kind: projected.kind } } : undefined;
}

async function publicState(loaded: LoadedWorkbook, events: WorkbookEvent[], attempts: AttemptStore) {
  const lesson = activeLesson(loaded, events);
  const activeProgress = project(events, lesson);
  const completedLessons = completedLessonIds(loaded, events);
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
  const introductionComplete = introductionCompleted(events);
  const emerged = new Set(activeProgress.blocks.filter((block) => block.emerged).map((block) => block.id));
  const chapters = loaded.chapters.map((chapter) => {
    if (!chapter.lesson || !introductionComplete) return { ...chapter, lesson: undefined };
    if (completedLessons.includes(chapter.lesson.id)) return { ...chapter, lesson: publicLesson(chapter.lesson, chapter.lesson.blocks) };
    if (chapter.lesson.id === lesson.id) return { ...chapter, lesson: publicLesson(chapter.lesson, chapter.lesson.blocks.filter((block) => emerged.has(block.id))) };
    return { ...chapter, lesson: undefined };
  });
  return { workbook: loaded.identity, introduction: loaded.introduction, introductionComplete, chapters, progress, adapter: { modelBackedHelp: false, note: "Free-text help is block-scoped. No model adapter is wired in this vertical slice." } };
}

export async function startWorkbookServer(options: WorkbookServerOptions): Promise<StartedWorkbookServer> {
  const log = options.logger ?? createTutorialLogger();
  await access(resolve(options.webRoot, "index.html"));
  const loaded = await loadWorkbook(options.target);
  const embeddedTerminalEnabled = options.embeddedTerminal ?? true;
  const host = options.host ?? LOOPBACK_HOST;
  if (embeddedTerminalEnabled && !isLoopbackHost(host)) throw new Error("The embedded terminal can only be enabled on a loopback host; it exposes an isolated container shell.");
  if (embeddedTerminalEnabled) {
    requireOpenCodeApiKey();
    if (!options.terminalPtyFactory) assertDockerTerminalReady(loaded.workspace);
  }
  const store = new WorkbookEventStore(loaded.workspace);
  const attempts = new AttemptStore(loaded.workspace);
  const tutor = options.workbookTutor ?? new RestrictedWorkbookTutor({ workspace: loaded.workspace, log });
  let eventsCache = await store.read();
  if (eventsCache.length === 0) {
    await store.append(nowEvent({ type: "session_started" }));
    eventsCache = await store.read();
  }
  const refreshEvents = async () => { eventsCache = await store.read(); return eventsCache; };
  const currentPublicState = (events: WorkbookEvent[]) => publicState(loaded, events, attempts);

  let closed = false;
  let submissionTail: Promise<unknown> = Promise.resolve();
  const withSubmissionLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const run = submissionTail.catch(() => undefined).then(work);
    submissionTail = run.catch(() => undefined);
    return run;
  };

  const activeAuthoredBlock = (events = eventsCache): { lesson: WorkbookLesson; progress: ReturnType<typeof project>; blockProgress: BlockProgress; block: WorkbookBlock } | undefined => {
    if (!introductionCompleted(events)) return undefined;
    const lesson = activeLesson(loaded, events);
    const progress = project(events, lesson);
    const blockProgress = progress.blocks.find((block) => block.active && block.ready);
    const block = lesson.blocks.find((candidate) => candidate.id === blockProgress?.id);
    if (!blockProgress || !block) return undefined;
    return { lesson, progress, blockProgress, block };
  };
  const activeObservedBlock = (): ActiveObservedTerminalBlock | undefined => {
    const active = activeAuthoredBlock();
    if (!active || active.block.type !== "terminal-practice") return undefined;
    return { lessonId: active.lesson.id, blockId: active.block.id, command: active.block.markdown, context: active.block.markdown, expectedObservation: active.block.tutor };
  };

  const writeCurrentProjection = async () => {
    const events = await refreshEvents();
    await store.writeProjection(project(events, activeLesson(loaded, events)));
    return events;
  };

  const finishReview = async (attempt: Attempt, privateGuidance: string): Promise<void> => {
    if (closed) return;
    let decision;
    try {
      decision = await tutor.review({ attempt, privateGuidance });
    } catch (error) {
      if (closed) return;
      log.info(`Workbook tutor review failed for ${attempt.lessonId}/${attempt.blockId}: ${error instanceof Error ? error.message : String(error)}`);
      const feedback = await attempts.markFeedback(attempt.id, REVIEW_FAILURE_FEEDBACK);
      if (feedback?.evidence.kind === "reflection") await store.append(nowEvent({ type: "reflection_reply_recorded", lessonId: feedback.lessonId, blockId: feedback.blockId, response: feedback.feedback ?? REVIEW_FAILURE_FEEDBACK }));
      await writeCurrentProjection();
      return;
    }

    if (closed) return;
    await refreshEvents();
    if (closed) return;
    const active = activeAuthoredBlock();
    const current = await attempts.current(attempt.lessonId, attempt.blockId).catch(() => undefined);
    if (!active || active.lesson.id !== attempt.lessonId || active.block.id !== attempt.blockId || !current || current.id !== attempt.id) return;

    if (decision.accepted) {
      const accepted = await attempts.acceptCurrent(attempt.id, decision.feedback);
      if (!accepted) return;
      if (accepted.evidence.kind === "editor" && active.block.type === "editor-practice") {
        try {
          const promoted = await promoteAcceptedEditorAttempt({ workspace: loaded.workspace, attempts, lessonId: active.lesson.id, block: active.block, attemptId: accepted.id });
          if (!promoted) { await attempts.markFeedback(accepted.id, REVIEW_FAILURE_FEEDBACK); return; }
        } catch (error) {
          log.info(`Accepted editor attempt could not be promoted: ${error instanceof Error ? error.message : String(error)}`);
          await attempts.markFeedback(accepted.id, REVIEW_FAILURE_FEEDBACK);
          await writeCurrentProjection();
          return;
        }
      }
      await store.append(nowEvent({ type: "attempt_accepted", lessonId: accepted.lessonId, blockId: accepted.blockId, attemptId: accepted.id, version: accepted.version, kind: accepted.evidence.kind, summary: accepted.successMessage ?? decision.feedback }));
      await writeCurrentProjection();
      return;
    }

    const feedback = await attempts.markFeedback(attempt.id, decision.feedback);
    if (feedback?.evidence.kind === "reflection") {
      await store.append(nowEvent({ type: "reflection_reply_recorded", lessonId: feedback.lessonId, blockId: feedback.blockId, response: feedback.feedback ?? decision.feedback }));
    }
    await writeCurrentProjection();
  };

  const submitAttempt = async (input: { lessonId: string; blockId: string; evidence: AttemptEvidence; privateGuidance: string }): Promise<Attempt> => withSubmissionLock(async () => {
    if (closed) throw new Error("Workbook server is closed.");
    const latest = await refreshEvents();
    const active = activeAuthoredBlock(latest);
    if (!active || active.lesson.id !== input.lessonId || active.block.id !== input.blockId || !isEvaluatedBlock(active.block) || !evidenceMatchesBlock(input.evidence, active.block)) throw new Error("This block is not active yet.");
    const attempt = await attempts.create({ lessonId: input.lessonId, blockId: input.blockId, evidence: input.evidence });
    const reviewing = await attempts.markReviewing(attempt.id) ?? attempt;
    void finishReview(reviewing, input.privateGuidance);
    return reviewing;
  });

  const requeueActiveAttempt = async (): Promise<void> => {
    const active = activeAuthoredBlock(await refreshEvents());
    if (!active || !isEvaluatedBlock(active.block)) return;
    const current = await attempts.current(active.lesson.id, active.block.id).catch(() => undefined);
    if (!current || current.status === "accepted" || current.status === "superseded") return;
    const reviewing = await attempts.markReviewing(current.id) ?? current;
    void finishReview(reviewing, active.block.tutor);
  };
  void requeueActiveAttempt();

  const terminal = embeddedTerminalEnabled ? new WorkbookTerminalManager({
    workspace: loaded.workspace,
    getActiveBlock: activeObservedBlock,
    submitAttempt: async (input) => { await submitAttempt(input); },
    ptyFactory: options.terminalPtyFactory ?? createDockerPty,
    debounceMs: options.terminalDebounceMs,
    logger: log
  }) : undefined;

  let server = createServer(async (request, response) => {
    headers(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && isRoute(url.pathname, "state")) return sendJson(response, 200, await currentPublicState(await refreshEvents()));
    if (request.method === "POST" && isRoute(url.pathname, "introduction")) {
      const events = await refreshEvents();
      if (!introductionCompleted(events)) await store.append(nowEvent({ type: "workbook_introduction_completed" }));
      const updated = await writeCurrentProjection();
      return sendJson(response, 202, await currentPublicState(updated));
    }
    if (request.method === "POST" && isRoute(url.pathname, "editor")) {
      try {
        const body = await readJson(request);
        const blockId = typeof body.blockId === "string" ? body.blockId : "";
        const text = typeof body.text === "string" ? body.text : undefined;
        if (text === undefined) return sendJson(response, 400, { error: "Editor text must be a string." });
        if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return sendJson(response, 400, { error: "Editor text is too large." });
        const active = activeAuthoredBlock(await refreshEvents());
        if (!active || active.block.type !== "editor-practice" || active.block.id !== blockId) return sendJson(response, 409, { error: "This editor block is not active yet." });
        try { await resolveEditorTarget(loaded.workspace, active.block.path); }
        catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Unsafe editor target path." }); }
        await submitAttempt({ lessonId: active.lesson.id, blockId: active.block.id, evidence: { kind: "editor", text }, privateGuidance: active.block.tutor });
        return sendJson(response, 202, await currentPublicState(await refreshEvents()));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bad request.";
        return sendJson(response, /accepted work|not active/i.test(message) ? 409 : 400, { error: message });
      }
    }
    if (request.method === "POST" && isRoute(url.pathname, "events")) {
      try {
        const body = await readJson(request);
        const latest = await refreshEvents();
        if (!introductionCompleted(latest)) return sendJson(response, 409, { error: "Complete the workbook introduction first." });
        const lesson = activeLesson(loaded, latest);
        const block = lesson.blocks.find((candidate) => candidate.id === body.blockId);
        if (!block) return sendJson(response, 400, { error: "Unknown blockId." });
        const current = project(latest, lesson);
        const progress = current.blocks.find((candidate) => candidate.id === block.id);
        if (body.action !== "help" && (!progress?.active || !progress.ready)) return sendJson(response, 409, { error: "This block is not active yet." });

        if ((body.action === "reflection-submit" || body.action === "reflection-follow-up") && block.type === "reflection") {
          const responseText = typeof body.response === "string" ? body.response : "";
          const priorConversation = current.reflectionConversations[block.id] ?? [];
          const isFirst = body.action === "reflection-submit";
          if ((isFirst && priorConversation.length > 0) || (!isFirst && !priorConversation.some((turn) => turn.role === "tutor"))) return sendJson(response, 409, { error: "Wait for the tutor reply before adding a follow-up." });
          const learnerTurns = await submitReflectionAttempt({ lessonId: lesson.id, blockId: block.id, privateGuidance: block.tutor, response: responseText, conversation: priorConversation, submitAttempt: async () => undefined });
          await store.append(nowEvent(isFirst
            ? { type: "reflection_submitted", lessonId: lesson.id, blockId: block.id, response: learnerTurns.at(-1)!.text }
            : { type: "reflection_follow_up_submitted", lessonId: lesson.id, blockId: block.id, response: learnerTurns.at(-1)!.text }));
          await submitAttempt({ lessonId: lesson.id, blockId: block.id, privateGuidance: block.tutor, evidence: { kind: "reflection", response: learnerTurns.at(-1)!.text, conversation: priorConversation } });
          const updated = await writeCurrentProjection();
          return sendJson(response, 202, await currentPublicState(updated));
        }

        let event: WorkbookEvent | undefined;
        if (body.action === "continue" && (block.type === "narrative" || block.type === "lesson-transition")) event = nowEvent({ type: "block_continued", lessonId: lesson.id, blockId: block.id });
        if (body.action === "continue" && isEvaluatedBlock(block)) {
          const currentAttempt = await attempts.current(lesson.id, block.id).catch(() => undefined);
          if (!currentAttempt || currentAttempt.status !== "accepted" || !progress?.checkpoint) return sendJson(response, 409, { error: "This block has not been accepted yet." });
          event = nowEvent({ type: "block_continued", lessonId: lesson.id, blockId: block.id });
        }
        if (body.action === "unexpected" && block.type === "terminal-practice" && typeof body.evidence === "string") event = nowEvent({ type: "unexpected_output_submitted", lessonId: lesson.id, blockId: block.id, evidence: body.evidence });
        if (body.action === "help" && typeof body.request === "string") event = nowEvent({ type: "help_requested", lessonId: lesson.id, blockId: block.id, request: body.request });
        if (!event) return sendJson(response, 400, { error: "Invalid workbook action for this block." });
        await store.append(event);
        const events = await writeCurrentProjection();
        if (event.type === "block_continued" && isEvaluatedBlock(block)) void tutor.compactAfterBlock();
        return sendJson(response, 202, await currentPublicState(events));
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
      const client = {
        send: (message: string) => { if (socket.readyState === socket.OPEN) socket.send(message); },
        close: (code?: number, reason?: string) => socket.close(code, reason)
      };
      if (!terminal.attach(client)) {
        socket.send(JSON.stringify({ type: "busy", message: "Another browser is already connected to this terminal." }));
        socket.close(1013, "Terminal already connected.");
        return;
      }
      socket.on("message", (data) => {
        const message = parseTerminalMessage(data);
        if (message?.type === "input" || message?.type === "resize") terminal.receive(message);
      });
      socket.on("close", () => terminal.detach(client));
      socket.on("error", (error) => log.info(`Workbook terminal WebSocket error: ${error instanceof Error ? error.message : String(error)}`));
    });
    server.on("upgrade", (request, socket, head) => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? LOOPBACK_HOST}`);
      const address = server.address();
      const portNumber = address && typeof address !== "string" ? address.port : 0;
      if (!isTerminalRoute(requestUrl.pathname) || !isLoopbackHost(hostHeaderName(request)) || !originAllowed(request, portNumber)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
    });
  }
  const port = options.port ?? 0;
  await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolvePromise(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Could not determine workbook server address.");
  const url = `http://${LOOPBACK_HOST}:${address.port}`;
  log.info(`Workbook tutor listening on ${url}. State: ${store.eventPath}${terminal ? " Embedded terminal enabled on loopback only." : ""}`);
  return { url, port: address.port, host, close: async () => {
    closed = true;
    terminal?.dispose();
    tutor.dispose();
    wss?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  } };
}
