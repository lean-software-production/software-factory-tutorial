#!/usr/bin/env npx tsx
/**
 * Optional real-browser smoke. It serves the built v2 workbook UI, drives the
 * browser through the current workbook API, and proves that lesson rendering and
 * continuation still work in Chromium.
 */
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "../dist/web-workbook");
const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

type PublicState = {
  workbook: { title: string };
  introduction: string;
  introductionComplete: boolean;
  chapters: Array<{ id: string; title: string; part: string; partMarkdown: string; partNumber: number; lessonNumber: number; lesson?: unknown }>;
  progress: { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: unknown[]; reflections: Record<string, string>; reflectionConversations: Record<string, unknown[]> };
  adapter: { modelBackedHelp: boolean; note: string };
};

const lesson = {
  id: "01-smoke/01-current-rendering",
  title: "Smoke lesson",
  dek: "A current v2 workbook lesson.",
  durationMinutes: 5,
  outcomes: ["Render current workbook blocks."],
  blocks: [
    { id: "orientation", type: "narrative", title: "Orientation", markdown: "Read the **v2 workbook** opening." },
    { id: "practice", type: "terminal-practice", title: "Practice", markdown: "Run this:\n\n```sh\necho smoke\n```" },
  ],
};

function state(stage: "intro" | "lesson" | "practice"): PublicState {
  const introductionComplete = stage !== "intro";
  const visibleLesson = introductionComplete ? lesson : undefined;
  return {
    workbook: { title: "Smoke workbook" },
    introduction: "Welcome to the v2 workbook smoke.",
    introductionComplete,
    chapters: [{ id: lesson.id, title: lesson.title, part: "Part 1 — Smoke", partMarkdown: "Part copy.", partNumber: 1, lessonNumber: 1, lesson: visibleLesson }],
    progress: {
      activeLessonId: lesson.id,
      activeBlockId: stage === "practice" ? "practice" : "orientation",
      completedLessons: [],
      blocks: stage === "practice"
        ? [
          { id: "orientation", type: "narrative", ready: true, active: false, completed: true, verified: false, emerged: true },
          { id: "practice", type: "terminal-practice", ready: true, active: true, completed: false, verified: false, emerged: true },
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

async function readJson(request: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<unknown> {
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
  catch { throw new Error("Browser smoke is optional. Install its prerequisite with `npm install --no-save -D playwright`, then `npx playwright install chromium`."); }

  let current: "intro" | "lesson" | "practice" = "intro";
  let resolveEvent!: (body: unknown) => void;
  const eventRequest = new Promise<unknown>((resolveEventRequest) => { resolveEvent = resolveEventRequest; });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/workbook/state") return sendJson(response, state(current));
    if (request.method === "POST" && url.pathname === "/api/workbook/introduction") { current = "lesson"; return sendJson(response, state(current)); }
    if (request.method === "POST" && url.pathname === "/api/workbook/events") {
      const body = await readJson(request);
      resolveEvent(body);
      current = "practice";
      return sendJson(response, state(current));
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
    await page.getByText("Embedded terminal", { exact: true }).waitFor();
    const body = await Promise.race([eventRequest, new Promise((_, reject) => setTimeout(() => reject(new Error("Browser did not post the workbook event request.")), 10_000))]);
    if (JSON.stringify(body) !== JSON.stringify({ blockId: "orientation", action: "continue" })) throw new Error(`Unexpected workbook event request: ${JSON.stringify(body)}`);
    console.log("Browser smoke passed: rendered the v2 workbook UI and observed /api/workbook/events.");
  } finally {
    await browser.close();
    await new Promise<void>((resolveServer, reject) => server.close((error) => error ? reject(error) : resolveServer()));
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
