import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { LessonDefinition } from "../lesson/contract.js";
import { ensureLineBranch } from "../lesson/branch.js";
import { currentSpecPath, loadProgress, skipToPartTwo, type ProgressItem } from "../lesson/load.js";
import { PiTutorialAdapter } from "../agent/pi-adapter.js";
import { TutorialEventBus } from "../protocol/event-bus.js";
import { isBrowserMessage, type BrowserMessage, type RunState, type SessionBootstrap, type TutorialEvent } from "../protocol/events.js";
import { createTutorialLogger, type TutorialLogger } from "../runtime-log.js";
import { resetFactory, TutorialSessionLog } from "../session-log.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2"
};
const MAX_BODY_BYTES = 16_384;

// The tutorial reads and writes the learner's working tree and has no authentication,
// so it stays on loopback unless a host is asked for explicitly. Environments that
// proxy it — the canvas dev-server control — opt in with --host 0.0.0.0.
export const LOOPBACK_HOST = "127.0.0.1";

export interface LocalServerOptions {
  lesson: LessonDefinition;
  workspace: string;
  webRoot: string;
  progress: ProgressItem[];
  port?: number;
  host?: string;
  logger?: TutorialLogger;
}

export interface StartedServer {
  url: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

// A proxy may mount the tutorial under a subfolder (the canvas dev-server control does)
// and pass the prefix through, so match routes and assets by suffix rather than exact path.
function isRoute(pathname: string, route: string): boolean {
  return pathname === `/api/${route}` || pathname.endsWith(`/api/${route}`);
}

function assetPaths(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return ["/index.html"];
  const paths = segments.map((_, index) => `/${segments.slice(index).join("/")}`);
  return pathname.endsWith("/") ? [...paths, "/index.html"] : paths;
}

function writeEvent(response: ServerResponse, event: TutorialEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Request body must be JSON."); }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function headers(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  // SAMEORIGIN rather than DENY so a same-origin subfolder proxy (the canvas
  // dev-server control frames /dev/<port>/) can embed the tutorial.
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'");
}

export async function startLocalServer(options: LocalServerOptions): Promise<StartedServer> {
  const log = options.logger ?? createTutorialLogger();
  log.info(`Checking browser interface at ${resolve(options.webRoot, "index.html")}.`);
  await access(resolve(options.webRoot, "index.html"));

  const bus = new TutorialEventBus();
  const sessionLog = new TutorialSessionLog(options.workspace);
  const hasSavedSession = await sessionLog.exists();
  let adapter: PiTutorialAdapter | undefined;
  let runState: RunState = "idle";
  // Always a choice, saved session or not: starting at Part 2 is a decision a
  // first-time learner makes, and auto-starting would hide it from exactly the
  // people who want it.
  let bootstrap: SessionBootstrap = { state: "select", hasSavedSession };
  let persistenceUnsubscribe: (() => void) | undefined;
  let startPromise: Promise<void> | undefined;
  const clients = new Set<ServerResponse>();
  let server: Server;

  const publishBootstrap = () => bus.publish({ type: "session-state", session: bootstrap });

  // A `progress` event is transient, so it is never replayed from history. Hold
  // the latest here instead, or a refreshed browser would be sent the outline as
  // it stood when the server started.
  let progress = options.progress;
  bus.subscribe((event) => { if (event.type === "progress") progress = event.progress; });

  const startSession = (mode: "resume" | "fresh" | "part-2", reset = false): Promise<void> => {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      bootstrap = { ...bootstrap, state: "starting" };
      runState = "working";
      publishBootstrap();
      // From lesson 007 the line commits to the calculator, which has no
      // repository of its own. Do this before the tutor begins so no commit can
      // land on the branch the learner cloned.
      await ensureLineBranch(options.workspace, log);
      if (mode === "resume") {
        const history = await sessionLog.read();
        bus.restore(history.map((event) => event.type === "choice" ? { ...event, historical: true } : event));
      } else if (mode === "part-2") {
        // Part 2's first lesson moves files Part 1 builds, so skipping means
        // seeding that output, not only moving the outline's highlight.
        log.info("Starting at Part 2: clearing factory/ and seeding Part 1's output.");
        await resetFactory(options.workspace);
        await sessionLog.clear();
        const skip = await skipToPartTwo(options.workspace);
        log.info(`Seeded ${skip.seeded.join(", ")}; marked ${skip.skipped.join(", ")} skipped.`);
        bus.publish({ type: "progress", progress: skip.progress });
      } else if (reset) {
        log.info("Starting over: removing learner artifacts from factory/.");
        await resetFactory(options.workspace);
        await sessionLog.clear();
        // Progress lives in factory/, so starting over returns the learner to
        // the first lesson. Republish so the header agrees with the tutor.
        bus.publish({ type: "progress", progress: await loadProgress(options.workspace) });
      }
      bootstrap = { state: "active", hasSavedSession: false };
      persistenceUnsubscribe = bus.subscribe((event) => sessionLog.append(event));
      log.info(`Creating ${mode === "resume" ? "resumed" : "new"} tutor session; this may contact Pi's configured provider.`);
      // Resolved here rather than at startup so a session begun after several
      // lessons — or started over, which clears factory/ — routes to the lesson
      // the learner is actually on.
      adapter = await PiTutorialAdapter.create(options.lesson, options.workspace, bus, log, currentSpecPath(progress), progress.some((item) => item.state === "skipped"));
      publishBootstrap();
      void (mode === "resume" ? adapter.resume() : adapter.begin());
    })().catch((error) => {
      log.error("Tutorial session could not start", error);
      persistenceUnsubscribe?.();
      persistenceUnsubscribe = undefined;
      startPromise = undefined;
      bootstrap = { state: "select", hasSavedSession };
      runState = "failed";
      publishBootstrap();
      bus.publish({ type: "error", message: error instanceof Error ? error.message : "Tutorial session could not start.", retryable: true });
    });
    return startPromise;
  };

  const dispatch = (message: BrowserMessage): void => {
    if (message.type === "start-session") {
      if (bootstrap.state !== "select") return;
      void startSession(message.mode, message.mode === "fresh");
      return;
    }
    if (!adapter) {
      bus.publish({ type: "error", message: "Choose how to start the tutorial first.", retryable: true });
      return;
    }
    if (message.type === "chat") void adapter.chat(message.text, message.delivery);
    else if (message.type === "choose") {
      try { adapter.choose(message.choiceId, message.optionId); }
      catch (error) { bus.publish({ type: "error", message: error instanceof Error ? error.message : "Choice failed.", retryable: false }); }
    } else if (message.type === "abort") void adapter.abort();
    else if (message.type === "run-validation") void adapter.runValidation(message.commandId);
  };

  server = createServer(async (request, response) => {
    headers(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && isRoute(url.pathname, "events")) {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      writeEvent(response, { type: "snapshot", title: options.lesson.title, runState: adapter?.state ?? runState, activity: adapter?.activity ?? "waiting for Pi", events: [...bus.history()], validationCommands: options.lesson.validationCommands.map(({ id, label }) => ({ id, label })), progress, session: bootstrap });
      clients.add(response);
      log.info(`Browser connected to the event stream (${clients.size} client${clients.size === 1 ? "" : "s"}).`);
      const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 20_000);
      request.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(response);
        log.info(`Browser disconnected from the event stream (${clients.size} client${clients.size === 1 ? "" : "s"} remaining).`);
      });
      return;
    }
    if (request.method === "POST" && isRoute(url.pathname, "messages")) {
      try {
        const body = await readJson(request);
        if (!isBrowserMessage(body)) {
          log.info("Rejected an invalid browser message.");
          return sendJson(response, 400, { error: "Invalid browser message." });
        }
        const detail = body.type === "chat" ? `chat (${body.text.length} characters)` : body.type === "choose" ? `choice ${body.choiceId}/${body.optionId}` : body.type === "run-validation" ? `validation ${body.commandId}` : body.type === "start-session" ? `${body.mode} session` : "abort";
        log.info(`Browser requested ${detail}.`);
        dispatch(body);
        return sendJson(response, 202, { accepted: true });
      } catch (error) {
        log.error("Browser request failed", error);
        return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." });
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed." });

    const webRoot = resolve(options.webRoot);
    for (const requestPath of assetPaths(url.pathname)) {
      const candidate = resolve(webRoot, `.${requestPath}`);
      if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) return sendJson(response, 403, { error: "Forbidden." });
      try { await access(candidate); } catch { continue; }
      response.writeHead(200, { "Content-Type": MIME_TYPES[extname(candidate)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      if (request.method === "HEAD") response.end();
      else createReadStream(candidate).pipe(response);
      return;
    }
    // Vite's SPA entry supports refreshes on client routes without exposing the filesystem.
    // It needs an explicit Content-Type: with nosniff, a typeless response will not render.
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    if (request.method === "HEAD") response.end();
    else createReadStream(resolve(webRoot, "index.html")).pipe(response);
  });

  const unsubscribe = bus.subscribe((event) => {
    if (event.type === "run-state") runState = event.state;
    for (const client of clients) writeEvent(client, event);
  });
  server.on("error", (error) => log.error("Local HTTP server error", error));
  const port = options.port ?? 0;
  const host = options.host ?? LOOPBACK_HOST;
  log.info(`Binding local HTTP server to ${host}:${port || "an available port"}.`);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine tutorial server address.");
  // Always the loopback URL: it is what a browser on this machine should open,
  // whichever interface the server is bound to.
  const url = `http://${LOOPBACK_HOST}:${address.port}`;
  log.info(host === LOOPBACK_HOST
    ? `Listening only on ${url}.`
    : `Listening on ${url}, and on ${host}:${address.port} from other machines.`);
  if (hasSavedSession) log.info(`Saved tutorial session found at ${sessionLog.path}; waiting for learner choice.`);
  else log.info("No saved session; waiting for the learner to choose where to begin.");
  return {
    url,
    port: address.port,
    host,
    close: async () => {
      log.info("Closing tutor session and browser connections.");
      await startPromise;
      unsubscribe();
      persistenceUnsubscribe?.();
      adapter?.dispose();
      for (const client of clients) client.end();
      await sessionLog.flush();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  };
}
