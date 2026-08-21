import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import * as terminalModule from "../src/workbook/terminal.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkbookServer } from "../src/workbook/server.js";
import type { TerminalPty, TerminalPtyFactory } from "../src/workbook/terminal.js";
import type { TutorDecision, TutorReview, WorkbookTutor } from "../src/workbook/tutor.js";

let dirs: string[] = [];

async function fixture(options: { editorPath?: string } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-server-")); dirs.push(dir);
  const partDir = resolve(dir, "lessons/01-loop");
  const first = resolve(partDir, "01-first");
  const second = resolve(partDir, "02-second");
  await mkdir(resolve(first, "blocks"), { recursive: true });
  await mkdir(resolve(second, "blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), ["---", "---", "# Fixture workbook", "", "Welcome to the fixture workbook."].join("\n"));
  await writeFile(resolve(partDir, "part.md"), ["---", "---", "# Part 1 — Loop", "", "Part copy."].join("\n"));
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

type QueuedDecision = TutorDecision | Error | Promise<TutorDecision> | ((review: TutorReview) => TutorDecision | Promise<TutorDecision>);
class FakeTutor implements WorkbookTutor {
  reviews: TutorReview[] = [];
  restores: readonly import("../src/workbook/timeline.js").WorkbookTimelineRecord[][] = [];
  replies: Array<{ lessonId: string; blockId: string; learnerMessage: import("../src/workbook/timeline.js").TimelineMessage }> = [];
  blockSummaries: Array<{ lessonId: string; blockId: string; coveredThroughId: string }> = [];
  lessonSummaries: Array<{ lessonId: string; coveredThroughId: string }> = [];
  compactions = 0;
  disposed = false;
  queue: QueuedDecision[] = [];
  replyQueue: Array<string | Error | Promise<string>> = [];
  constructor(...queue: QueuedDecision[]) { this.queue = queue; }
  async restore(records: readonly import("../src/workbook/timeline.js").WorkbookTimelineRecord[]): Promise<void> { this.restores.push(records); }
  async reply(input: { lessonId: string; blockId: string; learnerMessage: import("../src/workbook/timeline.js").TimelineMessage }): Promise<string> {
    this.replies.push(input);
    const next = this.replyQueue.shift() ?? "Try the workspace-relative path.";
    if (next instanceof Error) throw next;
    return next;
  }
  async review(input: TutorReview): Promise<TutorDecision> {
    this.reviews.push(input);
    const next = this.queue.shift() ?? { accepted: false, feedback: "Keep going." };
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(input) : next;
  }
  async compactAfterBlock(): Promise<void> { this.compactions++; }
  async summarizeBlock(input: { lessonId: string; blockId: string; coveredThroughId: string }): Promise<string> {
    this.blockSummaries.push(input);
    return `Summary of ${input.blockId}.`;
  }
  async summarizeLesson(input: { lessonId: string; coveredThroughId: string }): Promise<string> {
    this.lessonSummaries.push(input);
    return `Summary of ${input.lessonId}.`;
  }
  dispose(): void { this.disposed = true; }
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

async function state(serverUrl: string) { return fetch(`${serverUrl}/api/workbook/state`).then((r) => r.json() as any); }
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

async function acceptEditor(serverUrl: string, tutor: FakeTutor, text = "factory acceptance marker") {
  tutor.queue.push({ accepted: true, feedback: "Editor accepted." });
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
  it("serves content without private tutor data and rejects inactive actions", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: new FakeTutor() });
    try {
      const initial = await state(server.url);
      expect(initial.chapters.map((chapter: any) => [chapter.id, chapter.lesson])).toEqual([["01-loop/01-first", undefined], ["01-loop/02-second", undefined]]);
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

  it("records the first active authored block once and restores it after restart", async () => {
    const dir = await fixture();
    const firstTutor = new FakeTutor();
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: firstTutor });
    let persisted: any[];
    try {
      const opened = await fetch(`${firstServer.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      const authored = opened.timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(authored).toHaveLength(1);
      expect(authored[0]).toMatchObject({ blockId: "orientation", presentation: "course", text: expect.stringContaining("## Orientation") });
      expect(JSON.stringify(opened.timeline)).not.toContain("Private editor rubric");
      persisted = (await state(firstServer.url)).timeline;
      expect((await state(firstServer.url)).timeline).toEqual(persisted);
    } finally { await firstServer.close(); }

    const secondTutor = new FakeTutor();
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: secondTutor });
    try {
      expect((await state(secondServer.url)).timeline).toEqual(persisted!);
      expect(secondTutor.restores).toHaveLength(1);
      expect(secondTutor.restores[0].filter((record) => record.type === "message" || record.type === "tutor_failed")).toEqual(persisted!);
    } finally { await secondServer.close(); }
  });

  it("persists learner chat before its tutor reply without private guidance", async () => {
    const dir = await fixture();
    const tutor = new FakeTutor();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      const response = await postMessage(server.url, { blockId: "edit-answer", text: "Which path should I use?" });
      expect(response.status).toBe(202);
      const messages = (await state(server.url)).timeline.filter((record: any) => record.type === "message");
      expect(messages.slice(-2).map((record: any) => [record.role, record.source, record.text])).toEqual([
        ["user", "learner", "Which path should I use?"],
        ["assistant", "tutor", "Try the workspace-relative path."],
      ]);
      expect(JSON.stringify(messages)).not.toContain("Private editor rubric");
    } finally { await server.close(); }
  });

  it("records a public retryable failure instead of provider feedback when chat fails", async () => {
    const dir = await fixture();
    const tutor = new FakeTutor();
    tutor.replyQueue.push(new Error("provider secret failure"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postMessage(server.url, { blockId: "edit-answer", text: "Which path?" })).status).toBe(202);
      const timeline = (await state(server.url)).timeline;
      expect(timeline.at(-1)).toMatchObject({ type: "tutor_failed", operation: "reply" });
      expect(JSON.stringify(timeline)).not.toContain("provider secret failure");
    } finally { await server.close(); }
  });

  it("creates a reviewing editor attempt, promotes only after tutor acceptance, and continues generically", async () => {
    const dir = await fixture();
    const accepted = deferred<TutorDecision>();
    const tutor = new FakeTutor(accepted.promise);
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      const submitted = await postEditor(server.url, { blockId: "edit-answer", text: "factory acceptance marker" }).then((response) => response.json() as any);
      expect(block(submitted, "edit-answer")).toMatchObject({ active: true, draftText: "factory acceptance marker", checkpoint: { status: "reviewing" } });
      expect(tutor.reviews[0]).toMatchObject({ privateGuidance: expect.stringContaining("Private editor rubric"), attempt: { evidence: { kind: "editor", text: "factory acceptance marker" } } });
      expect(JSON.stringify(submitted)).not.toContain("Private editor rubric");
      await expect(access(resolve(dir, "factory/answer.md"))).rejects.toThrow();
      expect((await postEvent(server.url, { blockId: "edit-answer", action: "continue" })).status).toBe(409);

      accepted.resolve({ accepted: true, feedback: "Ready to continue." });
      const acceptedState = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "accepted editor checkpoint");
      expect(acceptedState.progress.activeBlockId).toBe("edit-answer");
      expect(block(acceptedState, "edit-answer")).toMatchObject({ active: true, completed: false, checkpoint: { status: "accepted", successMessage: "Ready to continue.", evidence: { kind: "editor", text: "factory acceptance marker" } } });
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).resolves.toBe("factory acceptance marker");
      const continued = await postEvent(server.url, { blockId: "edit-answer", action: "continue" }).then((response) => response.json() as any);
      expect(continued.progress.activeBlockId).toBe("run-supplied-command");
      await waitForWorkbookState(server.url, () => tutor.blockSummaries.some((summary) => summary.blockId === "edit-answer"), "queued block summary");
      expect(JSON.stringify(continued)).not.toContain("attemptId");
      expect(JSON.stringify(continued)).not.toContain("privateGuidance");
    } finally { await server.close(); }
  });

  it("ignores a delayed acceptance for a superseded editor attempt", async () => {
    const dir = await fixture();
    const first = deferred<TutorDecision>();
    const second = deferred<TutorDecision>();
    const tutor = new FakeTutor(first.promise, second.promise);
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "old draft" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 1, "first review queued");
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "new draft" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 2, "second review queued");

      first.resolve({ accepted: true, feedback: "Old acceptance." });
      await waitMs(50);
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).rejects.toThrow();
      const afterStale = await state(server.url);
      expect(block(afterStale, "edit-answer")?.checkpoint?.status).toBe("reviewing");

      second.resolve({ accepted: true, feedback: "New acceptance." });
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
    const tutor = new FakeTutor(
      { accepted: true, feedback: "Editor accepted." },
      terminalDecision.promise,
      { accepted: true, feedback: "Second terminal accepted." },
      reflectionDecision.promise
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, workbookTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      await submitTerminalAttempt(server.url, "run-supplied-command");
      const terminalReviewing = await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "reviewing", "terminal reviewing state");
      expect(block(terminalReviewing, "run-supplied-command")?.checkpoint).toMatchObject({ status: "reviewing", evidence: { kind: "terminal", terminalHtml: expect.stringContaining("ran:run run-supplied-command") } });
      expect(tutor.reviews[1]).toMatchObject({ privateGuidance: "Observe run result.", attempt: { evidence: { kind: "terminal", transcript: expect.stringContaining("run-supplied-command") } } });
      terminalDecision.resolve({ accepted: true, feedback: "Terminal accepted." });
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.checkpoint?.status === "accepted", "terminal accepted");
      expect((await postEvent(server.url, { blockId: "run-supplied-command", action: "continue" })).status).toBe(202);

      await submitTerminalAttempt(server.url, "change-job");
      await waitForWorkbookState(server.url, (next) => block(next, "change-job")?.checkpoint?.status === "accepted", "second terminal accepted");
      expect((await postEvent(server.url, { blockId: "change-job", action: "continue" })).status).toBe(202);

      const reflection = await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "It checks the bounded doer by evidence." }).then((response) => response.json() as any);
      expect(block(reflection, "reflection")).toMatchObject({ active: true, checkpoint: { status: "reviewing" } });
      expect(reflection.progress.reflectionConversations.reflection).toEqual([{ role: "learner", text: "It checks the bounded doer by evidence." }]);
      expect(tutor.reviews[3]).toMatchObject({ privateGuidance: "Ask about harness and job.", attempt: { evidence: { kind: "reflection", response: "It checks the bounded doer by evidence.", conversation: [] } } });
      expect(JSON.stringify(reflection)).not.toContain("Ask about harness and job");
      reflectionDecision.resolve({ accepted: false, feedback: "Name the exact boundary next." });
      const feedbackState = await waitForWorkbookState(server.url, (next) => block(next, "reflection")?.checkpoint?.status === "feedback", "reflection feedback");
      expect(block(feedbackState, "reflection")?.checkpoint?.feedback).toBe("Name the exact boundary next.");
      expect(feedbackState.progress.reflectionConversations.reflection).toEqual([
        { role: "learner", text: "It checks the bounded doer by evidence." },
        { role: "tutor", text: "Name the exact boundary next." }
      ]);
    } finally { await server.close(); }
  });

  it("requeues active unaccepted attempts after restart", async () => {
    const dir = await fixture();
    const never = deferred<TutorDecision>();
    const firstTutor = new FakeTutor(never.promise);
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: firstTutor });
    try {
      await introduceAndOpenEditor(firstServer.url);
      expect((await postEditor(firstServer.url, { blockId: "edit-answer", text: "saved before restart" })).status).toBe(202);
      await waitForWorkbookState(firstServer.url, () => firstTutor.reviews.length === 1, "first review queued");
    } finally { await firstServer.close(); }

    const secondTutor = new FakeTutor({ accepted: true, feedback: "Accepted after restart." });
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: secondTutor });
    try {
      const acceptedState = await waitForWorkbookState(secondServer.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "restart requeue acceptance");
      expect(secondTutor.reviews).toHaveLength(1);
      expect(secondTutor.reviews[0].attempt.evidence).toMatchObject({ kind: "editor", text: "saved before restart" });
      expect(block(acceptedState, "edit-answer")?.checkpoint?.successMessage).toBe("Accepted after restart.");
    } finally { await secondServer.close(); }
  });

  it("surfaces a neutral retry state when tutor review fails", async () => {
    const dir = await fixture();
    const tutor = new FakeTutor(new Error("model provider down"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, workbookTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "draft needing retry" })).status).toBe(202);
      const failed = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "feedback", "neutral review failure feedback");
      expect(block(failed, "edit-answer")?.checkpoint?.feedback).toMatch(/temporarily unavailable|try again/i);
      expect(JSON.stringify(failed)).not.toContain("model provider down");
    } finally { await server.close(); }
  });

  it("advances the active lesson after accepted checkpoints and transition continues", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const tutor = new FakeTutor(
      { accepted: true, feedback: "Editor accepted." },
      { accepted: true, feedback: "First terminal accepted." },
      { accepted: true, feedback: "Second terminal accepted." },
      { accepted: true, feedback: "Reflection accepted." }
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalDebounceMs: 1, workbookTutor: tutor });
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
      expect(second.progress.activeLessonId).toBe("01-loop/02-second");
      expect(second.progress.activeBlockId).toBe("second-orientation");
      expect(second.progress.completedLessons).toContain("01-loop/01-first");
    } finally { await server.close(); }
  });

  it("enables the embedded terminal in the production server path", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const ready = vi.spyOn(terminalModule, "assertDockerTerminalReady").mockImplementation(() => {});
    vi.spyOn(terminalModule, "createDockerPty").mockImplementation(() => pty);
    const tutor = new FakeTutor({ accepted: true, feedback: "Editor accepted." }, { accepted: true, feedback: "Terminal accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalDebounceMs: 1, workbookTutor: tutor });
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
    await expect(startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), host: "0.0.0.0", port: 0, workbookTutor: new FakeTutor() })).rejects.toThrow(/loopback/i);

    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => new ServerFakePty(), workbookTutor: new FakeTutor() });
    try { await expect(connect(server.url, "http://evil.test")).rejects.toThrow(); }
    finally { await server.close(); }
  });
});
