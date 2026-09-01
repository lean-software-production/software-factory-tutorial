import { createReadStream } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { TutorialLogger } from "./runtime-log.js";
import { createTutorialLogger } from "./runtime-log.js";
import { createDockerPty, requireOpenCodeApiKey, WorkbookTerminalManager, type TerminalPtyFactory } from "./terminal.js";
import { publicTerminalFrame } from "./public-terminal-contract.js";
import { NO_RUNTIME_PROVISION, trustRuntimeProvision, type RuntimeProvisionProfile, type TrustedRuntimeProvision } from "./runtime-provision.js";
import { AttemptStore } from "./attempts.js";
import { DefaultMainWorkbookTutor, type MainWorkbookTutor } from "./tutor.js";
import { WorkbookTimeline } from "./timeline.js";
import { tutorialStatePath } from "./tutorial-state.js";
import { watchWorkbookContent, type ContentWatch, type ContentWatchFactory } from "./content-watch.js";
import { createWorkbookWorkflow, WorkbookWorkflowCommandError } from "./workflow.js";
import { AUTHORED_WORKSPACES_DIRECTORY, SESSION_STATE_DIRECTORY, SESSION_WORKSPACES_DIRECTORY, discoverDeclaredLessonWorkspaces, validateLessonWorkspaceId, validateSessionId } from "../session-workspace.js";

const LOOPBACK_HOST = "127.0.0.1";
const MIME_TYPES: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGE_BYTES = 4_000;

export interface WorkbookRuntimeDescriptor { contentRoot: string; sessionRoot: string; workspacesRoot?: string; workspaceRoots: Record<string, string>; runtimeProvision?: TrustedRuntimeProvision; }
export interface WorkbookServerOptions { target: string; webRoot: string; session?: WorkbookRuntimeDescriptor; runtimeProvision?: RuntimeProvisionProfile; port?: number; host?: string; logger?: TutorialLogger; embeddedTerminal?: boolean; terminalPtyFactory?: TerminalPtyFactory; terminalDebounceMs?: number; mainTutor?: MainWorkbookTutor; watchContent?: boolean; contentWatchFactory?: ContentWatchFactory; contentWatchDebounceMs?: number; }
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

function inside(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return candidateRelative === "" || (candidateRelative !== ".." && !candidateRelative.startsWith(`..${sep}`) && !isAbsolute(candidateRelative));
}

