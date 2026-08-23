import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import * as terminalModule from "../src/workbook/terminal.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tutorialStatePath } from "../src/tutorial-state.js";
import { startWorkbookServer } from "../src/workbook/server.js";
import type { TerminalPty, TerminalPtyFactory } from "../src/workbook/terminal.js";
import type { Attempt } from "../src/workbook/attempts.js";
import type { ActiveBlockContext } from "../src/workbook/pi-history.js";
import type { WorkbookBlockTutor } from "../src/workbook/block-tutor.js";
import type { MainTutorContext, MainWorkbookTutor, TutorDecision, TutorReview } from "../src/workbook/tutor.js";
import type { BlockTutorReadiness, TimelineMessage, WorkbookTimelineRecord } from "../src/workbook/timeline.js";

let dirs: string[] = [];

async function fixture(options: { editorPath?: string } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-server-")); dirs.push(dir);
  const first = resolve(dir, "lessons/001-first");
  const second = resolve(dir, "lessons/002-second");
  await mkdir(resolve(first, "blocks"), { recursive: true });
  await mkdir(resolve(second, "blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), [
    "---",
    "parts:",
    "  - id: loop",
    "    lessons:",
    "      - 001-first",
    "      - 002-second",
    "---",
    "# Fixture workbook",
    "",
    "Welcome to the fixture workbook.",
  ].join("\n"));
  await mkdir(resolve(dir, "parts"), { recursive: true });
  await writeFile(resolve(dir, "parts/loop.md"), ["---", "---", "# Part 1 — Loop", "", "Part copy."].join("\n"));
  await writeLesson(first, "First lesson", ["orientation", "edit-answer", "run-supplied-command", "change-job", "reflection", "transition"]);
  await writeBlock(first, "orientation", "narrative", "Orientation", "Start with the concept.");
  await writeBlock(first, "edit-answer", "editor-practice", "Edit", "Write the answer in the editor.", "Private editor rubric: mention the factory acceptance marker.", options.editorPath ?? "factory/answer.md");
  await writeBlock(first, "run-supplied-command", "terminal-practice", "Run", "Run the supplied command.", "Observe run result.");
  await writeBlock(first, "change-job", "terminal-practice", "Change", "Change the job and run again.", "Observe changed-job result.");
  await writeBlock(first, "reflection", "reflection", "Reflect", "Why did this count as headless?", "Ask about harness and job.");
  await writeBlock(first, "transition", "lesson-transition", "Finish", "Move to the next lesson.");
  await writeLesson(second, "Second lesson", ["second-orientation", "second-finish"]);
  await writeBlock(second, "second-orientation", "narrative", "Second orientation", "Second lesson starts here.");
  await writeBlock(second, "second-finish", "lesson-transition", "Second finish", "Second lesson done.");
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
}

async function writeLesson(lessonDir: string, title: string, blocks: string[]) {
  await writeFile(resolve(lessonDir, "lesson.md"), [
    "---",
    "durationMinutes: 10",
    "outcomes:",
    "  - Fixture outcome.",
    "blocks:",
    ...blocks.map((id) => `  - ${id}`),
    "---",
    `# ${title}`,
    "",
    `${title} dek.`,
  ].join("\n"));
}

async function writeBlock(lessonDir: string, id: string, type: string, title: string, markdown: string, tutor?: string, path?: string) {
  await writeFile(resolve(lessonDir, `blocks/${id}.md`), [
    "---",
    `type: ${type}`,
    ...(path ? [`path: ${JSON.stringify(path)}`] : []),
    ...(tutor ? [`tutor: ${JSON.stringify(tutor)}`] : []),
    "---",
    `## ${title}`,
    "",
    markdown,
  ].join("\n"));
}

class ServerFakePty implements TerminalPty {
  writes: string[] = [];
  data?: (data: string) => void;
  exit?: (event: { exitCode: number }) => void;
  write(data: string): void { this.writes.push(data); this.data?.(`\r\nran:${data}`); }
  resize(): void {}
  kill(): void {}
  onData(callback: (data: string) => void): void { this.data = callback; }
  onExit(callback: (event: { exitCode: number }) => void): void { this.exit = callback; }
}

type QueuedDecision = TutorDecision | Error | Promise<TutorDecision> | ((review: MainTutorContext & TutorReview & { readiness?: BlockTutorReadiness }) => TutorDecision | Promise<TutorDecision>);
type QueuedReadiness = Awaited<ReturnType<WorkbookBlockTutor["assess"]>> | Error | Promise<Awaited<ReturnType<WorkbookBlockTutor["assess"]>>>;

class FakeMainTutor implements MainWorkbookTutor {
  reviews: Array<MainTutorContext & TutorReview & { readiness?: BlockTutorReadiness }> = [];
  restores: MainTutorContext[] = [];
  replies: Array<MainTutorContext & { learnerMessage: TimelineMessage }> = [];
  briefings: Array<MainTutorContext & { lessonId: string; blockId: string }> = [];
  blockSummaries: Array<MainTutorContext & { lessonId: string; blockId: string; coveredThroughId: string }> = [];
  lessonSummaries: Array<MainTutorContext & { lessonId: string; coveredThroughId: string }> = [];
  disposed = false;
  queue: QueuedDecision[] = [];
  replyQueue: Array<string | Error | Promise<string>> = [];
  briefingQueue: Array<string | Error | Promise<string>> = [];
  constructor(...queue: QueuedDecision[]) { this.queue = queue; }
  async restore(input: MainTutorContext): Promise<void> { this.restores.push(input); }
  async reply(input: MainTutorContext & { learnerMessage: TimelineMessage }): Promise<string> {
    this.replies.push(input);
    const next = this.replyQueue.shift() ?? "Try the workspace-relative path.";
    if (next instanceof Error) throw next;
    return next;
  }
  async prepareBlockBriefing(input: MainTutorContext & { lessonId: string; blockId: string }): Promise<string> {
    this.briefings.push(input);
    const next = this.briefingQueue.shift() ?? `Private briefing for ${input.blockId}.`;
    if (next instanceof Error) throw next;
    return next;
  }
  async review(input: MainTutorContext & TutorReview & { readiness?: BlockTutorReadiness }): Promise<TutorDecision> {
    this.reviews.push(input);
    const next = this.queue.shift() ?? { outcome: "feedback", message: "Keep going." };
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(input) : next;
  }
  async summarizeBlock(input: MainTutorContext & { lessonId: string; blockId: string; coveredThroughId: string }): Promise<string> {
    this.blockSummaries.push(input);
    return `Summary of ${input.blockId}.`;
  }
  async summarizeLesson(input: MainTutorContext & { lessonId: string; coveredThroughId: string }): Promise<string> {
    this.lessonSummaries.push(input);
    return `Summary of ${input.lessonId}.`;
  }
  dispose(): void { this.disposed = true; }
}

