import { createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { TutorialLogger } from "./runtime-log.js";
import { createTutorialLogger } from "./runtime-log.js";
import { createDockerPty, requireOpenCodeApiKey, WorkbookTerminalManager, type TerminalPtyFactory } from "./terminal.js";
import { NO_RUNTIME_PROVISION, trustRuntimeProvision, type RuntimeProvisionProfile, type TrustedRuntimeProvision } from "./runtime-provision.js";
import { AttemptStore } from "./attempts.js";
import { FastWorkbookBlockTutor, type WorkbookBlockTutor } from "./block-tutor.js";
import { DefaultMainWorkbookTutor, type MainWorkbookTutor } from "./tutor.js";
import { WorkbookTimeline } from "./timeline.js";
import { tutorialStatePath } from "./tutorial-state.js";
import { watchWorkbookContent, type ContentWatch, type ContentWatchFactory } from "./content-watch.js";
import { createWorkbookWorkflow, WorkbookWorkflowCommandError } from "./workflow.js";

const LOOPBACK_HOST = "127.0.0.1";
const MIME_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGE_BYTES = 4_000;

export interface WorkbookRuntimeDescriptor { contentRoot: string; sessionRoot: string; workspaceRoot: string; runtimeProvision?: TrustedRuntimeProvision; }
export interface WorkbookServerOptions { target: string; webRoot: string; session?: WorkbookRuntimeDescriptor; runtimeProvision?: RuntimeProvisionProfile; port?: number; host?: string; logger?: TutorialLogger; embeddedTerminal?: boolean; terminalPtyFactory?: TerminalPtyFactory; terminalDebounceMs?: number; mainTutor?: MainWorkbookTutor; blockTutor?: WorkbookBlockTutor; watchContent?: boolean; contentWatchFactory?: ContentWatchFactory; contentWatchDebounceMs?: number; }
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
function hostHeaderName(request: IncomingMessage): string | undefined { return request.headers.host?.split(":")[0]?.replace(/^\[/, "").replace(/\]$/, ""); }
function isTerminalRoute(pathname: string): boolean { return pathname === "/api/workbook/terminal" || pathname.endsWith("/api/workbook/terminal"); }
function originAllowed(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const parsed = new URL(origin); return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname) && Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)) === port; }
  catch { return false; }
}
function parseTerminalMessage(data: RawData) { try { return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as any).toString("utf8")); } catch { return undefined; } }

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
function errorStatus(error: unknown, fallback = 400): number { return error instanceof WorkbookWorkflowCommandError ? error.status : fallback; }
function errorMessage(error: unknown, fallback = "Bad request."): string { return error instanceof Error ? error.message : fallback; }

