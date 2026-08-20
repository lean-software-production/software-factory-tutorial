import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LOOPBACK_HOST } from "../server/local-server.js";
import type { TutorialLogger } from "../runtime-log.js";
import { createTutorialLogger } from "../runtime-log.js";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { introductionCompleted, nowEvent, project, WorkbookEventStore, type WorkbookEvent } from "./events.js";
import { assertDockerTerminalReady, createDockerPty, PiTerminalObserver, requireOpenCodeApiKey, WorkbookTerminalManager, type ActiveObservedTerminalBlock, type TerminalObserver, type TerminalPtyFactory } from "./terminal.js";
import { PiReflectionConversationAdapter, type PracticeEvidence, type ReflectionConversationAdapter } from "./reflection.js";
import { EditorDraftStore, EditorReviewAdapter, PiEditorReviewAdapter, resolveEditorTarget } from "./editor.js";
import type { EditorPracticeBlock, WorkbookBlock, WorkbookLesson } from "./contract.js";

const MIME_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 16_384;

export interface WorkbookServerOptions { target: string; webRoot: string; port?: number; host?: string; logger?: TutorialLogger; embeddedTerminal?: boolean; terminalObserver?: TerminalObserver; terminalPtyFactory?: TerminalPtyFactory; terminalDebounceMs?: number; reflectionConversation?: ReflectionConversationAdapter; editorReviewAdapter?: EditorReviewAdapter; editorReviewDebounceMs?: number; }
export interface StartedWorkbookServer { url: string; port: number; host: string; close(): Promise<void>; }

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

/**
 * The lesson whose progression is live: the first incomplete lesson in the
 * authored rail. Completed lessons stay completed; the server advances to the
 * next lesson instead of pinning the learner to the first chapter.
 */
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

type PublicEditorProgress = { revision: number; editorStatus: "reviewing" | "feedback"; feedback?: string };
type PublicEditorProgressByBlock = ReadonlyMap<string, PublicEditorProgress>;
const editorProgressKey = (lessonId: string, blockId: string) => `${lessonId}\u0000${blockId}`;