class FakeBlockTutor implements WorkbookBlockTutor {
  hints: Array<{ context: ActiveBlockContext; briefing: string }> = [];
  assessments: Array<{ context: ActiveBlockContext; attempt: Attempt }> = [];
  hintQueue: Array<string | Error | Promise<string>> = [];
  readinessQueue: QueuedReadiness[] = [];
  async hint(input: { context: ActiveBlockContext; briefing: string }): Promise<string> {
    this.hints.push(input);
    const next = this.hintQueue.shift() ?? "Look at the current draft and compare it with the block goal.";
    if (next instanceof Error) throw next;
    return next;
  }
  async assess(input: { context: ActiveBlockContext; attempt: Attempt }): Promise<{ readiness: "likely_ready" | "still_working"; text: string }> {
    this.assessments.push(input);
    const next = this.readinessQueue.shift() ?? { readiness: "still_working" as const, text: "The attempt still needs main-tutor judgment." };
    if (next instanceof Error) throw next;
    return next;
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function connect(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/api/workbook/terminal", origin ? { headers: { Origin: origin } } : undefined);
    ws.once("open", () => resolvePromise(ws));
    ws.once("error", reject);
  });
}

function waitFor(ws: WebSocket, predicate: (message: any) => boolean): Promise<any> {
  return new Promise((resolvePromise) => {
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (predicate(message)) resolvePromise(message);
    });
  });
}

