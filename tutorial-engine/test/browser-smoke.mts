#!/usr/bin/env npx tsx
/**
 * Real-browser smoke. It serves the built v2 workbook UI, drives the
 * browser through the current workbook API, and proves that lesson rendering and
 * continuation still work in Chromium.
 */
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import type { PublicCompleteBlockResult, PublicWorkbookLesson, PublicWorkbookState } from "../src/workbook/public-contract.js";

const webRoot = resolve(import.meta.dirname, "../dist/web-workbook");
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const lesson: PublicWorkbookLesson = {
  id: "01-smoke/01-current-rendering",
  title: "Smoke lesson",
  dek: "A current v2 workbook lesson.",
  introduction: "This lesson opens with the current rendering contract.",
  durationMinutes: 5,
  outcomes: ["Render current workbook blocks."],
  blocks: [
    { id: "orientation", type: "narrative", title: "Orientation", markdown: "Read the **v2 workbook** opening." },
    { id: "practice", type: "terminal-practice", title: "Practice", markdown: "Run this:\n\n```sh\necho smoke\n```" },
  ],
};

function state(stage: "intro" | "lesson" | "practice" | "practice-feedback"): PublicWorkbookState {
  const introductionComplete = stage !== "intro";
  const visibleLesson = introductionComplete ? lesson : undefined;
  return {
    workbook: { title: "Smoke workbook" },
    introduction: "Welcome to the v2 workbook smoke.",
    introductionComplete,
    chapters: [{ id: lesson.id, title: lesson.title, part: "Part 1 — Smoke", partMarkdown: "Part copy.", partNumber: 1, lessonNumber: 1, lesson: visibleLesson }],
    progress: {
      activeLessonId: lesson.id,
      activeBlockId: stage === "practice" || stage === "practice-feedback" ? "practice" : "orientation",
      completedLessons: [],
      blocks: stage === "practice" || stage === "practice-feedback"
        ? [
          { id: "orientation", type: "narrative", ready: true, active: false, completed: true, verified: false, emerged: true },
          { id: "practice", type: "terminal-practice", ready: true, active: true, completed: false, verified: false, emerged: true, checkpoint: stage === "practice-feedback" ? { status: "feedback", feedback: "SSE review feedback." } : { status: "reviewing" } },
        ]
        : [{ id: "orientation", type: "narrative", ready: true, active: true, completed: false, verified: false, emerged: true }],
      reflections: {},
      reflectionConversations: {},
    },
    adapter: { modelBackedHelp: false, note: "Smoke server." },
  };
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function completed(stage: "lesson" | "practice", navigationTarget: string): Extract<PublicCompleteBlockResult, { outcome: "completed" }> {
  return { outcome: "completed", state: state(stage), navigationTarget };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body || "{}");
}

async function main(): Promise<void> {
  try { await access(resolve(webRoot, "index.html")); }
  catch { throw new Error("Build the workbook UI first: npm run --workspace=tutorial-engine build:web:workbook"); }
  const moduleName = "playwright";
  let playwright: { chromium: { launch(): Promise<any> } };
  try { playwright = await import(moduleName) as typeof playwright; }
  catch { throw new Error("Playwright is missing. Run `npm install`, then `npm run browser:install` from tutorial-engine."); }

  let current: "intro" | "lesson" | "practice" | "practice-feedback" = "intro";
  let stateRequests = 0;
  const sseClients = new Set<ServerResponse>();
  const sendSse = (response: ServerResponse, event: string, data: unknown): void => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const broadcastSse = (event: string, data: unknown): void => { for (const client of sseClients) sendSse(client, event, data); };
  let resolveContinuation!: (body: unknown) => void;
  const continuationRequest = new Promise<unknown>((resolveContinuationRequest) => { resolveContinuation = resolveContinuationRequest; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/workbook/state") { stateRequests += 1; return sendJson(response, state(current)); }
    if (request.method === "GET" && url.pathname === "/api/workbook/timeline") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      sseClients.add(response);
      sendSse(response, "timeline", []);
      request.on("close", () => sseClients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/workbook/introduction") { current = "lesson"; return sendJson(response, completed(current, "lesson--01-smoke/01-current-rendering")); }
    if (request.method === "POST" && url.pathname === "/api/workbook/complete-block") {
      const body = await readJson(request) as { blockId?: string };
      if (body.blockId === "workbook--introduction") { current = "lesson"; return sendJson(response, completed(current, "lesson--01-smoke/01-current-rendering")); }
      if (body.blockId === "orientation") {
        resolveContinuation(body);
        current = "practice";
        return sendJson(response, completed(current, "practice"));
      }
      response.writeHead(400).end(`Unexpected complete-block request: ${JSON.stringify(body)}`);
      return;
    }
    if (url.pathname.startsWith("/api/")) { response.writeHead(404).end(); return; }
    const candidate = resolve(webRoot, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!candidate.startsWith(webRoot)) { response.writeHead(403).end(); return; }
    try { await access(candidate); } catch { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": mime[extname(candidate)] ?? "application/octet-stream" });
    createReadStream(candidate).pipe(response);
  });
  await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start browser smoke server.");
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("heading", { name: "Smoke workbook" }).waitFor();
    await page.getByRole("button", { name: "Ready to continue" }).click();
    await page.getByRole("heading", { name: "Smoke lesson" }).waitFor();
    await page.getByRole("heading", { name: "What you will learn" }).waitFor();
    await page.getByRole("heading", { name: "Orientation" }).waitFor();
    await page.getByRole("button", { name: "Continue" }).click({ force: true });
    await page.getByRole("heading", { name: "Practice" }).waitFor();
    await page.locator('[aria-label="Terminal disconnected"]').waitFor();
    await page.getByText(/Checking/).waitFor();
    const stateRequestsBeforeIdle = stateRequests;
    await page.waitForTimeout(600);
    if (stateRequests !== stateRequestsBeforeIdle) throw new Error(`Browser made ${stateRequests - stateRequestsBeforeIdle} unexpected /api/workbook/state request(s) without SSE.`);
    current = "practice-feedback";
    broadcastSse("state", { blockId: "practice", revision: 1, status: "feedback" });
    await page.getByText("SSE review feedback.").waitFor();
    if (stateRequests !== stateRequestsBeforeIdle + 1) throw new Error(`Browser should fetch state once for SSE; saw ${stateRequests - stateRequestsBeforeIdle}.`);
    const body = await Promise.race([continuationRequest, new Promise((_, reject) => setTimeout(() => reject(new Error("Browser did not post the workbook continuation request.")), 10_000))]);
    if (JSON.stringify(body) !== JSON.stringify({ blockId: "orientation" })) throw new Error(`Unexpected workbook continuation request: ${JSON.stringify(body)}`);
    console.log("Browser smoke passed: rendered the v2 workbook UI and observed /api/workbook/complete-block.");
  } finally {
    await browser.close();
    await new Promise<void>((resolveServer, reject) => server.close((error) => error ? reject(error) : resolveServer()));
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
