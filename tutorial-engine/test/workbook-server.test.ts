import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkbookServer } from "../src/workbook/server.js";
import type { TerminalObserver, TerminalPty, TerminalPtyFactory } from "../src/workbook/terminal.js";
import type { ReflectionConversationAdapter } from "../src/workbook/reflection.js";

let dirs: string[] = [];

// The fixture uses a lesson whose id is not "001", proving no lesson ID is
// hard-coded into the runtime; the active lesson is the first migrated chapter
// the authored workbook declares. It also omits docs/specs entirely, proving
// the rail is derived from workbook.yaml alone.
async function fixture(observed = false) {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-server-")); dirs.push(dir);
  const partDir = resolve(dir, "lessons/01-loop");
  const lessonDir = resolve(partDir, "01-first");
  await mkdir(resolve(lessonDir, "blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), [
    "---", "title: Fixture workbook", "---",
    "Welcome to the fixture workbook."
  ].join("\n"));
  await writeFile(resolve(partDir, "part.md"), "# Part 1 — Loop\n\nPart copy.\n");
  await mkdir(resolve(partDir, "02-second"), { recursive: true });
  await writeFile(resolve(partDir, "02-second/hero.md"), "# Second lesson\n");
  await writeFile(resolve(lessonDir, "lesson.yaml"), [
    "hero: hero.md", "opening: opening.md", "blocks:",
    "  - id: run-supplied-command", "    type: terminal-practice", "    required: true", "    source: blocks/run-supplied-command.md",
    "  - id: change-job", "    type: terminal-practice", "    required: true", "    source: blocks/change-job.md",
    "  - id: reflection", "    type: reflection", "    required: true", "    source: blocks/reflection.md",
    "  - id: transition", "    type: lesson-transition", "    required: true", "    source: blocks/transition.md",
  ].join("\n"));
  await writeFile(resolve(lessonDir, "hero.md"), ["---", "title: First lesson hero", "dek: A hero summary line.", "meta:", "  - Your terminal", "---"].join("\n"));
  await writeFile(resolve(lessonDir, "opening.md"), ["---", "sectionLabel: What you will learn", "heading: An opening heading.", "outcomes:", "  - Do the thing.", "---", "The **payoff** sentence."].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/run-supplied-command.md"), ["---", "title: Run", "command: echo hello", "context: Root", "expectedObservation: Done", ...(observed ? ["terminalMode: observed-embedded-optional"] : []), "---"].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/change-job.md"), ["---", "title: Change", "command: echo again", "context: Root", "expectedObservation: Done", ...(observed ? ["terminalMode: observed-embedded-optional"] : []), "---"].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/reflection.md"), ["---", "title: Reflect", "prompt: Why?", "---"].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/transition.md"), ["---", "title: Finish", "label: Finish", "---", "Done."].join("\n"));
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
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

afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook browser API", () => {
  it("rejects an action for a required block that is not active", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      for (const body of [
        { blockId: "change-job", action: "acknowledge" },
        { blockId: "transition", action: "transition" }
      ]) {
        const response = await fetch(`${server.url}/api/workbook/events`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        expect(response.status).toBe(409);
        expect((await response.json() as { error: string }).error).toMatch(/not active/i);
      }
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      expect(state.progress.activeBlockId).toBe("run-supplied-command");
      expect(state.progress.blocks.filter((block: any) => block.completed)).toEqual([]);
    } finally { await server.close(); }
  });

  it("serves the first migrated lesson from the authored rail and leaves later chapters as stubs", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0 });
    try {
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      // Identity and introduction come from the authored workbook, not the engine.
      expect(state.workbook).toMatchObject({ title: "Fixture workbook" });
      expect(state.introduction).toContain("Welcome to the fixture workbook.");
      expect(state.chapters.map((chapter: any) => [chapter.id, chapter.state, chapter.partNumber, chapter.lessonNumber])).toEqual([["01-loop/01-first", "unavailable", 1, 1], ["01-loop/02-second", "unavailable", 1, 2]]);
      expect(state.introductionComplete).toBe(false);
      expect(state.chapters[0].lesson).toBeUndefined();
      const blocked = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "acknowledge" }) });
      expect(blocked.status).toBe(409);
      const introduced = await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      expect(introduced.introductionComplete).toBe(true);
      expect(introduced.chapters.map((chapter: any) => [chapter.id, chapter.state, chapter.partNumber, chapter.lessonNumber])).toEqual([["01-loop/01-first", "migrated", 1, 1], ["01-loop/02-second", "unavailable", 1, 2]]);
      expect(introduced.progress.activeLessonId).toBe("01-loop/01-first");
      // Hero and opening are Markdown-derived authored content.
      expect(introduced.chapters[0]).toMatchObject({ part: "Part 1 — Loop", partMarkdown: "Part copy." });
      expect(introduced.chapters[0].lesson.hero).toMatchObject({ title: "First lesson hero", dek: "A hero summary line.", meta: ["Your terminal"] });
      expect(introduced.chapters[0].lesson.opening).toMatchObject({ sectionLabel: "What you will learn", heading: "An opening heading.", outcomes: ["Do the thing."] });
      expect(introduced.chapters[0].lesson.opening.markdown).toContain("**payoff**");
      // Only emerged block content is serialized: the ahead command and prompt are absent.
      expect(introduced.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["run-supplied-command"]);
      expect(JSON.stringify(introduced)).not.toContain("echo again");
      expect(JSON.stringify(introduced)).not.toContain("Why?");
      const different = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "unexpected", evidence: "command failed" }) }).then((r) => r.json() as any);
      expect(different.progress.activeBlockId).toBe("run-supplied-command");
      const ack = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "acknowledge" }) }).then((r) => r.json() as any);
      expect(ack.progress.activeBlockId).toBe("change-job");
      expect(ack.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["run-supplied-command", "change-job"]);
    } finally { await server.close(); }
  });

  it("discusses a reflection with the completed practice evidence before advancing", async () => {
    const dir = await fixture();
    const requests: any[] = [];
    const reflectionConversation: ReflectionConversationAdapter = { reply: async (request) => { requests.push(request); return "You connected the command result to the validation loop. What would a failing result tell you?"; } };
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, reflectionConversation });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      for (const blockId of ["run-supplied-command", "change-job"]) await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, action: "acknowledge" }) });
      const discussed = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "reflection", action: "reflection-submit", response: "It checks whether the work achieved the expected result." }) }).then((response) => response.json() as any);
      expect(discussed.progress.activeBlockId).toBe("reflection");
      expect(discussed.progress.reflectionConversations.reflection).toEqual([
        { role: "learner", text: "It checks whether the work achieved the expected result." },
        { role: "tutor", text: expect.stringMatching(/connected/i) }
      ]);
      expect(requests[0].practiceEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ blockId: "run-supplied-command", expectedObservation: "Done" })]));
      const complete = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "reflection", action: "reflection-complete" }) }).then((response) => response.json() as any);
      expect(complete.progress.activeBlockId).toBe("transition");
    } finally { await server.close(); }
  });

  it("rejects embedded terminal on a non-loopback host", async () => {
    const dir = await fixture(true);
    await expect(startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), host: "0.0.0.0", port: 0, terminalObserver: { observe: async () => ({ status: "waiting" }) } }))
      .rejects.toThrow(/loopback/i);
  });

  it("rejects terminal WebSocket origins that are not the workbook server", async () => {
    const dir = await fixture(true);
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: { observe: async () => ({ status: "waiting" }) } });
    try {
      await expect(connect(server.url, "http://evil.test")).rejects.toThrow();
    } finally { await server.close(); }
  });

  it("verified terminal practice holds a server-owned success checkpoint until completion", async () => {
    const dir = await fixture(true);
    const pty = new ServerFakePty();
    const observer: TerminalObserver = { observe: async () => ({ status: "complete", summary: "done" }) };
    const factory: TerminalPtyFactory = () => pty;
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalObserver: observer, terminalPtyFactory: factory, terminalDebounceMs: 1 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      const ws = await connect(server.url, server.url);
      const completed = waitFor(ws, (message) => message.type === "verified-complete");
      ws.send(JSON.stringify({ type: "input", data: "echo hello\r" }));
      const message = await completed;
      expect(message.state.progress.activeBlockId).toBe("run-supplied-command");
      expect(message.state.progress.blocks.find((block: any) => block.id === "run-supplied-command")).toMatchObject({ verified: true, completed: false, feedback: "done" });
      const complete = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "complete" }) }).then((response) => response.json() as any);
      expect(complete.progress.activeBlockId).toBe("change-job");
      ws.close();
      const events = await readFile(resolve(dir, ".tutorial/.tmp/workbook/events.jsonl"), "utf8");
      expect(events).toContain("observation_verified");
      expect(events).toContain("block_completed");
      expect(events).toContain("terminal_observer");
      expect(events).not.toContain("ran:echo hello");
      expect(events).not.toContain("echo hello\\r");
    } finally { await server.close(); }
  });

  it("terminal advice never completes the active block or enters the event log", async () => {
    const dir = await fixture(true);
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

  it("does not let terminal activity complete a non-active observed block", async () => {
    const dir = await fixture(true);
    const pty = new ServerFakePty();
    const observed: string[] = [];
    const server = await startWorkbookServer({
      target: dir,
      webRoot: resolve(dir, "web"),
      port: 0,
      terminalPtyFactory: () => pty,
      terminalDebounceMs: 1,
      terminalObserver: { observe: async (request) => { observed.push(request.blockId); return { status: "complete" }; } }
    });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      const ws = await connect(server.url, server.url);
      const completed = waitFor(ws, (message) => message.type === "verified-complete");
      ws.send(JSON.stringify({ type: "input", data: "echo hello\r" }));
      await completed;
      expect(observed).toEqual(["run-supplied-command"]);
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      expect(state.progress.activeBlockId).toBe("run-supplied-command");
      expect(state.progress.blocks.find((block: any) => block.id === "run-supplied-command")?.verified).toBe(true);
      ws.close();
    } finally { await server.close(); }
  });
});
