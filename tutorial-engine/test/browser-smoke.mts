#!/usr/bin/env npx tsx
/**
 * Optional real-browser smoke. It serves the built local UI with a deterministic
 * SSE choice and proves that clicking it produces the shared POST request.
 */
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "../dist/web");
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function main(): Promise<void> {
  try { await access(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the UI first: npm run --workspace=tutorial-engine build:web"); }
  const moduleName = "playwright";
  let playwright: { chromium: { launch(): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Browser smoke is optional. Install its prerequisite with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  let resolveChoice!: (body: unknown) => void;
  const choiceRequest = new Promise<unknown>((resolveChoiceRequest) => { resolveChoice = resolveChoiceRequest; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      response.write(`data: ${JSON.stringify({ type: "snapshot", title: "Browser smoke", runState: "awaiting-choice", events: [], validationCommands: [], progress: [] })}\n\n`);
      response.write(`data: ${JSON.stringify({ type: "choice", id: "smoke-choice", question: "Choose a path", options: [{ id: "hands-on", label: "I’ll do it", icon: "do" }, { id: "delegate", label: "Make it for me", icon: "automate" }] })}\n\n`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/messages") {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => { resolveChoice(JSON.parse(body)); response.writeHead(202).end(); });
      return;
    }
    const candidate = resolve(webRoot, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!candidate.startsWith(webRoot)) { response.writeHead(403).end(); return; }
    response.writeHead(200, { "Content-Type": mime[extname(candidate)] ?? "application/octet-stream" });
    createReadStream(candidate).on("error", () => { response.writeHead(404).end(); }).pipe(response);
  });
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start browser smoke server.");
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "I’ll do it" }).click();
    const body = await Promise.race([choiceRequest, new Promise((_, reject) => setTimeout(() => reject(new Error("Browser did not post the choice request.")), 10_000))]);
    if (JSON.stringify(body) !== JSON.stringify({ type: "choose", choiceId: "smoke-choice", optionId: "hands-on" })) throw new Error(`Unexpected browser choice request: ${JSON.stringify(body)}`);
    console.log("Browser smoke passed: rendered an SSE choice and observed its POST request.");
  } finally {
    await browser.close();
    await new Promise<void>((resolveServer, reject) => server.close((error) => error ? reject(error) : resolveServer()));
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
