import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LOOPBACK_HOST } from "../server/local-server.js";
import type { TutorialLogger } from "../runtime-log.js";
import { createTutorialLogger } from "../runtime-log.js";
import { OBSERVED_TERMINAL_MODE } from "./contract.js";
import { loadWorkbook, type LoadedWorkbook } from "./load.js";
import { introductionCompleted, nowEvent, project, WorkbookEventStore, type WorkbookEvent } from "./events.js";
import { PiTerminalObserver, WorkbookTerminalManager, type ActiveObservedTerminalBlock, type TerminalObserver, type TerminalPtyFactory } from "./terminal.js";

const MIME_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 16_384;

export interface WorkbookServerOptions { target: string; webRoot: string; port?: number; host?: string; logger?: TutorialLogger; terminalObserver?: TerminalObserver; terminalPtyFactory?: TerminalPtyFactory; terminalDebounceMs?: number; }
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
 * The lesson whose progression is live: the first migrated lesson defined by the
 * authored workbook. Selection follows the curriculum, so no lesson ID is
 * hard-coded into the runtime.
 */
function activeLesson(loaded: LoadedWorkbook) {
  const lesson = loaded.chapters.find((chapter) => chapter.lesson)?.lesson;
  if (!lesson) throw new Error("No workbook lesson is migrated.");
  return lesson;
}
function publicState(loaded: LoadedWorkbook, events: WorkbookEvent[]) {
  const lesson = activeLesson(loaded);
  const progress = project(events, lesson);
  const introductionComplete = introductionCompleted(events);
  const emerged = new Set(progress.blocks.filter((block) => block.emerged).map((block) => block.id));
  const chapters = loaded.chapters.map((chapter) => chapter.lesson && introductionComplete
    ? { ...chapter, lesson: { ...chapter.lesson, blocks: chapter.lesson.blocks.filter((block) => emerged.has(block.id)) } }
    : { ...chapter, lesson: undefined, state: "unavailable" as const });
  return { workbook: loaded.identity, introduction: loaded.introduction, introductionComplete, chapters, progress, adapter: { modelBackedHelp: false, note: "Free-text help is block-scoped. No model adapter is wired in this vertical slice." } };
}

export async function startWorkbookServer(options: WorkbookServerOptions): Promise<StartedWorkbookServer> {
  const log = options.logger ?? createTutorialLogger();
  await access(resolve(options.webRoot, "index.html"));
  const loaded = await loadWorkbook(options.target);
  const lesson = activeLesson(loaded);
  const embeddedTerminalEnabled = lesson.blocks.some((block) => block.type === "terminal-practice" && block.terminalMode === OBSERVED_TERMINAL_MODE);
  const host = options.host ?? LOOPBACK_HOST;
  if (embeddedTerminalEnabled && !isLoopbackHost(host)) throw new Error("The embedded terminal can only be enabled on a loopback host; it exposes a real local shell.");
  const store = new WorkbookEventStore(loaded.workspace);
  if ((await store.read()).length === 0) await store.append(nowEvent({ type: "session_started" }));
  let eventsCache = await store.read();
  const refreshEvents = async () => { eventsCache = await store.read(); return eventsCache; };
  const activeObservedBlock = (): ActiveObservedTerminalBlock | undefined => {
    if (!introductionCompleted(eventsCache)) return undefined;
    const projection = project(eventsCache, lesson);
    const active = projection.blocks.find((block) => block.active);
    const authored = lesson.blocks.find((block) => block.id === active?.id);
    if (!authored || authored.type !== "terminal-practice" || authored.terminalMode !== OBSERVED_TERMINAL_MODE) return undefined;
    return { lessonId: lesson.id, blockId: authored.id, command: authored.command, context: authored.context, expectedObservation: authored.expectedObservation };
  };
  const completeFromObserver = async (block: ActiveObservedTerminalBlock) => {
    const events = await refreshEvents();
    const active = activeObservedBlock();
    if (!active || active.lessonId !== block.lessonId || active.blockId !== block.blockId) return publicState(loaded, events);
    await store.append(nowEvent({ type: "observation_verified", lessonId: block.lessonId, blockId: block.blockId, source: "terminal_observer" }));
    const updated = await refreshEvents();
    await store.writeProjection(project(updated, lesson));
    return publicState(loaded, updated);
  };
  const terminal = embeddedTerminalEnabled ? new WorkbookTerminalManager({
    workspace: loaded.workspace,
    getActiveBlock: activeObservedBlock,
    observer: options.terminalObserver ?? new PiTerminalObserver(loaded.workspace, log),
    onVerifiedCompletion: completeFromObserver,
    ptyFactory: options.terminalPtyFactory,
    debounceMs: options.terminalDebounceMs,
    logger: log
  }) : undefined;
  let server = createServer(async (request, response) => {
    headers(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && isRoute(url.pathname, "state")) return sendJson(response, 200, publicState(loaded, await refreshEvents()));
    if (request.method === "POST" && isRoute(url.pathname, "introduction")) {
      const events = await refreshEvents();
      if (!introductionCompleted(events)) await store.append(nowEvent({ type: "workbook_introduction_completed" }));
      const updated = await refreshEvents();
      await store.writeProjection(project(updated, lesson));
      return sendJson(response, 202, publicState(loaded, updated));
    }
    if (request.method === "POST" && isRoute(url.pathname, "events")) {
      try {
        const body = await readJson(request);
        if (!introductionCompleted(await refreshEvents())) return sendJson(response, 409, { error: "Complete the workbook introduction first." });
        const block = lesson.blocks.find((candidate) => candidate.id === body.blockId);
        if (!block) return sendJson(response, 400, { error: "Unknown blockId." });
        const current = project(await refreshEvents(), lesson);
        const progress = current.blocks.find((candidate) => candidate.id === block.id);
        // A block event is evidence for the current activity, never a way for a
        // browser request to skip the ordered lesson contract. Help remains
        // available on visible held blocks, but only the active activity can
        // produce progress evidence.
        if (body.action !== "help" && (!progress?.active || !progress.ready)) {
          return sendJson(response, 409, { error: "This block is not active yet." });
        }
        let event: WorkbookEvent | undefined;
        if (body.action === "acknowledge" && block.type === "terminal-practice") event = nowEvent({ type: "observation_acknowledged", lessonId: lesson.id, blockId: block.id });
        if (body.action === "unexpected" && block.type === "terminal-practice" && typeof body.evidence === "string") event = nowEvent({ type: "unexpected_output_submitted", lessonId: lesson.id, blockId: block.id, evidence: body.evidence });
        if (body.action === "reflect" && block.type === "reflection" && typeof body.response === "string") event = nowEvent({ type: "reflection_submitted", lessonId: lesson.id, blockId: block.id, response: body.response });
        if (body.action === "transition" && block.type === "lesson-transition") event = nowEvent({ type: "lesson_transitioned", lessonId: lesson.id, blockId: block.id });
        if (body.action === "help" && typeof body.request === "string") event = nowEvent({ type: "help_requested", lessonId: lesson.id, blockId: block.id, request: body.request });
        if (!event) return sendJson(response, 400, { error: "Invalid workbook action for this block." });
        await store.append(event);
        const events = await refreshEvents();
        await store.writeProjection(project(events, lesson));
        return sendJson(response, 202, publicState(loaded, events));
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
    terminal?.dispose();
    wss?.close();
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  } };
}