async function postEvent(serverUrl: string, body: unknown) {
  return fetch(`${serverUrl}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postEditor(serverUrl: string, body: unknown) {
  return fetch(`${serverUrl}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postMessage(serverUrl: string, body: unknown) {
  return fetch(`${serverUrl}/api/workbook/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function postHint(serverUrl: string, body: unknown) {
  return fetch(`${serverUrl}/api/workbook/hints`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function state(serverUrl: string) { return fetch(`${serverUrl}/api/workbook/state`).then((r) => r.json() as any); }
async function timelineSnapshot(serverUrl: string): Promise<any[]> {
  const controller = new AbortController();
  const response = await fetch(`${serverUrl}/api/workbook/timeline`, { signal: controller.signal });
  if (!response.body) throw new Error("Timeline stream did not expose a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    controller.abort();
  }
  const match = text.match(/event: timeline\ndata: (.*)\n\n/s);
  if (!match) throw new Error(`Timeline stream did not include an initial event: ${text}`);
  return JSON.parse(match[1]);
}
async function privateTimeline(workspace: string): Promise<WorkbookTimelineRecord[]> {
  const text = await readFile(tutorialStatePath(workspace, "workbook", "events.jsonl"), "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as WorkbookTimelineRecord);
}
async function introduceAndOpenEditor(serverUrl: string) {
  await fetch(`${serverUrl}/api/workbook/introduction`, { method: "POST" });
  await postEvent(serverUrl, { blockId: "orientation", action: "continue" });
}
async function waitMs(ms: number) { await new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
async function waitForWorkbookState(serverUrl: string, predicate: (state: any) => boolean, description: string) {
  const deadline = Date.now() + 1_500;
  let latest: any;
  while (Date.now() < deadline) {
    latest = await state(serverUrl);
    if (predicate(latest)) return latest;
    await waitMs(10);
  }
  throw new Error(`Timed out waiting for ${description}. Last state: ${JSON.stringify(latest)}`);
}
function block(state: any, blockId: string) { return state.progress.blocks.find((candidate: any) => candidate.id === blockId); }

async function acceptEditor(serverUrl: string, tutor: FakeMainTutor, text = "factory acceptance marker") {
  tutor.queue.push({ outcome: "accepted", message: "Editor accepted." });
  expect((await postEditor(serverUrl, { blockId: "edit-answer", text })).status).toBe(202);
  await waitForWorkbookState(serverUrl, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "editor acceptance");
  expect((await postEvent(serverUrl, { blockId: "edit-answer", action: "continue" })).status).toBe(202);
}

async function submitTerminalAttempt(serverUrl: string, blockId: string) {
  const ws = await connect(serverUrl, serverUrl);
  const submitted = waitFor(ws, (message) => message.type === "attempt-status" && message.blockId === blockId && message.status === "submitted");
  ws.send(JSON.stringify({ type: "input", data: `run ${blockId}\r` }));
  await submitted;
  ws.close();
}

let originalOpenCodeApiKey: string | undefined;
beforeEach(() => {
  originalOpenCodeApiKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "test-opencode-key";
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalOpenCodeApiKey;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("workbook browser API", () => {
  it("opens the introduction as durable tutor conversation before any real block is active", async () => {
    const dir = await fixture();
    const firstTutor = new FakeMainTutor();
    firstTutor.replyQueue.push(new Error("intro provider secret"));
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: firstTutor, blockTutor: new FakeBlockTutor() });
    let persistedTimeline: any[];
    try {
      const initial = await state(firstServer.url);
      expect(initial.introductionComplete).toBe(false);
      expect(initial.timeline.filter((record: any) => record.type === "message")).toEqual([
        expect.objectContaining({ lessonId: "workbook:introduction", blockId: "__introduction__", role: "assistant", source: "authored", presentation: "course", text: expect.stringContaining("# Fixture workbook") })
      ]);
      expect(initial.timeline[0].text).toContain("Welcome to the fixture workbook.");
      expect((await postHint(firstServer.url, { blockId: "__introduction__" })).status).toBe(409);
      expect((await postEditor(firstServer.url, { blockId: "edit-answer", text: "too soon" })).status).toBe(409);

      const response = await postMessage(firstServer.url, { blockId: "__introduction__", text: "Can I ask before we start?" });
      expect(response.status).toBe(202);
      const chatted = await response.json() as any;
      expect(chatted.introductionComplete).toBe(false);
      expect(firstTutor.replies).toHaveLength(1);
      expect(firstTutor.replies[0]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook:introduction", blockId: "__introduction__", text: "Can I ask before we start?" } });
      expect(chatted.timeline.slice(-2)).toEqual([
        expect.objectContaining({ lessonId: "workbook:introduction", blockId: "__introduction__", role: "user", source: "learner", presentation: "chat", text: "Can I ask before we start?" }),
        expect.objectContaining({ lessonId: "workbook:introduction", blockId: "__introduction__", type: "tutor_failed", operation: "reply" }),
      ]);
      expect(JSON.stringify(chatted.timeline)).not.toContain("intro provider secret");
      const retryFailure = chatted.timeline.at(-1);
      const retried = await fetch(`${firstServer.url}/api/workbook/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failureId: retryFailure.failureId }) }).then((retry) => retry.json() as any);
      expect(firstTutor.replies).toHaveLength(2);
      expect(firstTutor.replies[1]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook:introduction", blockId: "__introduction__", text: "Can I ask before we start?" } });
      expect(retried.timeline.at(-1)).toMatchObject({ lessonId: "workbook:introduction", blockId: "__introduction__", role: "assistant", source: "main_tutor", presentation: "chat", text: "Try the workspace-relative path." });
      persistedTimeline = retried.timeline;
    } finally { await firstServer.close(); }

    const secondTutor = new FakeMainTutor();
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: secondTutor, blockTutor: new FakeBlockTutor() });
    try {
      const restored = await state(secondServer.url);
      expect(restored.timeline).toEqual(persistedTimeline!);
      expect(restored.introductionComplete).toBe(false);
      expect(secondTutor.restores).toHaveLength(1);
      expect(secondTutor.restores[0].activeContext).toBeUndefined();
      expect(secondTutor.restores[0].records.filter((record) => record.type === "message")).toEqual(persistedTimeline!.filter((record) => record.type === "message"));
      expect((await postMessage(secondServer.url, { blockId: "__introduction__", text: "Still before the first block?" })).status).toBe(202);
    } finally { await secondServer.close(); }
  });

  it("retries a failed intro reply without adopting the newly active block context after continue", async () => {
    const dir = await fixture();
    const tutor = new FakeMainTutor();
    tutor.replyQueue.push(new Error("intro provider failed once"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      const failed = await postMessage(server.url, { blockId: "__introduction__", text: "Question before the first lesson." }).then((response) => response.json() as any);
      const failure = failed.timeline.at(-1);
      expect(failure).toMatchObject({ type: "tutor_failed", lessonId: "workbook:introduction", blockId: "__introduction__", operation: "reply" });

      const opened = await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      expect(opened.progress.activeBlockId).toBe("orientation");
      expect((await fetch(`${server.url}/api/workbook/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failureId: failure.failureId }) })).status).toBe(202);

      expect(tutor.replies).toHaveLength(2);
      expect(tutor.replies[0]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook:introduction", blockId: "__introduction__" } });
      expect(tutor.replies[1]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook:introduction", blockId: "__introduction__" } });
      const retriedTimeline = (await state(server.url)).timeline;
      expect(retriedTimeline.at(-1)).toMatchObject({ type: "message", lessonId: "workbook:introduction", blockId: "__introduction__", source: "main_tutor", text: "Try the workspace-relative path." });
    } finally { await server.close(); }
  });

  it("backfills legacy completed-introduction openings without adding a late introduction note", async () => {
    const dir = await fixture();
    await mkdir(resolve(dir, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(tutorialStatePath(dir, "workbook", "events.jsonl"), [
      JSON.stringify({ id: "legacy-session", sequence: 1, at: "2026-08-21T00:00:00.000Z", type: "session_started" }),
      JSON.stringify({ id: "legacy-intro-complete", sequence: 2, at: "2026-08-21T00:00:01.000Z", type: "workbook_introduction_completed" }),
      ""
    ].join("\n"));

    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    let authored: any[];
    try {
      const recovered = await state(firstServer.url);
      authored = recovered.timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(authored.map((record: any) => [record.lessonId, record.blockId])).toEqual([
        ["workbook:part:loop", "__part__"],
        ["001-first", "__lesson_frame__"],
        ["001-first", "orientation"],
      ]);
      expect(JSON.stringify(recovered.timeline)).not.toContain("workbook:introduction");
      expect(recovered.timeline.find((record: any) => record.type === "message" && record.blockId === "__introduction__")).toBeUndefined();
    } finally { await firstServer.close(); }

    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    try {
      const restoredAuthored = (await state(secondServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(restoredAuthored).toEqual(authored!);
    } finally { await secondServer.close(); }
  });

  it("projects missing legacy frames before an already-authored active block without rewriting append order", async () => {
    const dir = await fixture();
    await mkdir(resolve(dir, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(tutorialStatePath(dir, "workbook", "events.jsonl"), [
      JSON.stringify({ id: "legacy-session", sequence: 1, at: "2026-08-21T00:00:00.000Z", type: "session_started" }),
      JSON.stringify({ id: "legacy-intro-complete", sequence: 2, at: "2026-08-21T00:00:01.000Z", type: "workbook_introduction_completed" }),
      JSON.stringify({ id: "legacy-active-block", sequence: 3, at: "2026-08-21T00:00:02.000Z", type: "message", lessonId: "001-first", blockId: "orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nStart with the concept." }),
      ""
    ].join("\n"));

    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    let projectedAuthored: any[];
    try {
      projectedAuthored = (await state(firstServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(projectedAuthored.map((record: any) => [record.id, record.lessonId, record.blockId])).toEqual([
        [expect.any(String), "workbook:part:loop", "__part__"],
        [expect.any(String), "001-first", "__lesson_frame__"],
        ["legacy-active-block", "001-first", "orientation"],
      ]);
      const canonicalLog = (await privateTimeline(dir)).filter((record) => record.type === "message" && record.source === "authored");
      expect(canonicalLog.map((record: any) => [record.id, record.lessonId, record.blockId])).toEqual([
        ["legacy-active-block", "001-first", "orientation"],
        [expect.any(String), "workbook:part:loop", "__part__"],
        [expect.any(String), "001-first", "__lesson_frame__"],
      ]);
    } finally { await firstServer.close(); }

    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    try {
      const restoredAuthored = (await state(secondServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(restoredAuthored).toEqual(projectedAuthored!);
    } finally { await secondServer.close(); }
  });

  it("continues the introduction by recording part, lesson frame, and first block authored messages once", async () => {
    const dir = await fixture();
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    let authoredAfterContinue: any[];
    try {
      const opened = await fetch(`${firstServer.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      authoredAfterContinue = opened.timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(authoredAfterContinue.map((record: any) => [record.lessonId, record.blockId])).toEqual([
        ["workbook:introduction", "__introduction__"],
        ["workbook:part:loop", "__part__"],
        ["001-first", "__lesson_frame__"],
        ["001-first", "orientation"],
      ]);
      expect(authoredAfterContinue[1].text).toContain("# Part 1 — Loop");
      expect(authoredAfterContinue[1].text).toContain("Part copy.");
      expect(authoredAfterContinue[2].text).toContain("# First lesson");
      expect(authoredAfterContinue[2].text).toContain("First lesson dek.");
      expect(authoredAfterContinue[2].text).toContain("- Fixture outcome.");
      expect(authoredAfterContinue[3].text).toContain("## Orientation");
      expect(opened.progress.activeBlockId).toBe("orientation");
      expect(JSON.stringify(opened.timeline)).not.toContain("Private editor rubric");
    } finally { await firstServer.close(); }

    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    try {
      const restoredAuthored = (await state(secondServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(restoredAuthored).toEqual(authoredAfterContinue!);
    } finally { await secondServer.close(); }
  });

  it("serves content without private tutor data and rejects inactive actions", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    try {
      const initial = await state(server.url);
      expect(initial.chapters.map((chapter: any) => [chapter.id, chapter.lesson])).toEqual([["001-first", undefined], ["002-second", undefined]]);
      expect((await postEvent(server.url, { blockId: "orientation", action: "continue" })).status).toBe(409);
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "too soon" })).status).toBe(409);
      expect((await postEvent(server.url, { blockId: "change-job", action: "continue" })).status).toBe(409);
      const opened = await postEvent(server.url, { blockId: "orientation", action: "continue" }).then((response) => response.json() as any);
      expect(opened.progress.activeBlockId).toBe("edit-answer");
      expect(JSON.stringify(opened)).not.toContain("Private editor rubric");
      expect(JSON.stringify(opened)).not.toContain("Observe run result");
    } finally { await server.close(); }
  });

  it("briefs the block tutor privately before exposing an active editor block", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor();
    mainTutor.briefingQueue.push("Use the private editor rubric without quoting it.");
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor: new FakeBlockTutor() });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      const opened = await postEvent(server.url, { blockId: "orientation", action: "continue" }).then((response) => response.json() as any);
      expect(opened.progress.activeBlockId).toBe("edit-answer");
      const records = await privateTimeline(dir);
      const briefing = records.find((record) => record.type === "block_tutor_briefed" && record.blockId === "edit-answer");
      const authored = records.find((record) => record.type === "message" && record.source === "authored" && record.blockId === "edit-answer");
      expect(authored).toBeTruthy();
      expect(briefing).toMatchObject({ type: "block_tutor_briefed", lessonId: "001-first", blockId: "edit-answer", text: "Use the private editor rubric without quoting it.", coveredThroughId: authored?.id });
      expect(mainTutor.briefings[0]).toMatchObject({ lessonId: "001-first", blockId: "edit-answer", activeContext: { title: "Edit", markdown: "Write the answer in the editor.", authorGuidance: "Private editor rubric: mention the factory acceptance marker.", attempts: [] } });
      expect(JSON.stringify(opened)).not.toContain("Private editor rubric");
      expect(JSON.stringify(opened)).not.toContain("Use the private editor rubric");
    } finally { await server.close(); }
  });

  it("returns block-tutor hints from the stored briefing and latest active evidence", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "working" });
    mainTutor.briefingQueue.push("Stored private editor briefing.");
    const blockTutor = new FakeBlockTutor();
    blockTutor.hintQueue.push("Compare the draft with the marker the block asks for.");
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "latest draft evidence" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => blockTutor.assessments.length === 1 && mainTutor.reviews.length === 1, "automatic review recorded");
      const response = await postHint(server.url, { blockId: "edit-answer" });
      expect(response.status).toBe(202);
      const hinted = await response.json() as any;
      expect(blockTutor.hints).toHaveLength(1);
      expect(blockTutor.hints[0]).toMatchObject({ briefing: "Stored private editor briefing.", context: { blockId: "edit-answer", attempts: [{ evidence: { kind: "editor", text: "latest draft evidence" } }] } });
      const hintMessages = hinted.timeline.filter((record: any) => record.type === "message" && record.source === "block_tutor" && record.presentation === "hint");
      expect(hintMessages).toEqual([expect.objectContaining({ role: "assistant", text: "Compare the draft with the marker the block asks for." })]);
      expect(JSON.stringify(hinted)).not.toContain("Stored private editor briefing");
      expect(JSON.stringify(hinted)).not.toContain("Private editor rubric");
      expect(JSON.stringify(hinted)).not.toContain("still_working");
    } finally { await server.close(); }
  });

  it("rejects block-tutor hints outside the active terminal or editor block", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const mainTutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      { outcome: "accepted", message: "First terminal accepted." },
      { outcome: "accepted", message: "Second terminal accepted." }
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, mainTutor, blockTutor: new FakeBlockTutor() });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      expect((await postHint(server.url, { blockId: "orientation" })).status).toBe(409);
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      expect((await postHint(server.url, { blockId: "run-supplied-command" })).status).toBe(409);
      await acceptEditor(server.url, mainTutor);
      await submitTerminalAttempt(server.url, "run-supplied-command");
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "first terminal accepted for hint rejection");
      await postEvent(server.url, { blockId: "run-supplied-command", action: "continue" });
      await submitTerminalAttempt(server.url, "change-job");
      await waitForWorkbookState(server.url, (next) => block(next, "change-job")?.checkpoint?.status === "accepted", "second terminal accepted for hint rejection");
      await postEvent(server.url, { blockId: "change-job", action: "continue" });
      expect((await postHint(server.url, { blockId: "reflection" })).status).toBe(409);
    } finally { await server.close(); }
  });

  it("rejects legacy unexpected-output and help event actions on an active terminal block and appends no record", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, mainTutor);
      const activeState = await state(server.url);
      expect(block(activeState, "run-supplied-command")?.active).toBe(true);
      const before = await privateTimeline(dir);

      const unexpectedResponse = await postEvent(server.url, { blockId: "run-supplied-command", action: "unexpected", evidence: "command not found" });
      expect(unexpectedResponse.status).toBe(400);

      const helpResponse = await postEvent(server.url, { blockId: "run-supplied-command", action: "help", request: "I'm stuck" });
      expect(helpResponse.status).toBe(400);

      const after = await privateTimeline(dir);
      expect(after).toEqual(before);
    } finally { await server.close(); }
  });

  it("keeps an incomplete attempt quietly working without a visible review message when the main tutor says working", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "working" });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "unfinished" })).status).toBe(202);
      const working = await waitForWorkbookState(server.url, (next) => mainTutor.reviews.length === 1 && block(next, "edit-answer")?.checkpoint?.status === "working", "quiet working review");
      expect(block(working, "edit-answer")?.checkpoint?.status).toBe("working");
      expect(working.timeline.filter((record: any) => record.type === "message" && record.source === "main_tutor" && record.presentation === "review")).toEqual([]);
    } finally { await server.close(); }
  });

  it("accepts or feeds back only from the main tutor despite block-tutor readiness", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "feedback", message: "Add the exact marker before this can continue." });
    const blockTutor = new FakeBlockTutor();
    blockTutor.readinessQueue.push({ readiness: "likely_ready", text: "This looks ready for main review." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "almost" })).status).toBe(202);
      const feedback = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "feedback", "main tutor feedback after likely ready");
      expect(mainTutor.reviews[0].readiness).toMatchObject({ readiness: "likely_ready", text: "This looks ready for main review." });
      expect(block(feedback, "edit-answer")?.checkpoint?.feedback).toBe("Add the exact marker before this can continue.");
      expect(feedback.timeline.some((record: any) => record.type === "attempt_accepted")).toBe(false);
    } finally { await server.close(); }
  });

  it("still asks the main tutor to review when block-tutor readiness fails", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "feedback", message: "Main tutor can still judge this draft." });
    const blockTutor = new FakeBlockTutor();
    blockTutor.readinessQueue.push(new Error("invalid readiness payload"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "almost" })).status).toBe(202);
      const feedback = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "feedback" && mainTutor.reviews.length === 1, "main review after readiness failure");
      expect(mainTutor.reviews[0].readiness).toBeUndefined();
      expect(block(feedback, "edit-answer")?.checkpoint?.feedback).toBe("Main tutor can still judge this draft.");
      expect(feedback.timeline.filter((record: any) => record.type === "tutor_failed" && record.operation === "readiness")).toHaveLength(1);
    } finally { await server.close(); }
  });

  it("sanitizes retryable public failures so raw attempt ids never appear in state or timeline", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor(new Error("model provider down"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "draft that triggers a review failure" })).status).toBe(202);
      const failedState = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "feedback" && next.timeline.some((record: any) => record.type === "tutor_failed" && record.operation === "review"), "review failure");
      const privateFailure = (await privateTimeline(dir)).find((record): record is Extract<WorkbookTimelineRecord, { type: "tutor_failed" }> => record.type === "tutor_failed" && record.operation === "review");
      expect(privateFailure).toBeTruthy();
      expect(privateFailure!.requestId).toMatch(/[0-9a-f-]{36}/);

      const publicFailure = failedState.timeline.find((record: any) => record.type === "tutor_failed" && record.operation === "review");
      expect(publicFailure).toMatchObject({ type: "tutor_failed", operation: "review", failureId: privateFailure!.id });
      expect(publicFailure).not.toHaveProperty("requestId");
      expect(JSON.stringify(failedState)).not.toContain(privateFailure!.requestId);

      const publicTimeline = await timelineSnapshot(server.url);
      expect(JSON.stringify(publicTimeline)).not.toContain(privateFailure!.requestId);
      expect(publicTimeline.find((record: any) => record.type === "tutor_failed" && record.operation === "review")).toMatchObject({ failureId: privateFailure!.id });

      const retry = await fetch(`${server.url}/api/workbook/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failureId: publicFailure.failureId }) });
      expect(retry.status).toBe(202);
    } finally { await server.close(); }
  });

  it("records retryable public failures for blank main replies and blank block hints", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor();
    mainTutor.replyQueue.push("   ");
    const blockTutor = new FakeBlockTutor();
    blockTutor.hintQueue.push("\n\t");
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor, blockTutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postMessage(server.url, { blockId: "edit-answer", text: "Can I get help?" })).status).toBe(202);
      const afterBlankReply = await state(server.url);
      expect(afterBlankReply.timeline.at(-1)).toMatchObject({ type: "tutor_failed", operation: "reply" });
      expect(afterBlankReply.timeline.filter((record: any) => record.type === "message" && record.source === "main_tutor" && record.text.trim() === "")).toEqual([]);

      expect((await postHint(server.url, { blockId: "edit-answer" })).status).toBe(202);
      const afterBlankHint = await state(server.url);
      expect(afterBlankHint.timeline.at(-1)).toMatchObject({ type: "tutor_failed", operation: "hint" });
      expect(afterBlankHint.timeline.filter((record: any) => record.type === "message" && record.source === "block_tutor")).toEqual([]);
    } finally { await server.close(); }
  });

  it("restores active context and reuses the latest stored briefing for hints after restart", async () => {
    const dir = await fixture();
    const never = deferred<TutorDecision>();
    const firstMainTutor = new FakeMainTutor(never.promise);
    firstMainTutor.briefingQueue.push("Persisted private briefing.");
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: firstMainTutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(firstServer.url);
      expect((await postEditor(firstServer.url, { blockId: "edit-answer", text: "draft before restart" })).status).toBe(202);
      await waitForWorkbookState(firstServer.url, () => firstMainTutor.reviews.length === 1, "first active attempt queued");
    } finally { await firstServer.close(); }

    const secondMainTutor = new FakeMainTutor({ outcome: "working" });
    const secondBlockTutor = new FakeBlockTutor();
    secondBlockTutor.hintQueue.push("Use the saved draft as your next comparison point.");
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: secondMainTutor, blockTutor: secondBlockTutor });
    try {
      await waitForWorkbookState(secondServer.url, () => secondMainTutor.restores.length === 1 && secondMainTutor.reviews.length === 1, "restored active attempt requeued");
      expect(secondMainTutor.restores[0].activeContext).toMatchObject({ blockId: "edit-answer", attempts: [{ evidence: { kind: "editor", text: "draft before restart" } }] });
      expect((await postHint(secondServer.url, { blockId: "edit-answer" })).status).toBe(202);
      expect(secondBlockTutor.hints[0]).toMatchObject({ briefing: "Persisted private briefing.", context: { blockId: "edit-answer", attempts: [{ evidence: { kind: "editor", text: "draft before restart" } }] } });
      const visible = await state(secondServer.url);
      expect(JSON.stringify(visible)).not.toContain("Persisted private briefing");
      expect(JSON.stringify(visible)).not.toContain("Private editor rubric");
    } finally { await secondServer.close(); }
  });

  it("records the first active authored block once and restores it after restart", async () => {
    const dir = await fixture();
    const firstTutor = new FakeMainTutor();
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: firstTutor, blockTutor: new FakeBlockTutor() });
    let persisted: any[];
    try {
      const opened = await fetch(`${firstServer.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      const authored = opened.timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(authored.filter((record: any) => record.lessonId === "001-first" && record.blockId === "orientation")).toHaveLength(1);
      expect(authored.at(-1)).toMatchObject({ blockId: "orientation", presentation: "course", text: expect.stringContaining("## Orientation") });
      expect(JSON.stringify(opened.timeline)).not.toContain("Private editor rubric");
      persisted = (await state(firstServer.url)).timeline;
      expect((await state(firstServer.url)).timeline).toEqual(persisted);
    } finally { await firstServer.close(); }

    const secondTutor = new FakeMainTutor();
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: secondTutor, blockTutor: new FakeBlockTutor() });
    try {
      expect((await state(secondServer.url)).timeline).toEqual(persisted!);
      expect(secondTutor.restores).toHaveLength(1);
      expect(secondTutor.restores[0].records.filter((record) => record.type === "message" || record.type === "tutor_failed")).toEqual(persisted!);
    } finally { await secondServer.close(); }
  });

  it("persists learner chat before its tutor reply without private guidance", async () => {
    const dir = await fixture();
    const tutor = new FakeMainTutor();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      const response = await postMessage(server.url, { blockId: "edit-answer", text: "Which path should I use?" });
      expect(response.status).toBe(202);
      const messages = (await state(server.url)).timeline.filter((record: any) => record.type === "message");
      expect(messages.slice(-2).map((record: any) => [record.role, record.source, record.text])).toEqual([
        ["user", "learner", "Which path should I use?"],
        ["assistant", "main_tutor", "Try the workspace-relative path."],
      ]);
      expect(JSON.stringify(messages)).not.toContain("Private editor rubric");
    } finally { await server.close(); }
  });

  it("records a public retryable failure instead of provider feedback when chat fails", async () => {
    const dir = await fixture();
    const tutor = new FakeMainTutor();
    tutor.replyQueue.push(new Error("provider secret failure"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postMessage(server.url, { blockId: "edit-answer", text: "Which path?" })).status).toBe(202);
      const timeline = (await state(server.url)).timeline;
      const failed = timeline.at(-1);
      expect(failed).toMatchObject({ type: "tutor_failed", operation: "reply" });
      expect(JSON.stringify(timeline)).not.toContain("provider secret failure");
      expect(failed.publicMessage).toBe("The tutor is temporarily unavailable. Please retry.");
      const publicTimelineFailure = timeline.find((record: any) => record.type === "tutor_failed" && record.operation === "reply");
      expect(publicTimelineFailure).not.toHaveProperty("requestId");
    } finally { await server.close(); }
  });

  it("creates a reviewing editor attempt, promotes only after tutor acceptance, and continues generically", async () => {
    const dir = await fixture();
    const accepted = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(accepted.promise);
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      const submitted = await postEditor(server.url, { blockId: "edit-answer", text: "factory acceptance marker" }).then((response) => response.json() as any);
      expect(block(submitted, "edit-answer")).toMatchObject({ active: true, draftText: "factory acceptance marker", checkpoint: { status: "reviewing" } });
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 1, "editor review queued");
      expect(tutor.reviews[0]).toMatchObject({ privateGuidance: expect.stringContaining("Private editor rubric"), attempt: { evidence: { kind: "editor", text: "factory acceptance marker" } } });
      expect(JSON.stringify(submitted)).not.toContain("Private editor rubric");
      await expect(access(resolve(dir, "factory/answer.md"))).rejects.toThrow();
      expect((await postEvent(server.url, { blockId: "edit-answer", action: "continue" })).status).toBe(409);

      accepted.resolve({ outcome: "accepted", message: "Ready to continue." });
      const acceptedState = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "accepted editor checkpoint");
      expect(acceptedState.progress.activeBlockId).toBe("edit-answer");
      expect(block(acceptedState, "edit-answer")).toMatchObject({ active: true, completed: false, checkpoint: { status: "accepted", successMessage: "Ready to continue.", evidence: { kind: "editor", text: "factory acceptance marker" } } });
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).resolves.toBe("factory acceptance marker");
      const continued = await postEvent(server.url, { blockId: "edit-answer", action: "continue" }).then((response) => response.json() as any);
      expect(continued.progress.activeBlockId).toBe("run-supplied-command");
      await waitForWorkbookState(server.url, () => tutor.blockSummaries.some((summary) => summary.blockId === "edit-answer"), "queued block summary");
      const privateRecords = await privateTimeline(dir);
      const publicState = await state(server.url);
      expect(privateRecords).toContainEqual(expect.objectContaining({
        type: "block_summarized", lessonId: "001-first", blockId: "edit-answer"
      }));
      expect(publicState.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "message", source: "authored", blockId: "edit-answer" }),
        expect.objectContaining({ type: "message", source: "main_tutor" })
      ]));
      expect(publicState.timeline.some((record: any) => record.type === "block_summarized")).toBe(false);
      expect(JSON.stringify(continued)).not.toContain("attemptId");
      expect(JSON.stringify(continued)).not.toContain("privateGuidance");
    } finally { await server.close(); }
  });

  it("ignores a delayed acceptance for a superseded editor attempt", async () => {
    const dir = await fixture();
    const first = deferred<TutorDecision>();
    const second = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(first.promise, second.promise);
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "old draft" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 1, "first review queued");
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "new draft" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 2, "second review queued");

      first.resolve({ outcome: "accepted", message: "Old acceptance." });
      await waitMs(50);
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).rejects.toThrow();
      const afterStale = await state(server.url);
      expect(block(afterStale, "edit-answer")?.checkpoint?.status).toBe("reviewing");

      second.resolve({ outcome: "accepted", message: "New acceptance." });
      const acceptedState = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "second acceptance");
      expect(block(acceptedState, "edit-answer")?.checkpoint?.successMessage).toBe("New acceptance.");
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).resolves.toBe("new draft");
    } finally { await server.close(); }
  });

  it("submits terminal and reflection evidence through the common attempt reviewer", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const terminalDecision = deferred<TutorDecision>();
    const reflectionDecision = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      terminalDecision.promise,
      { outcome: "accepted", message: "Second terminal accepted." },
      reflectionDecision.promise
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      await submitTerminalAttempt(server.url, "run-supplied-command");
      const terminalReviewing = await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "reviewing", "terminal reviewing state");
      expect(block(terminalReviewing, "run-supplied-command")?.checkpoint).toMatchObject({ status: "reviewing", evidence: { kind: "terminal", terminalHtml: expect.stringContaining("ran:run run-supplied-command") } });
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 2, "terminal review queued");
      expect(tutor.reviews[1]).toMatchObject({ privateGuidance: "Observe run result.", attempt: { evidence: { kind: "terminal", transcript: expect.stringContaining("run-supplied-command") } } });
      terminalDecision.resolve({ outcome: "accepted", message: "Terminal accepted." });
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "terminal accepted");
      expect((await postEvent(server.url, { blockId: "run-supplied-command", action: "continue" })).status).toBe(202);

      await submitTerminalAttempt(server.url, "change-job");
      await waitForWorkbookState(server.url, (next) => block(next, "change-job")?.checkpoint?.status === "accepted", "second terminal accepted");
      expect((await postEvent(server.url, { blockId: "change-job", action: "continue" })).status).toBe(202);

      const reflection = await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "It checks the bounded doer by evidence." }).then((response) => response.json() as any);
      expect(block(reflection, "reflection")).toMatchObject({ active: true, checkpoint: { status: "reviewing" } });
      expect(reflection.progress.reflectionConversations.reflection).toEqual([{ role: "learner", text: "It checks the bounded doer by evidence." }]);
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 4, "reflection review queued");
      expect(tutor.reviews[3]).toMatchObject({ privateGuidance: "Ask about harness and job.", attempt: { evidence: { kind: "reflection", response: "It checks the bounded doer by evidence.", conversation: [] } } });
      expect(JSON.stringify(reflection)).not.toContain("Ask about harness and job");
      reflectionDecision.resolve({ outcome: "feedback", message: "Name the exact boundary next." });
      const feedbackState = await waitForWorkbookState(server.url, (next) => block(next, "reflection")?.checkpoint?.status === "feedback", "reflection feedback");
      expect(block(feedbackState, "reflection")?.checkpoint?.feedback).toBe("Name the exact boundary next.");
      expect(feedbackState.progress.reflectionConversations.reflection).toEqual([
        { role: "learner", text: "It checks the bounded doer by evidence." },
        { role: "tutor", text: "Name the exact boundary next." }
      ]);
    } finally { await server.close(); }
  });

  it("lets an accepted reflection advance to the next block", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const tutor = new FakeMainTutor();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      tutor.queue.push({ outcome: "accepted", message: "First terminal accepted." });
      await submitTerminalAttempt(server.url, "run-supplied-command");
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "first terminal accepted");
      await postEvent(server.url, { blockId: "run-supplied-command", action: "continue" });
      tutor.queue.push({ outcome: "accepted", message: "Second terminal accepted." });
      await submitTerminalAttempt(server.url, "change-job");
      await waitForWorkbookState(server.url, (next) => block(next, "change-job")?.checkpoint?.status === "accepted", "second terminal accepted");
      await postEvent(server.url, { blockId: "change-job", action: "continue" });

      tutor.queue.push({ outcome: "accepted", message: "Reflection accepted." });
      expect((await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "It was headless." })).status).toBe(202);
      await waitForWorkbookState(server.url, (next) => block(next, "reflection")?.checkpoint?.status === "accepted", "reflection accepted");
      const continued = await postEvent(server.url, { blockId: "reflection", action: "continue" }).then((response) => response.json() as any);

      expect(continued.progress.activeBlockId).toBe("transition");
      expect(block(continued, "reflection")?.completed).toBe(true);
      expect(block(continued, "transition")?.active).toBe(true);
    } finally { await server.close(); }
  });

  it("rejects a reflection follow-up while the current attempt is reviewing", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const pendingReflection = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      { outcome: "accepted", message: "First terminal accepted." },
      { outcome: "accepted", message: "Second terminal accepted." },
      pendingReflection.promise
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      await submitTerminalAttempt(server.url, "run-supplied-command");
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "first terminal accepted");
      await postEvent(server.url, { blockId: "run-supplied-command", action: "continue" });
      await submitTerminalAttempt(server.url, "change-job");
      await waitForWorkbookState(server.url, (next) => block(next, "change-job")?.checkpoint?.status === "accepted", "second terminal accepted");
      await postEvent(server.url, { blockId: "change-job", action: "continue" });

      expect((await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "It was headless." })).status).toBe(202);
      await waitForWorkbookState(server.url, (next) => block(next, "reflection")?.checkpoint?.status === "reviewing", "reflection reviewing state");
      const followUp = await postEvent(server.url, { blockId: "reflection", action: "reflection-follow-up", response: "The validator cannot run commands." });
      expect(followUp.status).toBe(409);
      expect(tutor.reviews).toHaveLength(4);
      const afterRejected = await state(server.url);
      expect(afterRejected.progress.reflectionConversations.reflection).toEqual([{ role: "learner", text: "It was headless." }]);
    } finally {
      pendingReflection.resolve({ outcome: "feedback", message: "Late feedback." });
      await server.close();
    }
  });

  it("allows a reflection follow-up after a quiet working review", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      { outcome: "accepted", message: "First terminal accepted." },
      { outcome: "accepted", message: "Second terminal accepted." },
      { outcome: "working" },
      { outcome: "feedback", message: "Now name the exact boundary." }
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      await submitTerminalAttempt(server.url, "run-supplied-command");
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "first terminal accepted");
      await postEvent(server.url, { blockId: "run-supplied-command", action: "continue" });
      await submitTerminalAttempt(server.url, "change-job");
      await waitForWorkbookState(server.url, (next) => block(next, "change-job")?.checkpoint?.status === "accepted", "second terminal accepted");
      await postEvent(server.url, { blockId: "change-job", action: "continue" });

      expect((await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "It was headless." })).status).toBe(202);
      await waitForWorkbookState(server.url, (next) => block(next, "reflection")?.checkpoint?.status === "working", "quiet reflection working state");
      const followUp = await postEvent(server.url, { blockId: "reflection", action: "reflection-follow-up", response: "The validator cannot run commands." });
      expect(followUp.status).toBe(202);
      const feedbackState = await waitForWorkbookState(server.url, (next) => block(next, "reflection")?.checkpoint?.status === "feedback", "reflection follow-up feedback");
      expect(tutor.reviews).toHaveLength(5);
      expect(tutor.reviews[4].attempt.evidence).toMatchObject({ kind: "reflection", response: "The validator cannot run commands.", conversation: [{ role: "learner", text: "It was headless." }] });
      expect(block(feedbackState, "reflection")?.checkpoint?.feedback).toBe("Now name the exact boundary.");
    } finally { await server.close(); }
  });

  it("requeues active unaccepted attempts after restart", async () => {
    const dir = await fixture();
    const never = deferred<TutorDecision>();
    const firstTutor = new FakeMainTutor(never.promise);
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: firstTutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(firstServer.url);
      expect((await postEditor(firstServer.url, { blockId: "edit-answer", text: "saved before restart" })).status).toBe(202);
      await waitForWorkbookState(firstServer.url, () => firstTutor.reviews.length === 1, "first review queued");
    } finally { await firstServer.close(); }

    const secondTutor = new FakeMainTutor({ outcome: "accepted", message: "Accepted after restart." });
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: secondTutor, blockTutor: new FakeBlockTutor() });
    try {
      const acceptedState = await waitForWorkbookState(secondServer.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "restart requeue acceptance");
      expect(secondTutor.reviews).toHaveLength(1);
      expect(secondTutor.reviews[0].attempt.evidence).toMatchObject({ kind: "editor", text: "saved before restart" });
      expect(block(acceptedState, "edit-answer")?.checkpoint?.successMessage).toBe("Accepted after restart.");
    } finally { await secondServer.close(); }
  });

  it("surfaces a neutral retry state when tutor review fails", async () => {
    const dir = await fixture();
    const tutor = new FakeMainTutor(new Error("model provider down"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "draft needing retry" })).status).toBe(202);
      const failed = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "feedback", "neutral review failure feedback");
      expect(block(failed, "edit-answer")?.checkpoint?.feedback).toMatch(/temporarily unavailable|try again/i);
      expect(JSON.stringify(failed)).not.toContain("model provider down");
    } finally { await server.close(); }
  });

  it("surfaces a neutral retry state when main review feedback is empty", async () => {
    const dir = await fixture();
    const tutor = new FakeMainTutor({ outcome: "feedback", message: "   " });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "draft needing a real message" })).status).toBe(202);
      const failed = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "feedback", "neutral empty feedback failure");
      expect(block(failed, "edit-answer")?.checkpoint?.feedback).toMatch(/temporarily unavailable|try again/i);
      expect(failed.timeline.filter((record: any) => record.type === "message" && record.source === "main_tutor" && record.presentation === "review")).toEqual([]);
      expect(failed.timeline.at(-1)).toMatchObject({ type: "tutor_failed", operation: "review" });
    } finally { await server.close(); }
  });

  it("advances the active lesson after accepted checkpoints and transition continues", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      { outcome: "accepted", message: "First terminal accepted." },
      { outcome: "accepted", message: "Second terminal accepted." },
      { outcome: "accepted", message: "Reflection accepted." }
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      await submitTerminalAttempt(server.url, "run-supplied-command");
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "first terminal accepted");
      await postEvent(server.url, { blockId: "run-supplied-command", action: "continue" });
      await submitTerminalAttempt(server.url, "change-job");
      await waitForWorkbookState(server.url, (next) => block(next, "change-job")?.checkpoint?.status === "accepted", "second terminal accepted");
      await postEvent(server.url, { blockId: "change-job", action: "continue" });
      await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "Reflection." });
      await waitForWorkbookState(server.url, (next) => block(next, "reflection")?.checkpoint?.status === "accepted", "reflection accepted");
      await postEvent(server.url, { blockId: "reflection", action: "continue" });
      const second = await postEvent(server.url, { blockId: "transition", action: "continue" }).then((response) => response.json() as any);
      expect(second.progress.activeLessonId).toBe("002-second");
      expect(second.progress.activeBlockId).toBe("second-orientation");
      expect(second.progress.completedLessons).toContain("001-first");
      const privateRecords = await privateTimeline(dir);
      const publicState = await state(server.url);
      expect(privateRecords).toContainEqual(expect.objectContaining({
        type: "lesson_summarized", lessonId: "001-first"
      }));
      expect(publicState.timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "message", source: "authored", blockId: "edit-answer" }),
        expect.objectContaining({ type: "message", source: "main_tutor" })
      ]));
      expect(publicState.timeline.some((record: any) => record.type === "lesson_summarized")).toBe(false);
      expect(JSON.stringify(publicState.timeline)).not.toContain("Summary of 001-first.");
    } finally { await server.close(); }
  });

  it("enables the embedded terminal in the production server path", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const ready = vi.spyOn(terminalModule, "assertDockerTerminalReady").mockImplementation(() => {});
    vi.spyOn(terminalModule, "createDockerPty").mockImplementation(() => pty);
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." }, { outcome: "accepted", message: "Terminal accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalDebounceMs: 1, mainTutor: tutor, blockTutor: new FakeBlockTutor() });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      const ws = await connect(server.url, server.url);
      const submitted = waitFor(ws, (message) => message.type === "attempt-status" && message.status === "submitted");
      ws.send(JSON.stringify({ type: "input", data: "run default terminal\r" }));
      await submitted;
      ws.close();
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "default terminal accepted");
      expect(ready).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it("refuses unsafe embedded-terminal hosts and origins", async () => {
    const dir = await fixture();
    vi.spyOn(terminalModule, "assertDockerTerminalReady").mockImplementation(() => {});
    await expect(startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), host: "0.0.0.0", port: 0, mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() })).rejects.toThrow(/loopback/i);

    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => new ServerFakePty(), mainTutor: new FakeMainTutor(), blockTutor: new FakeBlockTutor() });
    try { await expect(connect(server.url, "http://evil.test")).rejects.toThrow(); }
    finally { await server.close(); }
  });
});