export async function startWorkbookServer(options: WorkbookServerOptions): Promise<StartedWorkbookServer> {
  const log = options.logger ?? createTutorialLogger();
  await access(resolve(options.webRoot, "index.html"));
  const runtime = await resolveRuntime(options);
  const embeddedTerminalEnabled = options.embeddedTerminal ?? true;
  const host = options.host ?? LOOPBACK_HOST;
  if (embeddedTerminalEnabled && !isLoopbackHost(host)) throw new Error("The embedded terminal can only be enabled on a loopback host; it exposes an isolated container shell.");
  if (embeddedTerminalEnabled) requireOpenCodeApiKey();

  const timeline = new WorkbookTimeline({ stateRoot: runtime.sessionRoot });
  const attempts = new AttemptStore({ stateRoot: runtime.sessionRoot });
  const mainTutor = options.mainTutor ?? new DefaultMainWorkbookTutor({ workspace: runtime.contentRoot, log });
  const blockTutor = options.blockTutor ?? new FastWorkbookBlockTutor({ workspace: runtime.workspaceRoot, contentRoot: runtime.contentRoot, log });
  const workflow = await createWorkbookWorkflow({ contentRoot: runtime.contentRoot, learnerWorkspace: runtime.workspaceRoot, timeline, attempts, mainTutor, blockTutor, log });
  await workflow.start();

  const terminal = embeddedTerminalEnabled ? new WorkbookTerminalManager({
    workspace: runtime.workspaceRoot,
    runtimeProvision: runtime.runtimeProvision,
    getActiveBlock: workflow.activeObservedBlock,
    submitAttempt: async (input) => { await workflow.submitAttempt(input); },
    ptyFactory: options.terminalPtyFactory ?? createDockerPty,
    debounceMs: options.terminalDebounceMs,
    logger: log,
  }) : undefined;
  try { terminal?.start(); }
  catch (error) { terminal?.dispose(); await workflow.close(); mainTutor.dispose(); throw error; }

  let contentWatch: ContentWatch | undefined;
  let contentReloads: Promise<void> = Promise.resolve();
  const sseClients = new Set<ServerResponse>();
  const sendSse = (response: ServerResponse, event: string, data: unknown): void => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const broadcastSse = (event: string, data: unknown): void => { for (const client of sseClients) sendSse(client, event, data); };
  const queueContentReload = (): void => {
    contentReloads = contentReloads.then(async () => {
      const result = await workflow.reloadContent();
      if (result.outcome === "reloaded") {
        await contentWatch?.rescan().catch((error) => log.info(`Workbook content watcher rescan failed: ${error instanceof Error ? error.message : String(error)}`));
        broadcastSse("content-reloaded", { generation: result.generation });
      } else if (result.outcome === "error") broadcastSse("content-reload-error", { message: result.message });
    }, async () => undefined).catch((error) => {
      const message = errorMessage(error, "The workbook content could not be loaded yet.").replace(/\s+/g, " ").trim().slice(0, 500);
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
      sendSse(response, "timeline", workflow.timeline());
      const unsubscribe = workflow.subscribe((record) => sendSse(response, "record", record));
      request.on("close", () => { unsubscribe(); sseClients.delete(response); });
      return;
    }
    if (request.method === "GET" && isRoute(url.pathname, "state")) return sendJson(response, 200, await workflow.state());
    if (request.method === "POST" && isRoute(url.pathname, "introduction")) return sendJson(response, 202, (await workflow.completeBlock("workbook--introduction")).state);
    if (request.method === "POST" && (isRoute(url.pathname, "complete-block") || isRoute(url.pathname, "completeBlock") || url.pathname.endsWith("/api/workbook/blocks/complete"))) {
      try { const body = await readJson(request); const blockId = typeof body.blockId === "string" ? body.blockId : ""; if (!blockId) return sendJson(response, 400, { error: "blockId is required." }); return sendJson(response, 202, await workflow.completeBlock(blockId)); }
      catch (error) { return sendJson(response, errorStatus(error), { error: errorMessage(error) }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "messages")) {
      try {
        const body = await readJson(request); const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) return sendJson(response, 400, { error: "Message text is required." });
        if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return sendJson(response, 400, { error: "Message text is too large." });
        return sendJson(response, 202, await workflow.sendMessage({ blockId: typeof body.blockId === "string" ? body.blockId : "", text, blockInView: typeof body.blockInView === "string" ? body.blockInView : undefined }));
      } catch (error) { return sendJson(response, errorStatus(error), { error: errorMessage(error) }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "hints")) {
      try { const body = await readJson(request); return sendJson(response, 202, await workflow.appendHint(typeof body.blockId === "string" ? body.blockId : "")); }
      catch (error) { return sendJson(response, errorStatus(error), { error: errorMessage(error) }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "retry")) {
      try { const body = await readJson(request); return sendJson(response, 202, await workflow.retry(typeof body.failureId === "string" ? body.failureId : "")); }
      catch (error) { return sendJson(response, errorStatus(error), { error: errorMessage(error) }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "editor")) {
      try {
        const body = await readJson(request); const text = typeof body.text === "string" ? body.text : undefined;
        if (text === undefined) return sendJson(response, 400, { error: "Editor text must be a string." });
        if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return sendJson(response, 400, { error: "Editor text is too large." });
        return sendJson(response, 202, await workflow.submitEditor(typeof body.blockId === "string" ? body.blockId : "", text));
      } catch (error) { return sendJson(response, errorStatus(error, /accepted work|not active/i.test(errorMessage(error)) ? 409 : 400), { error: errorMessage(error) }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "events")) {
      try { const body = await readJson(request); return sendJson(response, 202, await workflow.submitEvent({ blockId: typeof body.blockId === "string" ? body.blockId : "", action: typeof body.action === "string" ? body.action : "", response: typeof body.response === "string" ? body.response : undefined })); }
      catch (error) { return sendJson(response, errorStatus(error), { error: errorMessage(error) }); }
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
  if (options.watchContent) contentWatch = watchWorkbookContent(runtime.contentRoot, queueContentReload, (error) => log.info(`Workbook content watcher failed: ${error.message}`), { watchFactory: options.contentWatchFactory, debounceMs: options.contentWatchDebounceMs });
  const url = `http://${LOOPBACK_HOST}:${address.port}`;
  log.info(`Workbook tutor listening on ${url}. State: ${timeline.eventPath}${terminal ? " Embedded terminal enabled on loopback only." : ""}${contentWatch ? " Content watch enabled." : ""}`);
  return { url, port: address.port, host, close: async () => { contentWatch?.close(); terminal?.dispose(); wss?.close(); for (const client of sseClients) client.end(); sseClients.clear(); await Promise.allSettled([contentReloads, workflow.close()]); mainTutor.dispose(); const closing = new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())); server.closeAllConnections(); await closing; } };
}