async function requireDirectoryRoot(path: string, label: string): Promise<string> {
  const real = await realpath(resolve(path));
  if (!(await stat(real)).isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  return real;
}

async function requireRealDirectory(path: string, label: string): Promise<string> {
  const resolved = resolve(path);
  let info;
  try { info = await lstat(resolved); }
  catch { throw new Error(`${label} does not exist: ${path}`); }
  if (info.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symlink: ${path}`);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  return await realpath(resolved);
}

async function requireExactDirectWorkspaceRoot(parentRoot: string, workspaceId: string, label: string): Promise<string> {
  const id = validateLessonWorkspaceId(workspaceId, label);
  const expected = resolve(parentRoot, id);
  if (!inside(parentRoot, expected) || relative(parentRoot, expected).includes(sep)) throw new Error(`${label} '${id}' must be a direct child of the workspace root.`);
  const real = await requireRealDirectory(expected, `${label} '${id}'`);
  if (real !== expected) throw new Error(`${label} '${id}' must be the exact real direct child of the workspace root.`);
  return real;
}

async function validateAuthoredWorkspaceRoots(contentRoot: string, workspaceIds: readonly string[]): Promise<Record<string, string>> {
  const authoredRoot = resolve(contentRoot, AUTHORED_WORKSPACES_DIRECTORY);
  const workspaceRoots: Record<string, string> = {};
  for (const workspaceId of workspaceIds) workspaceRoots[workspaceId] = await requireExactDirectWorkspaceRoot(authoredRoot, workspaceId, "Authored workspace");
  return workspaceRoots;
}

function assertSameWorkspaceRootKeys(supplied: Record<string, string>, declaredIds: readonly string[]): void {
  const declared = new Set(declaredIds);
  for (const id of Object.keys(supplied)) {
    validateLessonWorkspaceId(id, "session.workspaceRoots key");
    if (!declared.has(id)) throw new Error(`Session workspaceRoots contains undeclared workspace '${id}'. Start a new session for changed workspace declarations.`);
  }
  for (const id of declaredIds) if (!Object.prototype.hasOwnProperty.call(supplied, id)) throw new Error(`Session workspaceRoots is missing declared workspace '${id}'. Start a new session for changed workspace declarations.`);
}

async function validateSessionWorkspaceRoots(contentRoot: string, session: WorkbookRuntimeDescriptor, declaredIds: readonly string[]): Promise<{ sessionRoot: string; workspacesRoot: string; workspaceRoots: Record<string, string> }> {
  const stateRoot = await requireRealDirectory(resolve(contentRoot, SESSION_STATE_DIRECTORY), "Tutorial state directory");
  const sessionRoot = await requireRealDirectory(session.sessionRoot, "Workbook session root");
  if (!inside(stateRoot, sessionRoot)) throw new Error("Workbook session root must stay inside the tutorial state directory.");
  const sessionId = "sessionId" in session && typeof session.sessionId === "string" ? session.sessionId : basename(sessionRoot);
  validateSessionId(sessionId);
  if (sessionRoot !== resolve(stateRoot, sessionId)) throw new Error("Workbook session root must be the exact real tutorial session directory.");

  const expectedWorkspacesRoot = resolve(sessionRoot, SESSION_WORKSPACES_DIRECTORY);
  const workspacesRoot = await requireRealDirectory(session.workspacesRoot ?? expectedWorkspacesRoot, "Workbook session workspaces root");
  if (workspacesRoot !== expectedWorkspacesRoot) throw new Error("Workbook session workspaces root must be the exact real workspaces directory for this session.");

  assertSameWorkspaceRootKeys(session.workspaceRoots ?? {}, declaredIds);
  const workspaceRoots: Record<string, string> = {};
  for (const id of declaredIds) {
    const expectedRoot = await requireExactDirectWorkspaceRoot(workspacesRoot, id, "Session workspace");
    const supplied = session.workspaceRoots?.[id];
    if (!supplied) throw new Error(`Session workspaceRoots is missing declared workspace '${id}'. Start a new session for changed workspace declarations.`);
    const suppliedRoot = await requireRealDirectory(supplied, `Session workspace '${id}' root`);
    if (suppliedRoot !== expectedRoot) throw new Error(`Session workspace root for '${id}' does not match the declared live workspace root.`);
    await requireRealDirectory(resolve(expectedRoot, ".git"), `Session workspace '${id}' Git directory`);
    workspaceRoots[id] = expectedRoot;
  }
  return { sessionRoot, workspacesRoot, workspaceRoots };
}

async function resolveRuntime(options: WorkbookServerOptions): Promise<WorkbookRuntimeDescriptor & { contentRoot: string; sessionRoot: string; workspaceRoots: Record<string, string>; runtimeProvision: TrustedRuntimeProvision }> {
  const contentRoot = await requireDirectoryRoot(options.session?.contentRoot ?? options.target, "Workbook content root");
  const runtimeProvision = options.session?.runtimeProvision ?? (options.runtimeProvision ? trustRuntimeProvision(options.runtimeProvision) : NO_RUNTIME_PROVISION);
  const declaredWorkspaceIds = await discoverDeclaredLessonWorkspaces(contentRoot);
  for (const id of declaredWorkspaceIds) validateLessonWorkspaceId(id, "declared lesson workspace");
  if (options.session) {
    const sessionRuntime = await validateSessionWorkspaceRoots(contentRoot, options.session, declaredWorkspaceIds);
    return { contentRoot, runtimeProvision, ...sessionRuntime };
  }
  const sessionRoot = resolve(tutorialStatePath(options.target));
  const workspaceRoots = await validateAuthoredWorkspaceRoots(contentRoot, declaredWorkspaceIds);
  return { contentRoot, sessionRoot, workspaceRoots, runtimeProvision };
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
  let terminal: WorkbookTerminalManager | undefined;
  const workflow = await createWorkbookWorkflow({
    contentRoot: runtime.contentRoot,
    workspaceRootForId: (workspaceId) => runtime.workspaceRoots[workspaceId],
    timeline,
    attempts,
    mainTutor,
    activeTerminalContext: () => terminal?.activeTranscriptContext(),
    acquireTerminalCompletionFence: (block) => terminal?.acquireCompletionFence(block) ?? true,
    releaseTerminalCompletionFence: (block) => terminal?.releaseCompletionFence(block),
    onTerminalContinued: (block) => terminal?.resetAfterTerminalContinuation(block),
    log
  });
  await workflow.start();

  terminal = embeddedTerminalEnabled ? new WorkbookTerminalManager({
    workspace: runtime.sessionRoot,
    runtimeProvision: runtime.runtimeProvision,
    getActiveBlock: workflow.activeObservedBlock,
    observationSink: workflow.observeTerminalFact,
    ptyFactory: options.terminalPtyFactory ?? createDockerPty,
    logger: log,
  }) : undefined;
  try { terminal?.start(); }
  catch (error) { terminal?.dispose(); await workflow.close(); mainTutor.dispose(); throw error; }

  const logTerminalStartupFailure = (operation: string, error: unknown): void => {
    log.info(`Embedded terminal ${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
  };
  const startTerminalAfterProgression = (): void => {
    try { terminal?.start(); }
    catch (error) { logTerminalStartupFailure("startup after progression", error); }
  };
  const reconcileTerminalAfterReload = (): void => {
    try { terminal?.reconcileActiveTerminal(); }
    catch (error) { logTerminalStartupFailure("reconciliation after content reload", error); }
  };

  let contentWatch: ContentWatch | undefined;
  let contentReloads: Promise<void> = Promise.resolve();
  const sseClients = new Set<ServerResponse>();
  const sendSse = (response: ServerResponse, event: string, data: unknown): void => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const broadcastSse = (event: string, data: unknown): void => { for (const client of sseClients) sendSse(client, event, data); };
  const queueContentReload = (): void => {
    contentReloads = contentReloads.then(async () => {
      const result = await workflow.reloadContent();
      if (result.outcome === "reloaded") {
        reconcileTerminalAfterReload();
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
      const unsubscribeRecords = workflow.subscribe((record) => sendSse(response, "record", record));
      const unsubscribeState = workflow.subscribeState((event) => sendSse(response, "state", event));
      request.on("close", () => { unsubscribeRecords(); unsubscribeState(); sseClients.delete(response); });
      return;
    }
    if (request.method === "GET" && isRoute(url.pathname, "state")) return sendJson(response, 200, await workflow.state());
    if (request.method === "POST" && isRoute(url.pathname, "introduction")) {
      try { return sendJson(response, 202, (await workflow.completeBlock("workbook--introduction")).state); }
      catch (error) { return sendJson(response, errorStatus(error), { error: errorMessage(error) }); }
    }
    if (request.method === "POST" && (isRoute(url.pathname, "complete-block") || isRoute(url.pathname, "completeBlock") || url.pathname.endsWith("/api/workbook/blocks/complete"))) {
      try {
        const body = await readJson(request);
        const blockId = typeof body.blockId === "string" ? body.blockId : "";
        if (!blockId) return sendJson(response, 400, { error: "blockId is required." });
        const result = await workflow.completeBlock(blockId);
        startTerminalAfterProgression();
        return sendJson(response, 202, result);
      }
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
    if (request.method === "POST" && isRoute(url.pathname, "editor")) {
      try {
        const body = await readJson(request); const text = typeof body.text === "string" ? body.text : undefined;
        if (text === undefined) return sendJson(response, 400, { error: "Editor text must be a string." });
        if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return sendJson(response, 400, { error: "Editor text is too large." });
        const revision = typeof body.revision === "number" ? body.revision : undefined;
        return sendJson(response, 202, await workflow.submitEditor(typeof body.blockId === "string" ? body.blockId : "", text, revision));
      } catch (error) { return sendJson(response, errorStatus(error, /accepted work|not active/i.test(errorMessage(error)) ? 409 : 400), { error: errorMessage(error) }); }
    }
    if (request.method === "POST" && isRoute(url.pathname, "events")) {
      try {
        const body = await readJson(request);
        const result = await workflow.submitEvent({ blockId: typeof body.blockId === "string" ? body.blockId : "", action: typeof body.action === "string" ? body.action : "", response: typeof body.response === "string" ? body.response : undefined });
        startTerminalAfterProgression();
        return sendJson(response, 202, result);
      }
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
      if (!terminal.attach(client)) { socket.send(publicTerminalFrame({ type: "busy", message: "Another browser is already connected to this terminal." })); socket.close(1013, "Terminal already connected."); return; }
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
