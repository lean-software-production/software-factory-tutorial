import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import * as terminalModule from "../src/workbook/terminal.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWorkbookServer } from "../src/workbook/server.js";
import type { TerminalObservationRequest, TerminalObserver, TerminalPty, TerminalPtyFactory } from "../src/workbook/terminal.js";
import type { ReflectionConversationAdapter } from "../src/workbook/reflection.js";

let dirs: string[] = [];

// The fixture uses only the new workbook Markdown contract: every document has
// front matter, titles live in headings, lesson.md lists block IDs, and blocks
// carry private tutor guidance only for terminal/reflection adapters.
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-server-")); dirs.push(dir);
  const partDir = resolve(dir, "lessons/01-loop");
  const first = resolve(partDir, "01-first");
  const second = resolve(partDir, "02-second");
  await mkdir(resolve(first, "blocks"), { recursive: true });
  await mkdir(resolve(second, "blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), ["---", "---", "# Fixture workbook", "", "Welcome to the fixture workbook."].join("\n"));
  await writeFile(resolve(partDir, "part.md"), ["---", "---", "# Part 1 — Loop", "", "Part copy."].join("\n"));
  await writeLesson(first, "First lesson", ["orientation", "run-supplied-command", "change-job", "reflection", "transition"]);
  await writeBlock(first, "orientation", "narrative", "Orientation", "Start with the concept.");
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

async function writeBlock(lessonDir: string, id: string, type: string, title: string, markdown: string, tutor?: string) {
  await writeFile(resolve(lessonDir, `blocks/${id}.md`), [
    "---",
    `type: ${type}`,
    ...(tutor ? [`tutor: ${tutor}`] : []),
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
      expect(continued.progress.activeBlockId).toBe("run-supplied-command");
      expect(continued.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["orientation", "run-supplied-command"]);
      expect(JSON.stringify(continued)).not.toContain("Observe run result");
    } finally { await server.close(); }
  });

  it("passes private tutor guidance to terminal and reflection adapters", async () => {
    const dir = await fixture();
    const terminalRequests: TerminalObservationRequest[] = [];
    const observer: TerminalObserver = { observe: async (request) => { terminalRequests.push(request); return { status: "complete", summary: "done" }; } };
    const reflectionRequests: any[] = [];
    const reflectionConversation: ReflectionConversationAdapter = { reply: async (request) => { reflectionRequests.push(request); return "You connected the command result to the validation loop."; } };
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: observer, terminalPtyFactory: () => new ServerFakePty(), terminalDebounceMs: 1, reflectionConversation });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
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
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: { observe: async () => ({ status: "complete" }) }, terminalPtyFactory: () => new ServerFakePty(), terminalDebounceMs: 1, reflectionConversation: { reply: async () => "Tutor reply." } });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
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
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
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
    const dir = await fixture(true);
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
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: observer, terminalPtyFactory: factory, terminalDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
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
      terminalObserver: { observe: async () => ({ status: "advice", message: "Run the authored command from the repository root." }) }
    });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      await postEvent(server.url, { blockId: "orientation", action: "continue" });
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
