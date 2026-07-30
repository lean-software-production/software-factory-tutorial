import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { LessonDefinition } from "../lesson/contract.js";
import { TutorialEventBus } from "../protocol/event-bus.js";
import { isBrowserMessage, type BrowserMessage, type TutorialEvent } from "../protocol/events.js";
import { PiTutorialAdapter } from "../agent/pi-adapter.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2"
};
const MAX_BODY_BYTES = 16_384;

export interface LocalServerOptions {
  lesson: LessonDefinition;
  workspace: string;
  webRoot: string;
  port?: number;
}

export interface StartedServer {
  url: string;
  close(): Promise<void>;
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
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
}

export async function startLocalServer(options: LocalServerOptions): Promise<StartedServer> {
  await access(resolve(options.webRoot, "index.html"));
  const bus = new TutorialEventBus();
  const adapter = await PiTutorialAdapter.create(options.lesson, options.workspace, bus);
  const clients = new Set<ServerResponse>();
  let server: Server;

  const dispatch = (message: BrowserMessage): void => {
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
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      writeEvent(response, { type: "snapshot", title: options.lesson.title, runState: adapter.state, events: [...bus.history()], validationCommands: options.lesson.validationCommands.map(({ id, label }) => ({ id, label })) });
      clients.add(response);
      const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 20_000);
      request.on("close", () => { clearInterval(keepAlive); clients.delete(response); });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/messages") {
      try {
        const body = await readJson(request);
        if (!isBrowserMessage(body)) return sendJson(response, 400, { error: "Invalid browser message." });
        dispatch(body);
        return sendJson(response, 202, { accepted: true });
      } catch (error) {
        return sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request." });
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed." });

    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const webRoot = resolve(options.webRoot);
    const candidate = resolve(webRoot, `.${requestPath}`);
    if (candidate !== webRoot && !candidate.startsWith(webRoot + sep)) return sendJson(response, 403, { error: "Forbidden." });
    try {
      await access(candidate);
      response.writeHead(200, { "Content-Type": MIME_TYPES[extname(candidate)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      if (request.method === "HEAD") response.end();
      else createReadStream(candidate).pipe(response);
    } catch {
      // Vite's SPA entry supports refreshes on client routes without exposing the filesystem.
      createReadStream(resolve(options.webRoot, "index.html")).pipe(response);
    }
  });

  const unsubscribe = bus.subscribe((event) => {
    for (const client of clients) writeEvent(client, event);
  });
  const port = options.port ?? 0;
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolvePromise(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine tutorial server address.");
  void adapter.begin();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      unsubscribe();
      adapter.dispose();
      for (const client of clients) client.end();
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    }
  };
}