function publicState(loaded: LoadedWorkbook, events: WorkbookEvent[], editorProgress: PublicEditorProgressByBlock = new Map()) {
  const lesson = activeLesson(loaded, events);
  const activeProgress = project(events, lesson);
  const completedLessons = completedLessonIds(loaded, events);
  const blocks = activeProgress.blocks.map((block) => {
    const overlay = editorProgress.get(editorProgressKey(activeProgress.activeLessonId, block.id));
    if (!overlay || block.completed) return block;
    return { ...block, revision: overlay.revision, editorStatus: overlay.editorStatus, feedback: overlay.feedback };
  });
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
  const reflectionConversation = options.reflectionConversation ?? new PiReflectionConversationAdapter(loaded.workspace, log);
  const editorDraftStore = new EditorDraftStore(loaded.workspace);
  const editorReviewAdapter = options.editorReviewAdapter ?? new PiEditorReviewAdapter(loaded.workspace, log);
  const editorReviewDebounceMs = Math.max(0, Math.min(options.editorReviewDebounceMs ?? 750, 10_000));
  const editorProgress = new Map<string, PublicEditorProgress>();
  const editorReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const editorBlockLocks = new Map<string, Promise<void>>();
  const withEditorBlockLock = async <T>(lessonId: string, blockId: string, work: () => Promise<T>): Promise<T> => {
    const key = editorProgressKey(lessonId, blockId);
    const previous = editorBlockLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.catch(() => undefined).then(() => current);
    editorBlockLocks.set(key, tail);
    await previous.catch(() => undefined);
    try { return await work(); }
    finally {
      release();
      if (editorBlockLocks.get(key) === tail) editorBlockLocks.delete(key);
    }
  };
  const currentPublicState = (events: WorkbookEvent[]) => publicState(loaded, events, editorProgress);
  let reflectionQueue = Promise.resolve();
  if ((await store.read()).length === 0) await store.append(nowEvent({ type: "session_started" }));
  let eventsCache = await store.read();
  const refreshEvents = async () => { eventsCache = await store.read(); return eventsCache; };
  const activeObservedBlock = (): ActiveObservedTerminalBlock | undefined => {
    if (!introductionCompleted(eventsCache)) return undefined;
    const lesson = activeLesson(loaded, eventsCache);
    const projection = project(eventsCache, lesson);
    const active = projection.blocks.find((block) => block.active);
    const authored = lesson.blocks.find((block) => block.id === active?.id);
    if (!authored || authored.type !== "terminal-practice") return undefined;
    return { lessonId: lesson.id, blockId: authored.id, command: authored.markdown, context: authored.markdown, expectedObservation: authored.tutor };
  };
  const activeEditorBlock = (): { lesson: WorkbookLesson; block: EditorPracticeBlock } | undefined => {
    if (!introductionCompleted(eventsCache)) return undefined;
    const lesson = activeLesson(loaded, eventsCache);
    const projection = project(eventsCache, lesson);
    const active = projection.blocks.find((block) => block.active && block.ready);
    const authored = lesson.blocks.find((block) => block.id === active?.id);
    if (!authored || authored.type !== "editor-practice") return undefined;
    return { lesson, block: authored };
  };
  const setEditorFeedback = (lessonId: string, blockId: string, revision: number, feedback: string) => {
    editorProgress.set(editorProgressKey(lessonId, blockId), { revision, editorStatus: "feedback", feedback: feedback.trim().slice(0, 1_000) || "Review is temporarily unavailable. Retrying the latest draft." });
  };
  const runEditorReview = async (lessonId: string, blockId: string): Promise<void> => {
    const key = editorProgressKey(lessonId, blockId);
    editorReviewTimers.delete(key);
    try {
      const request = await withEditorBlockLock(lessonId, blockId, async () => {
        await refreshEvents();
        const active = activeEditorBlock();
        if (!active || active.lesson.id !== lessonId || active.block.id !== blockId) return undefined;
        const draft = await editorDraftStore.read(lessonId, blockId);
        if (!draft) return undefined;
        return { privateBrief: active.block.tutor, draft };
      });
      if (!request) return;
      const decision = await editorReviewAdapter.review({ lessonId, blockId, privateBrief: request.privateBrief, draft: request.draft });
      await withEditorBlockLock(lessonId, blockId, async () => {
        await refreshEvents();
        const currentActive = activeEditorBlock();
        const currentDraft = await editorDraftStore.read(lessonId, blockId);
        if (!currentActive || currentActive.lesson.id !== lessonId || currentActive.block.id !== blockId || !currentDraft || currentDraft.revision !== request.draft.revision) return;
        if (decision.status === "feedback") {
          setEditorFeedback(lessonId, blockId, request.draft.revision, decision.message);
          return;
        }
        if (decision.revisionId !== request.draft.revision) {
          setEditorFeedback(lessonId, blockId, request.draft.revision, `Reviewer tried to unlock stale revision ${decision.revisionId}; the current revision is ${request.draft.revision}. Revise and submit the current draft again.`);
          return;
        }
        await editorDraftStore.promote(currentActive.block, request.draft);
        await store.append(nowEvent({ type: "editor_practice_unlocked", lessonId, blockId, revisionId: request.draft.revision, path: currentActive.block.path }));
        editorProgress.delete(key);
        const updated = await refreshEvents();
        await store.writeProjection(project(updated, activeLesson(loaded, updated)));
      });
    } catch (error) {
      const latest = await withEditorBlockLock(lessonId, blockId, async () => {
        const draft = await editorDraftStore.read(lessonId, blockId).catch(() => undefined);
        if (draft) setEditorFeedback(lessonId, blockId, draft.revision, "Review is temporarily unavailable. Retrying the latest draft.");
        return draft;
      });
      if (!latest) return;
      const retryDelay = Math.max(50, editorReviewDebounceMs);
      const existing = editorReviewTimers.get(key);
      if (existing) clearTimeout(existing);
      editorReviewTimers.set(key, setTimeout(() => { void runEditorReview(lessonId, blockId); }, retryDelay));
      log.info(`Editor-practice review failed; retrying latest draft. ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const enqueueEditorReview = (lessonId: string, blockId: string) => {
    const key = editorProgressKey(lessonId, blockId);
    const existing = editorReviewTimers.get(key);
    if (existing) clearTimeout(existing);
    editorReviewTimers.set(key, setTimeout(() => { void runEditorReview(lessonId, blockId); }, editorReviewDebounceMs));
  };
  const completeFromObserver = async (block: ActiveObservedTerminalBlock, summary: string, terminalHtml: string) => {
    const events = await refreshEvents();
    const active = activeObservedBlock();
    if (!active || active.lessonId !== block.lessonId || active.blockId !== block.blockId) return currentPublicState(events);
    // Verification holds the learner at a visible success checkpoint. Only an
    // explicit completion event reveals the next required block.
    await store.append(nowEvent({ type: "observation_verified", lessonId: block.lessonId, blockId: block.blockId, source: "terminal_observer", summary, terminalHtml }));
    const updated = await refreshEvents();
    await store.writeProjection(project(updated, activeLesson(loaded, updated)));
    return currentPublicState(updated);
  };
  const terminal = embeddedTerminalEnabled ? new WorkbookTerminalManager({
    workspace: loaded.workspace,
    getActiveBlock: activeObservedBlock,
    observer: options.terminalObserver ?? new PiTerminalObserver(loaded.workspace, log),
    onVerifiedCompletion: completeFromObserver,
    ptyFactory: options.terminalPtyFactory ?? createDockerPty,
    debounceMs: options.terminalDebounceMs,
    logger: log
  }) : undefined;
  const reflectionEvidence = (): PracticeEvidence[] => {
    const lesson = activeLesson(loaded, eventsCache);
    const current = project(eventsCache, lesson);
    const transcripts = new Map((terminal?.practiceTranscripts() ?? []).map((item) => [item.blockId, item.transcript]));
    return lesson.blocks.flatMap((block) => {
      const progress = current.blocks.find((item) => item.id === block.id);
      if (block.type !== "terminal-practice" || !progress?.emerged) return [];
      return [{ blockId: block.id, title: block.title, expectedObservation: block.tutor, transcript: transcripts.get(block.id), unexpectedOutput: current.unexpected[block.id] ?? [], verified: progress.verified, feedback: progress.feedback }];
    });
  };
  let server = createServer(async (request, response) => {
    headers(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && isRoute(url.pathname, "state")) return sendJson(response, 200, currentPublicState(await refreshEvents()));
    if (request.method === "POST" && isRoute(url.pathname, "introduction")) {
      const events = await refreshEvents();
      if (!introductionCompleted(events)) await store.append(nowEvent({ type: "workbook_introduction_completed" }));
      const updated = await refreshEvents();
      await store.writeProjection(project(updated, activeLesson(loaded, updated)));
      return sendJson(response, 202, currentPublicState(updated));
    }
    if (request.method === "POST" && isRoute(url.pathname, "editor")) {
      try {
        const body = await readJson(request);
        const blockId = typeof body.blockId === "string" ? body.blockId : "";
        const revision = body.revision;
        const text = body.text;
        if (!Number.isInteger(revision) || revision < 1) return sendJson(response, 400, { error: "Editor revision must be a positive integer." });
        if (typeof text !== "string") return sendJson(response, 400, { error: "Editor text must be a string." });
        if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return sendJson(response, 400, { error: "Editor text is too large." });
        const latest = await refreshEvents();
        if (!introductionCompleted(latest)) return sendJson(response, 409, { error: "Complete the workbook introduction first." });
        const lesson = activeLesson(loaded, latest);
        const result = await withEditorBlockLock(lesson.id, blockId, async () => {
          await refreshEvents();
          const active = activeEditorBlock();
          if (!active || active.block.id !== blockId) return { status: 409, body: { error: "This editor block is not active yet." } };
          try { await resolveEditorTarget(loaded.workspace, active.block.path); }
          catch (error) { return { status: 400, body: { error: error instanceof Error ? error.message : "Unsafe editor target path." } }; }
          const currentDraft = await editorDraftStore.read(active.lesson.id, active.block.id);
          if (currentDraft && revision <= currentDraft.revision) return { status: 409, body: { error: "Editor revision is stale." } };
          await editorDraftStore.write(active.lesson.id, active.block.id, revision, text);
          editorProgress.set(editorProgressKey(active.lesson.id, active.block.id), { revision, editorStatus: "reviewing" });
          enqueueEditorReview(active.lesson.id, active.block.id);
          return { status: 202, body: currentPublicState(await refreshEvents()) };
        });
        return sendJson(response, result.status, result.body);
      } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." }); }
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
        // A block event is evidence for the current activity, never a way for a
        // browser request to skip the ordered lesson contract. Help remains
        // available on visible held blocks, but only the active activity can
        // produce progress evidence.
        if (body.action !== "help" && (!progress?.active || !progress.ready)) {
          return sendJson(response, 409, { error: "This block is not active yet." });
        }
        if ((body.action === "reflection-submit" || body.action === "reflection-follow-up") && block.type === "reflection") {
          const learnerResponse = typeof body.response === "string" ? body.response.trim().slice(0, 4_000) : "";
          if (!learnerResponse) return sendJson(response, 400, { error: "Write a reflection before discussing it." });
          const conversation = current.reflectionConversations[block.id] ?? [];
          const isFirst = body.action === "reflection-submit";
          if ((isFirst && conversation.length > 0) || (!isFirst && !conversation.some((turn) => turn.role === "tutor"))) return sendJson(response, 409, { error: "Wait for the tutor reply before adding a follow-up." });
          // Keep turns in request order if an eager browser submits twice.
          let result: any;
          await (reflectionQueue = reflectionQueue.then(async () => {
            await store.append(nowEvent(isFirst
              ? { type: "reflection_submitted", lessonId: lesson.id, blockId: block.id, response: learnerResponse }
              : { type: "reflection_follow_up_submitted", lessonId: lesson.id, blockId: block.id, response: learnerResponse }));
            const updated = await refreshEvents();
            const thread = project(updated, lesson).reflectionConversations[block.id] ?? [];
            const reply = await reflectionConversation.reply({ question: block.markdown, tutor: block.tutor, message: learnerResponse, conversation: thread, practiceEvidence: reflectionEvidence() });
            await store.append(nowEvent({ type: "reflection_reply_recorded", lessonId: lesson.id, blockId: block.id, response: reply }));
            const complete = await refreshEvents(); await store.writeProjection(project(complete, activeLesson(loaded, complete)));
            result = currentPublicState(complete);
          }));
          return sendJson(response, 202, result);
        }
        let event: WorkbookEvent | undefined;
        if (body.action === "complete" && block.type === "terminal-practice" && progress?.verified && !progress.completed) event = nowEvent({ type: "block_completed", lessonId: lesson.id, blockId: block.id });
        if (body.action === "continue" && (block.type === "narrative" || block.type === "lesson-transition")) event = nowEvent({ type: "block_continued", lessonId: lesson.id, blockId: block.id });
        if (body.action === "unexpected" && block.type === "terminal-practice" && typeof body.evidence === "string") event = nowEvent({ type: "unexpected_output_submitted", lessonId: lesson.id, blockId: block.id, evidence: body.evidence });
        if (body.action === "reflection-complete" && block.type === "reflection" && (current.reflectionConversations[block.id] ?? []).some((turn) => turn.role === "tutor")) event = nowEvent({ type: "reflection_completed", lessonId: lesson.id, blockId: block.id });
        if (body.action === "help" && typeof body.request === "string") event = nowEvent({ type: "help_requested", lessonId: lesson.id, blockId: block.id, request: body.request });
        if (!event) return sendJson(response, 400, { error: "Invalid workbook action for this block." });
        await store.append(event);
        const events = await refreshEvents();
        await store.writeProjection(project(events, activeLesson(loaded, events)));
        return sendJson(response, 202, currentPublicState(events));
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
    for (const timer of editorReviewTimers.values()) clearTimeout(timer);
    editorReviewTimers.clear();
    terminal?.dispose();
    wss?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  } };
}
