import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import * as terminalModule from "../src/workbook/terminal.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkbookServer } from "../src/workbook/server.js";
import { EditorDraftStore, EditorReviewAdapter, type EditorDraft, type EditorReviewDecision, type EditorReviewRequest } from "../src/workbook/editor.js";
import type { TerminalObservationRequest, TerminalObserver, TerminalPty, TerminalPtyFactory } from "../src/workbook/terminal.js";
import type { ReflectionConversationAdapter } from "../src/workbook/reflection.js";

let dirs: string[] = [];

// The fixture uses only the new workbook Markdown contract: every document has
// front matter, titles live in headings, lesson.md lists block IDs, and blocks
// carry private tutor guidance only for terminal/reflection adapters.
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

class FakeEditorReviewAdapter extends EditorReviewAdapter {
  calls: EditorReviewRequest[] = [];
  constructor(private readonly decide: (request: EditorReviewRequest) => EditorReviewDecision | Promise<EditorReviewDecision> = (request) => ({ status: "unlocked", revisionId: request.draft.revision })) {
    super(async () => ({ prompt: async () => "" }));
  }
  override async review(request: EditorReviewRequest): Promise<EditorReviewDecision> {
    this.calls.push(request);
    return this.decide(request);
  }
}

async function waitMs(ms: number) { await new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitForWorkbookState(serverUrl: string, predicate: (state: any) => boolean, description: string) {
  const deadline = Date.now() + 1_000;
  let latest: any;
  while (Date.now() < deadline) {
    latest = await fetch(`${serverUrl}/api/workbook/state`).then((r) => r.json() as any);
    if (predicate(latest)) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${description}. Last state: ${JSON.stringify(latest)}`);
}

async function waitForEditorBlock(serverUrl: string, predicate: (block: any, state: any) => boolean, description: string) {
  return waitForWorkbookState(serverUrl, (state) => {
    const block = state.progress.blocks.find((candidate: any) => candidate.id === "edit-answer");
    return Boolean(block && predicate(block, state));
  }, description);
}

async function completeEditor(serverUrl: string, text = "factory acceptance marker") {
  const submitted = await postEditor(serverUrl, { blockId: "edit-answer", revision: 1, text, path: "factory/browser-direct.md" });
  expect(submitted.status).toBe(202);
  return waitForWorkbookState(serverUrl, (state) => state.progress.activeBlockId !== "edit-answer", "editor practice to unlock");
}

async function completeTerminal(serverUrl: string, blockId: string) {
  const ws = await connect(serverUrl, serverUrl);
  const verified = waitFor(ws, (message) => message.type === "verified-complete" && message.blockId === blockId);
  ws.send(JSON.stringify({ type: "input", data: `run ${blockId}\r` }));
  await verified;
  ws.close();
  return postEvent(serverUrl, { blockId, action: "complete" }).then((response) => response.json() as any);
}

let originalOpenCodeApiKey: string | undefined;
beforeEach(() => {
  originalOpenCodeApiKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "test-opencode-key";
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalOpenCodeApiKey;
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

describe("workbook browser API", () => {
  it("rejects progress actions for blocks that are not active", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      const inactiveEditor = await postEditor(server.url, { blockId: "edit-answer", revision: 1, text: "browser cannot skip orientation" });
      expect(inactiveEditor.status).toBe(409);
      for (const body of [
        { blockId: "change-job", action: "complete" },
        { blockId: "transition", action: "continue" }
      ]) {
        const response = await postEvent(server.url, body);
        expect(response.status).toBe(409);
        expect((await response.json() as { error: string }).error).toMatch(/not active/i);
      }
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      expect(state.progress.activeBlockId).toBe("orientation");
      expect(state.progress.blocks.filter((block: any) => block.completed)).toEqual([]);
    } finally { await server.close(); }
  });

  it("serves new-layout content without legacy state or private tutor data", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false });
    try {
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      expect(state.workbook).toMatchObject({ title: "Fixture workbook" });
      expect(state.introduction).toContain("Welcome to the fixture workbook.");
      expect(state.chapters.map((chapter: any) => [chapter.id, chapter.state, chapter.lesson])).toEqual([
        ["01-loop/01-first", undefined, undefined],
        ["01-loop/02-second", undefined, undefined],
      ]);
      const blocked = await postEvent(server.url, { blockId: "orientation", action: "continue" });
      expect(blocked.status).toBe(409);
      const introduced = await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      expect(introduced.progress.activeLessonId).toBe("01-loop/01-first");
      expect(introduced.progress.activeBlockId).toBe("orientation");
      expect(introduced.chapters[0]).toMatchObject({ id: "01-loop/01-first", part: "Part 1 — Loop", partMarkdown: "Part copy." });
      expect(introduced.chapters[0].state).toBeUndefined();
      expect(introduced.chapters[0].lesson).toMatchObject({ title: "First lesson", dek: "First lesson dek.", durationMinutes: 10, outcomes: ["Fixture outcome."] });
      expect(introduced.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["orientation"]);
      expect(JSON.stringify(introduced)).not.toContain("Observe run result");
      const continued = await postEvent(server.url, { blockId: "orientation", action: "continue" }).then((response) => response.json() as any);
      expect(continued.progress.activeBlockId).toBe("edit-answer");
      expect(continued.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["orientation", "edit-answer"]);
      expect(JSON.stringify(continued)).not.toContain("Observe run result");
      expect(JSON.stringify(continued)).not.toContain("Private editor rubric");
    } finally { await server.close(); }
  });

  it("reviews only the newest submitted editor revision after the debounce", async () => {
    const dir = await fixture();
    const reviewer = new FakeEditorReviewAdapter((request) => ({ status: "feedback", message: `rev ${request.draft.revision} needs the marker` }));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: reviewer, editorReviewDebounceMs: 25 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      const first = await postEditor(server.url, { blockId: "edit-answer", revision: 1, text: "first draft" }).then((response) => response.json() as any);
      const second = await postEditor(server.url, { blockId: "edit-answer", revision: 2, text: "second draft" }).then((response) => response.json() as any);
      expect(first.progress.blocks.find((block: any) => block.id === "edit-answer")).toMatchObject({ revision: 1, editorStatus: "reviewing" });
      expect(second.progress.blocks.find((block: any) => block.id === "edit-answer")).toMatchObject({ revision: 2, editorStatus: "reviewing" });
      expect(reviewer.calls).toEqual([]);
      await waitMs(35);
      expect(reviewer.calls.map((request) => request.draft.revision)).toEqual([2]);
      expect(reviewer.calls[0].draft.text).toBe("second draft");
    } finally { await server.close(); }
  });

  it("keeps editor feedback public and leaves the editor block active", async () => {
    const dir = await fixture();
    const reviewer = new FakeEditorReviewAdapter(() => ({ status: "feedback", message: "Add the factory acceptance marker." }));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: reviewer, editorReviewDebounceMs: 10 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      const reviewing = await postEditor(server.url, { blockId: "edit-answer", revision: 1, text: "missing marker" }).then((response) => response.json() as any);
      expect(reviewing.progress.activeBlockId).toBe("edit-answer");
      expect(reviewing.progress.blocks.find((block: any) => block.id === "edit-answer")).toMatchObject({ revision: 1, editorStatus: "reviewing" });
      const state = await waitForEditorBlock(server.url, (block) => block.editorStatus === "feedback", "editor feedback");
      expect(state.progress.activeBlockId).toBe("edit-answer");
      expect(state.progress.blocks.find((block: any) => block.id === "edit-answer")).toMatchObject({ revision: 1, editorStatus: "feedback", feedback: "Add the factory acceptance marker." });
      expect(JSON.stringify(state)).not.toContain("Private editor rubric");
      expect(JSON.stringify(state)).not.toContain("privateBrief");
    } finally { await server.close(); }
  });

  it("promotes the exact approved editor revision and advances to the next block", async () => {
    const dir = await fixture();
    const reviewer = new FakeEditorReviewAdapter((request) => ({ status: "unlocked", revisionId: request.draft.revision }));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: reviewer, editorReviewDebounceMs: 10 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      await postEditor(server.url, { blockId: "edit-answer", revision: 3, text: "approved revision text", path: "factory/browser-direct.md" });
      const state = await waitForWorkbookState(server.url, (state) => state.progress.activeBlockId === "run-supplied-command", "editor practice to promote and advance");
      expect(state.progress.activeBlockId).toBe("run-supplied-command");
      expect(state.progress.blocks.find((block: any) => block.id === "edit-answer")).toMatchObject({ completed: true, revision: 3, editorStatus: "unlocked" });
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).resolves.toBe("approved revision text");
      await expect(readFile(resolve(dir, "factory/browser-direct.md"), "utf8")).rejects.toThrow();
      const events = await readFile(resolve(dir, ".tutorial/.tmp/workbook/events.jsonl"), "utf8");
      expect(events).toContain("editor_practice_unlocked");
      expect(events).toContain("factory/answer.md");
    } finally { await server.close(); }
  });

  it("rejects stale editor unlock decisions without writing the target file", async () => {
    const dir = await fixture();
    const reviewer = new FakeEditorReviewAdapter(() => ({ status: "unlocked", revisionId: 1 }));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: reviewer, editorReviewDebounceMs: 10 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      await postEditor(server.url, { blockId: "edit-answer", revision: 1, text: "old" });
      await postEditor(server.url, { blockId: "edit-answer", revision: 2, text: "latest" });
      const state = await waitForEditorBlock(server.url, (block) => block.editorStatus === "feedback", "stale unlock feedback");
      expect(reviewer.calls.map((request) => request.draft.revision)).toEqual([2]);
      expect(state.progress.activeBlockId).toBe("edit-answer");
      expect(state.progress.blocks.find((block: any) => block.id === "edit-answer")).toMatchObject({ revision: 2, editorStatus: "feedback" });
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).rejects.toThrow();
      const events = await readFile(resolve(dir, ".tutorial/.tmp/workbook/events.jsonl"), "utf8");
      expect(events).not.toContain("editor_practice_unlocked");
    } finally { await server.close(); }
  });

  it("rejects same-revision editor submissions instead of replacing the accepted draft", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: new FakeEditorReviewAdapter(), editorReviewDebounceMs: 1_000 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      const first = await postEditor(server.url, { blockId: "edit-answer", revision: 1, text: "first accepted text" });
      const replacement = await postEditor(server.url, { blockId: "edit-answer", revision: 1, text: "same revision replacement" });
      expect(first.status).toBe(202);
      expect(replacement.status).toBe(409);
      expect(await replacement.json()).toMatchObject({ error: expect.stringMatching(/stale/i) });
      await expect(new EditorDraftStore(dir).read("01-loop/01-first", "edit-answer")).resolves.toMatchObject({ revision: 1, text: "first accepted text" });
    } finally { await server.close(); }
  });

  it("does not accept a newer editor draft during the promotion critical section", async () => {
    const dir = await fixture();
    const promoteStarted = deferred<void>();
    const releasePromotion = deferred<void>();
    const originalPromote = EditorDraftStore.prototype.promote;
    vi.spyOn(EditorDraftStore.prototype, "promote").mockImplementation(async function (this: EditorDraftStore, block, draft: EditorDraft) {
      promoteStarted.resolve();
      await releasePromotion.promise;
      return originalPromote.call(this, block, draft);
    });
    const reviewer = new FakeEditorReviewAdapter((request) => ({ status: "unlocked", revisionId: request.draft.revision }));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: reviewer, editorReviewDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      const first = await postEditor(server.url, { blockId: "edit-answer", revision: 1, text: "approved before finalization" });
      expect(first.status).toBe(202);
      await promoteStarted.promise;

      const newerPromise = postEditor(server.url, { blockId: "edit-answer", revision: 2, text: "newer draft during finalization" });
      const earlyResponse = await Promise.race([
        newerPromise.then((response) => response),
        waitMs(100).then(() => undefined)
      ]);
      releasePromotion.resolve();
      const newer = earlyResponse ?? await newerPromise;

      expect(newer.status).toBe(409);
      const state = await waitForWorkbookState(server.url, (state) => state.progress.activeBlockId === "run-supplied-command", "editor practice to finish finalization");
      expect(state.progress.blocks.find((block: any) => block.id === "edit-answer")).toMatchObject({ completed: true, revision: 1, editorStatus: "unlocked" });
      await expect(readFile(resolve(dir, "factory/answer.md"), "utf8")).resolves.toBe("approved before finalization");
      const draft = await new EditorDraftStore(dir).read("01-loop/01-first", "edit-answer");
      expect(draft).toMatchObject({ revision: 1, text: "approved before finalization" });
    } finally {
      releasePromotion.resolve();
      await server.close();
    }
  });

  it("rejects inactive editor submissions and unsafe declared editor paths without promotion", async () => {
    const inactiveDir = await fixture();
    const inactiveServer = await startWorkbookServer({ target: inactiveDir, webRoot: resolve(inactiveDir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: new FakeEditorReviewAdapter(), editorReviewDebounceMs: 1 });
    try {
      await fetch(`${inactiveServer.url}/api/workbook/introduction`, { method: "POST" });
      const response = await postEditor(inactiveServer.url, { blockId: "edit-answer", revision: 1, text: "too early" });
      expect(response.status).toBe(409);
      await expect(readFile(resolve(inactiveDir, "factory/answer.md"), "utf8")).rejects.toThrow();
    } finally { await inactiveServer.close(); }

    const unsafeDir = await fixture({ editorPath: "../escape.md" });
    const unsafeServer = await startWorkbookServer({ target: unsafeDir, webRoot: resolve(unsafeDir, "web"), port: 0, embeddedTerminal: false, editorReviewAdapter: new FakeEditorReviewAdapter(), editorReviewDebounceMs: 1 });
    try {
      await fetch(`${unsafeServer.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(unsafeServer.url, { blockId: "orientation", action: "continue" });
      const response = await postEditor(unsafeServer.url, { blockId: "edit-answer", revision: 1, text: "unsafe path" });
      expect(response.status).toBe(400);
      await expect(readFile(resolve(unsafeDir, "../escape.md"), "utf8")).rejects.toThrow();
    } finally { await unsafeServer.close(); }
  });

  it("passes private tutor guidance to terminal and reflection adapters", async () => {
    const dir = await fixture();
    const terminalRequests: TerminalObservationRequest[] = [];
    const observer: TerminalObserver = { observe: async (request) => { terminalRequests.push(request); return { status: "complete", summary: "done" }; } };
    const reflectionRequests: any[] = [];
    const reflectionConversation: ReflectionConversationAdapter = { reply: async (request) => { reflectionRequests.push(request); return "You connected the command result to the validation loop."; } };
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: observer, terminalPtyFactory: () => new ServerFakePty(), terminalDebounceMs: 1, reflectionConversation, editorReviewAdapter: new FakeEditorReviewAdapter(), editorReviewDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      await completeEditor(server.url);
      await completeTerminal(server.url, "run-supplied-command");
      await completeTerminal(server.url, "change-job");
      expect(terminalRequests.map((request) => [request.blockId, request.expectedObservation])).toEqual([
        ["run-supplied-command", "Observe run result."],
        ["change-job", "Observe changed-job result."],
      ]);
      const discussed = await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "It checks whether the work achieved the expected result." }).then((response) => response.json() as any);
      expect(discussed.progress.activeBlockId).toBe("reflection");
      expect(discussed.progress.reflectionConversations.reflection).toEqual([
        { role: "learner", text: "It checks whether the work achieved the expected result." },
        { role: "tutor", text: expect.stringMatching(/connected/i) }
      ]);
      expect(reflectionRequests[0].question).toBe("Why did this count as headless?");
      expect(reflectionRequests[0].tutor).toBe("Ask about harness and job.");
      expect(reflectionRequests[0].practiceEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: "run-supplied-command", expectedObservation: "Observe run result." })]));
      expect(JSON.stringify(discussed)).toContain("Why did this count as headless?");
      expect(JSON.stringify(discussed)).not.toContain("Ask about harness and job");
    } finally { await server.close(); }
  });

  it("advances the active lesson after the current lesson completes", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: { observe: async () => ({ status: "complete" }) }, terminalPtyFactory: () => new ServerFakePty(), terminalDebounceMs: 1, reflectionConversation: { reply: async () => "Tutor reply." }, editorReviewAdapter: new FakeEditorReviewAdapter(), editorReviewDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      await completeEditor(server.url);
      await completeTerminal(server.url, "run-supplied-command");
      await completeTerminal(server.url, "change-job");
      await postEvent(server.url, { blockId: "reflection", action: "reflection-submit", response: "Reflection." });
      await postEvent(server.url, { blockId: "reflection", action: "reflection-complete" });
      const second = await postEvent(server.url, { blockId: "transition", action: "continue" }).then((response) => response.json() as any);
      expect(second.progress.activeLessonId).toBe("01-loop/02-second");
      expect(second.progress.activeBlockId).toBe("second-orientation");
      expect(second.progress.completedLessons).toContain("01-loop/01-first");
      expect(second.chapters[1].lesson.blocks.map((block: any) => block.id)).toEqual(["second-orientation"]);
    } finally { await server.close(); }
  });

  it("enables the observed embedded terminal in the production server path", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const ready = vi.spyOn(terminalModule, "assertDockerTerminalReady").mockImplementation(() => {});
    vi.spyOn(terminalModule, "createDockerPty").mockImplementation(() => pty);
    vi.spyOn(terminalModule.PiTerminalObserver.prototype, "observe").mockResolvedValue({ status: "complete", summary: "done" });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalDebounceMs: 1, editorReviewAdapter: new FakeEditorReviewAdapter(), editorReviewDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      await completeEditor(server.url);
      const ws = await connect(server.url, server.url);
      const completed = waitFor(ws, (message) => message.type === "verified-complete" && message.blockId === "run-supplied-command");
      ws.send(JSON.stringify({ type: "input", data: "run default terminal\r" }));
      await completed;
      ws.close();
      const events = await readFile(resolve(dir, ".tutorial/.tmp/workbook/events.jsonl"), "utf8");
      expect(events).toContain("observation_verified");
      expect(events).toContain("terminal_observer");
      expect(ready).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it("refuses to boot an embedded terminal without OPENCODE_API_KEY", async () => {
    const dir = await fixture();
    const previous = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    let server: Awaited<ReturnType<typeof startWorkbookServer>> | undefined;
    try {
      server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: { observe: async () => ({ status: "waiting" }) }, terminalPtyFactory: () => new ServerFakePty() });
      expect.unreachable("embedded terminal boot should require OPENCODE_API_KEY");
    } catch (error) {
      expect(error).toHaveProperty("message", expect.stringMatching(/OPENCODE_API_KEY/));
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous;
      await server?.close();
    }
  });

  it("rejects embedded terminal on a non-loopback host", async () => {
    const dir = await fixture();
    vi.spyOn(terminalModule, "assertDockerTerminalReady").mockImplementation(() => {});
    await expect(startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), host: "0.0.0.0", port: 0 }))
      .rejects.toThrow(/loopback/i);
  });

  it("rejects terminal WebSocket origins that are not the workbook server", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: { observe: async () => ({ status: "waiting" }) }, terminalPtyFactory: () => new ServerFakePty() });
    try {
      await expect(connect(server.url, "http://evil.test")).rejects.toThrow();
    } finally { await server.close(); }
  });

  it("verified terminal practice holds a server-owned success checkpoint until completion", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const observer: TerminalObserver = { observe: async () => ({ status: "complete", summary: "done" }) };
    const factory: TerminalPtyFactory = () => pty;
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: observer, terminalPtyFactory: factory, terminalDebounceMs: 1, editorReviewAdapter: new FakeEditorReviewAdapter(), editorReviewDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      await completeEditor(server.url);
      const ws = await connect(server.url, server.url);
      const completed = waitFor(ws, (message) => message.type === "verified-complete");
      ws.send(JSON.stringify({ type: "input", data: "echo hello\r" }));
      const message = await completed;
      expect(message.state.progress.activeBlockId).toBe("run-supplied-command");
      expect(message.state.progress.blocks.find((block: any) => block.id === "run-supplied-command")).toMatchObject({ verified: true, completed: false, feedback: "done" });
      const complete = await postEvent(server.url, { blockId: "run-supplied-command", action: "complete" }).then((response) => response.json() as any);
      expect(complete.progress.activeBlockId).toBe("change-job");
      ws.close();
      const events = await readFile(resolve(dir, ".tutorial/.tmp/workbook/events.jsonl"), "utf8");
      expect(events).toContain("observation_verified");
      expect(events).toContain("block_completed");
      expect(events).toContain("terminal_observer");
      expect(events).toContain("frozen-terminal-output");
      expect(events).toContain("ran:echo hello");
    } finally { await server.close(); }
  });

  it("terminal advice never completes the active block or enters the event log", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty();
    const server = await startWorkbookServer({
      target: dir,
      webRoot: resolve(dir, "web"),
      port: 0,
      terminalPtyFactory: () => pty,
      terminalDebounceMs: 1,
      terminalObserver: { observe: async () => ({ status: "advice", message: "Run the authored command from the repository root." }) },
      editorReviewAdapter: new FakeEditorReviewAdapter(),
      editorReviewDebounceMs: 1
    });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
      await completeEditor(server.url);
      const ws = await connect(server.url, server.url);
      const advice = waitFor(ws, (message) => message.type === "advice");
      ws.send(JSON.stringify({ type: "input", data: "bad\r" }));
      expect(await advice).toMatchObject({ message: "Run the authored command from the repository root." });
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      expect(state.progress.activeBlockId).toBe("run-supplied-command");
      ws.close();
      const events = await readFile(resolve(dir, ".tutorial/.tmp/workbook/events.jsonl"), "utf8");
      expect(events).not.toContain("Run the authored command");
      expect(events).not.toContain("bad");
    } finally { await server.close(); }
  });
});
