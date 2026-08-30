import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, access } from "node:fs/promises";
import * as terminalModule from "../src/workbook/terminal.js";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tutorialSessionStatePath, tutorialStatePath } from "../src/workbook/tutorial-state.js";
import { MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_BYTES, TerminalEvidenceRepository } from "../src/workbook/terminal-evidence.js";
import { SessionWorkspaceManager } from "../src/session-workspace.js";
import { startWorkbookServer } from "../src/workbook/server.js";
import { TimelineThread } from "../web-workbook/src/timeline-thread.js";
import type { ContentWatchFactory } from "../src/workbook/content-watch.js";
import type { TerminalPty, TerminalPtyFactory } from "../src/workbook/terminal.js";
import type { Attempt } from "../src/workbook/attempts.js";
import { DefaultMainWorkbookTutor, type TutorDecision, type WorkbookTutorSessionFactoryRequest } from "../src/workbook/tutor.js";
import { createResilientTutorSession, type PiTutorSessionEvent } from "../src/workbook/pi-tutor-session.js";
import { UnsupportedWorkbookSessionError, WorkbookTimeline, workbookSessionFormatRecord, type TimelineMessage, type WorkbookTimelineRecord } from "../src/workbook/timeline.js";
import { QueuedMainTutor as FakeMainTutor } from "./support/fake-tutors.js";

let dirs: string[] = [];

async function fixture(options: { editorPath?: string; firstLessonWorkspace?: string } = {}) {
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
  await writeLesson(first, "First lesson", ["orientation", "edit-answer", "run-supplied-command", "change-job", "reflection", "transition"], "Fixture lesson introduction.", options.firstLessonWorkspace ?? "refactor-line");
  await writeBlock(first, "orientation", "narrative", "Orientation", "Start with the concept.");
  await writeBlock(first, "edit-answer", "editor-practice", "Edit", "Write the answer in the editor.", "Private editor rubric: mention the factory acceptance marker.", options.editorPath ?? "factory/answer.md");
  await writeBlock(first, "run-supplied-command", "terminal-practice", "Run", "Run the supplied command.", "Observe run result.");
  await writeBlock(first, "change-job", "terminal-practice", "Change", "Change the job and run again.", "Observe changed-job result.");
  await writeBlock(first, "reflection", "reflection", "Reflect", "Why did this count as headless?", "Ask about harness and job.");
  await writeBlock(first, "transition", "narrative", "Finish", "Move to the next lesson.");
  await writeLesson(second, "Second lesson", ["second-orientation", "second-finish"]);
  await writeBlock(second, "second-orientation", "narrative", "Second orientation", "Second lesson starts here.");
  await writeBlock(second, "second-finish", "narrative", "Second finish", "Second lesson done.");
  const firstWorkspace = options.firstLessonWorkspace ?? "refactor-line";
  await mkdir(resolve(dir, "workspaces", firstWorkspace, "factory"), { recursive: true });
  await writeFile(resolve(dir, "workspaces", firstWorkspace, "factory/answer.md"), "authored answer\n", "utf8");
  if (firstWorkspace === "refactor-line") {
    await mkdir(resolve(dir, "workspaces/refactor-line/calculator"), { recursive: true });
    await writeFile(resolve(dir, "workspaces/refactor-line/calculator/package.json"), "{\"type\":\"module\"}\n", "utf8");
  }
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
}

async function sessionFixture() {
  const dir = await fixture();
  await mkdir(resolve(dir, "workspaces/refactor-line/calculator/src"), { recursive: true });
  await writeFile(resolve(dir, "workspaces/refactor-line/calculator/src/index.ts"), "export const value = 1;\n", "utf8");
  const session = await (await SessionWorkspaceManager.create(dir)).createSession({ id: "runtime-split" });
  return { dir, session };
}

async function writeLesson(lessonDir: string, title: string, blocks: string[], introduction = "Fixture lesson introduction.", workspace?: string) {
  await writeFile(resolve(lessonDir, "lesson.md"), [
    "---",
    "durationMinutes: 10",
    ...(workspace ? [`workspace: ${workspace}`] : []),
    "blocks:",
    ...blocks.map((id) => `  - ${id}`),
    "---",
    `# ${title}`,
    "",
    `${title} dek.`,
    ...(introduction ? ["", introduction] : []),
  ].join("\n"));
}

async function writeBlock(lessonDir: string, id: string, type: string, title: string, markdown: string, tutor?: string, path?: string) {
  const interactive = type === "terminal-practice" || type === "editor-practice" || type === "reflection";
  await writeFile(resolve(lessonDir, `blocks/${id}.md`), [
    "---",
    `type: ${type}`,
    ...(path ? [`path: ${JSON.stringify(path)}`] : []),
    ...(interactive ? [`outcome: Fixture block outcome for ${id}.`] : []),
    ...(tutor ? [`tutor: ${JSON.stringify(tutor)}`] : []),
    "---",
    `## ${title}`,
    "",
    markdown,
  ].join("\n"));
}

function bashCommandMarker(command: string): string {
  return `\x1b]633;workbook-command;${Buffer.from(command).toString("base64")}\x07`;
}
function bashFinishedMarker(exitStatus = 0): string {
  return `\x1b]633;workbook-finished;${exitStatus}\x07`;
}

/** A controlled Bash shell double: only tests opting out see raw PTY text without authoritative markers. */
class ServerFakePty implements TerminalPty {
  writes: string[] = [];
  killed = false;
  data?: (data: string) => void;
  exit?: (event: { exitCode: number }) => void;
  constructor(private readonly autoMarkers = true) {}
  write(data: string): void {
    this.writes.push(data);
    if (!this.autoMarkers) {
      this.data?.(`\r\nran:${data}`);
      return;
    }
    const command = data.replace(/[\r\n]+$/, "");
    this.data?.(`${bashCommandMarker(command)}\r\nran:${data}${bashFinishedMarker()}`);
  }
  resize(): void {}
  kill(): void { this.killed = true; }
  onData(callback: (data: string) => void): void { this.data = callback; }
  onExit(callback: (event: { exitCode: number }) => void): void { this.exit = callback; }
}

/** Deterministic timeout seam: models are fakes and tests trigger assessment timeouts explicitly. */
class FakeTerminalAssessmentScheduler {
  #next = 0;
  #pending = new Map<number, () => void>();
  schedule(_delayMs: number, callback: () => void): number {
    const handle = ++this.#next;
    this.#pending.set(handle, callback);
    return handle;
  }
  cancel(handle: unknown): void { this.#pending.delete(handle as number); }
  runNext(): void {
    const next = this.#pending.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("No terminal assessment timeout is scheduled.");
    this.#pending.delete(next[0]);
    next[1]();
  }
  get pending(): number { return this.#pending.size; }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

interface TerminalFrameWaiter { predicate(message: any): boolean; resolve(message: any): void; }
interface TerminalFrameBuffer { frames: any[]; waiters: TerminalFrameWaiter[]; }
const terminalFramesBySocket = new WeakMap<WebSocket, TerminalFrameBuffer>();

function connect(url: string, origin?: string): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/api/workbook/terminal", origin ? { headers: { Origin: origin } } : undefined);
    const buffer: TerminalFrameBuffer = { frames: [], waiters: [] };
    terminalFramesBySocket.set(ws, buffer);
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const matchingWaiters = buffer.waiters.filter((waiter) => waiter.predicate(message));
      if (matchingWaiters.length > 0) {
        buffer.waiters = buffer.waiters.filter((waiter) => !matchingWaiters.includes(waiter));
        for (const waiter of matchingWaiters) waiter.resolve(message);
      } else {
        buffer.frames.push(message);
      }
    });
    ws.once("open", () => resolvePromise(ws));
    ws.once("error", reject);
  });
}

function waitFor(ws: WebSocket, predicate: (message: any) => boolean): Promise<any> {
  const buffer = terminalFramesBySocket.get(ws);
  const bufferedIndex = buffer?.frames.findIndex(predicate) ?? -1;
  if (buffer && bufferedIndex >= 0) return Promise.resolve(buffer.frames.splice(bufferedIndex, 1)[0]);
  return new Promise((resolvePromise) => {
    if (buffer) buffer.waiters.push({ predicate, resolve: resolvePromise });
    else ws.on("message", (data) => { const message = JSON.parse(data.toString()); if (predicate(message)) resolvePromise(message); });
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

async function postRetry(serverUrl: string, body: unknown) {
  return fetch(`${serverUrl}/api/workbook/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
  return JSON.parse(match[1]!);
}
async function nextSseEvent(serverUrl: string, eventName: string): Promise<any> {
  const controller = new AbortController();
  const response = await fetch(`${serverUrl}/api/workbook/timeline`, { signal: controller.signal });
  if (!response.body) throw new Error("Timeline stream did not expose a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      const events = text.split("\n\n").filter(Boolean);
      for (const event of events) {
        const match = event.match(/^event: (.+)\ndata: (.*)$/s);
        if (match?.[1] === eventName) return JSON.parse(match[2]!);
      }
    }
    throw new Error(`Timed out waiting for ${eventName}. Saw: ${text}`);
  } finally {
    await reader.cancel().catch(() => undefined);
    controller.abort();
  }
}
function fakeContentWatchFactory() {
  const listeners = new Map<string, (eventType: string, filename: string | Buffer | null) => void>();
  const closed: string[] = [];
  const factory: ContentWatchFactory = (path, listener) => { listeners.set(path, listener); return { close: () => closed.push(path) }; };
  return { factory, listeners, closed, emit: (dir: string, filename: string) => listeners.get(dir)?.("change", filename) };
}
async function waitForWatchPath(fake: ReturnType<typeof fakeContentWatchFactory>, path: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (fake.listeners.has(path)) return;
    await waitMs(5);
  }
  throw new Error(`Timed out waiting for watch subscription ${path}`);
}
function timelineRecord(sequence: number, input: Record<string, unknown>): Record<string, unknown> {
  return { id: `fixture-event-${sequence}`, sequence, at: `2026-08-21T00:00:${String(sequence).padStart(2, "0")}.000Z`, ...input };
}
function currentTimelineText(rows: Record<string, unknown>[]): string {
  return [workbookSessionFormatRecord(), ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n";
}
async function privateTimeline(workspaceOrSessionRoot: string): Promise<WorkbookTimelineRecord[]> {
  let text: string;
  try {
    text = await readFile(tutorialSessionStatePath(workspaceOrSessionRoot, "workbook/events.jsonl"), "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    text = await readFile(tutorialStatePath(workspaceOrSessionRoot, "workbook", "events.jsonl"), "utf8");
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.type !== "workbook-session-format") as WorkbookTimelineRecord[];
}
async function completeBlock(serverUrl: string, blockId: string) {
  return fetch(`${serverUrl}/api/workbook/complete-block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId }) });
}
async function continueActive(serverUrl: string) {
  const current = await state(serverUrl);
  return completeBlock(serverUrl, current.progress.activeBlockId);
}
async function introduceAndOpenEditor(serverUrl: string) {
  await completeBlock(serverUrl, "workbook--introduction");
  await continueActive(serverUrl); // part preamble
  await continueActive(serverUrl); // lesson preamble
  await completeBlock(serverUrl, "lesson--001-first--orientation");
}
function canonicalTestBlockId(blockId: string) { return blockId.includes("--") ? blockId : `lesson--001-first--${blockId}`; }
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
async function waitForPrivateTimeline(workspaceOrSessionRoot: string, predicate: (records: WorkbookTimelineRecord[]) => boolean, description: string) {
  const deadline = Date.now() + 1_500;
  let latest: WorkbookTimelineRecord[] = [];
  while (Date.now() < deadline) {
    latest = await privateTimeline(workspaceOrSessionRoot).catch(() => latest);
    if (predicate(latest)) return latest;
    await waitMs(10);
  }
  throw new Error(`Timed out waiting for ${description}. Last records: ${JSON.stringify(latest)}`);
}
function block(state: any, blockId: string) { return state.progress.blocks.find((candidate: any) => candidate.id === blockId || candidate.declaredId === blockId || candidate.id.endsWith(`--${blockId}`)); }

async function acceptEditor(serverUrl: string, tutor: FakeMainTutor, text = "factory acceptance marker") {
  if (!tutor.queue.some((entry) => !(entry instanceof Error) && typeof entry === "object" && "message" in entry && entry.message === "Editor accepted.")) tutor.queue.unshift({ outcome: "accepted", message: "Editor accepted." });
  const blockId = canonicalTestBlockId("lesson--001-first--edit-answer");
  expect((await postEditor(serverUrl, { blockId, text })).status).toBe(202);
  await waitForWorkbookState(serverUrl, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted", "editor acceptance");
  expect((await completeBlock(serverUrl, blockId)).status).toBe(202);
}

function terminalReviewTranscript(review: { attempt: Attempt }): string {
  if (review.attempt.evidence.kind !== "terminal") throw new Error("Expected a terminal review.");
  return review.attempt.evidence.transcript;
}

async function submitTerminalAttempt(serverUrl: string, blockId: string) {
  const ws = await connect(serverUrl, serverUrl);
  // Observation-mode terminals do not manufacture legacy socket submission frames. The controlled
  // Bash marker emits the same safe output a browser would receive, then the workflow owns review.
  const command = `run ${blockId}`;
  const output = waitFor(ws, (message) => message.type === "output" && message.data.includes(`ran:${command}`));
  ws.send(JSON.stringify({ type: "input", data: `${command}\r` }));
  await output;
  ws.close();
}

async function tryStartWorkbookServer(options: Parameters<typeof startWorkbookServer>[0]) {
  let server: Awaited<ReturnType<typeof startWorkbookServer>> | undefined;
  let error: unknown;
  try { server = await startWorkbookServer(options); }
  catch (caught) { error = caught; }
  finally { await server?.close(); }
  return { started: !!server, error };
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
  it("rejects forged session workspace roots instead of trusting arbitrary host paths", async () => {
    const { dir, session } = await sessionFixture();
    const outside = await mkdtemp(resolve(tmpdir(), "forged-workspace-")); dirs.push(outside);
    await mkdir(resolve(outside, ".git"), { recursive: true });

    const result = await tryStartWorkbookServer({
      target: dir,
      session: { ...session, workspaceRoots: { ...session.workspaceRoots, "refactor-line": outside } },
      webRoot: resolve(dir, "web"),
      port: 0,
      embeddedTerminal: false,
      mainTutor: new FakeMainTutor(),
          });

    expect(result.started).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/refactor-line|workspace root|does not match/i);
  });

  it("rejects escaping session roots and invalid workspace IDs before startup", async () => {
    const escaping = await sessionFixture();
    const outside = await mkdtemp(resolve(tmpdir(), "escaping-workspaces-")); dirs.push(outside);
    await mkdir(resolve(outside, "refactor-line/.git"), { recursive: true });
    const escapingResult = await tryStartWorkbookServer({
      target: escaping.dir,
      session: { ...escaping.session, workspacesRoot: outside, workspaceRoots: { "refactor-line": resolve(outside, "refactor-line") } },
      webRoot: resolve(escaping.dir, "web"),
      port: 0,
      embeddedTerminal: false,
      mainTutor: new FakeMainTutor(),
          });
    expect(escapingResult.started).toBe(false);
    expect((escapingResult.error as Error).message).toMatch(/workspaces root|session.*workspace/i);

    const invalid = await sessionFixture();
    const invalidResult = await tryStartWorkbookServer({
      target: invalid.dir,
      session: { ...invalid.session, workspaceRoots: { ...invalid.session.workspaceRoots, "../escape": invalid.session.workspaceRoots["refactor-line"]! } },
      webRoot: resolve(invalid.dir, "web"),
      port: 0,
      embeddedTerminal: false,
      mainTutor: new FakeMainTutor(),
          });
    expect(invalidResult.started).toBe(false);
    expect((invalidResult.error as Error).message).toMatch(/workspace.*id|lowercase-hyphenated/i);
  });

  it("rejects missing, extra, and symlinked session workspace roots before startup", async () => {
    const missing = await sessionFixture();
    const missingResult = await tryStartWorkbookServer({
      target: missing.dir,
      session: { ...missing.session, workspaceRoots: {} },
      webRoot: resolve(missing.dir, "web"),
      port: 0,
      embeddedTerminal: false,
      mainTutor: new FakeMainTutor(),
          });
    expect(missingResult.started).toBe(false);
    expect((missingResult.error as Error).message).toMatch(/missing.*refactor-line|refactor-line.*missing/i);

    const extra = await sessionFixture();
    const extraRoot = resolve(extra.session.workspacesRoot, "extra-space");
    await mkdir(resolve(extraRoot, ".git"), { recursive: true });
    const extraResult = await tryStartWorkbookServer({
      target: extra.dir,
      session: { ...extra.session, workspaceRoots: { ...extra.session.workspaceRoots, "extra-space": extraRoot } },
      webRoot: resolve(extra.dir, "web"),
      port: 0,
      embeddedTerminal: false,
      mainTutor: new FakeMainTutor(),
          });
    expect(extraResult.started).toBe(false);
    expect((extraResult.error as Error).message).toMatch(/extra-space|extra/i);

    const symlinked = await sessionFixture();
    const outside = await mkdtemp(resolve(tmpdir(), "symlinked-workspace-")); dirs.push(outside);
    await rm(symlinked.session.workspaceRoots["refactor-line"]!, { recursive: true, force: true });
    await symlink(outside, symlinked.session.workspaceRoots["refactor-line"]!);
    const symlinkResult = await tryStartWorkbookServer({
      target: symlinked.dir,
      session: symlinked.session,
      webRoot: resolve(symlinked.dir, "web"),
      port: 0,
      embeddedTerminal: false,
      mainTutor: new FakeMainTutor(),
          });
    expect(symlinkResult.started).toBe(false);
    expect((symlinkResult.error as Error).message).toMatch(/symlink|real directory/i);
  });

  it("hot reloads authored prose in place while retaining progress, attempts, and learner workspace files", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const tutor = new FakeMainTutor({ outcome: "feedback", message: "Old feedback." });
    await writeFile(resolve(session.workspaceRoots["refactor-line"]!, "factory/sentinel.txt"), "keep me\n", "utf8");
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, mainTutor: tutor });
    try {
      await waitForWatchPath(fakeWatch, resolve(session.contentRoot, "lessons/001-first"));
      await waitForWatchPath(fakeWatch, resolve(session.contentRoot, "lessons/001-first/blocks"));
      await introduceAndOpenEditor(server.url);
      const before = await state(server.url);
      expect(before.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      expect(before.introductionComplete).toBe(true);
      const authoredBefore = before.timeline.find((record: any) => record.type === "message" && record.source === "authored" && record.blockId === "lesson--001-first--edit-answer");
      expect(authoredBefore?.text).toContain("Write the answer in the editor.");

      expect((await postMessage(server.url, { blockId: "lesson--001-first--edit-answer", text: "I'm still here." })).status).toBe(202);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "draft before reload" })).status).toBe(202);
      await waitForWorkbookState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "feedback", "editor feedback before reload");

      const reloaded = nextSseEvent(server.url, "content-reloaded");
      await writeBlock(resolve(dir, "lessons/001-first"), "edit-answer", "editor-practice", "Edit", "Write the refreshed answer in the editor.", "Private editor rubric: require the refreshed marker.", "factory/answer.md");
      fakeWatch.emit(resolve(session.contentRoot, "lessons/001-first/blocks"), "edit-answer.md");
      await reloaded;

      const next = await state(server.url);
      expect(next.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      expect(next.introductionComplete).toBe(true);
      expect(next.progress.completedBlocks).toEqual(before.progress.completedBlocks);
      expect(next.timeline?.filter((record: any) => record.type === "message" && record.source === "learner").map((record: any) => record.text)).toContain("I'm still here.");
      expect(block(next, "lesson--001-first--edit-answer")?.checkpoint?.status).toBe("feedback");
      await expect(readFile(resolve(session.workspaceRoots["refactor-line"]!, "factory/sentinel.txt"), "utf8")).resolves.toBe("keep me\n");
      await expect(access(resolve(session.workspaceRoots["refactor-line"]!, ".git"))).resolves.toBeUndefined();

      const authoredAfter = next.timeline.find((record: any) => record.type === "message" && record.source === "authored" && record.blockId === "lesson--001-first--edit-answer");
      expect(authoredAfter?.id).toBe(authoredBefore.id);
      expect(authoredAfter?.text).toContain("Write the refreshed answer in the editor.");
      expect(authoredAfter?.text).not.toContain("Write the answer in the editor.");
      const activeBlock = next.chapters[0].lesson.blocks.find((candidate: any) => candidate.id === "lesson--001-first--edit-answer");
      expect(activeBlock.markdown).toBe("Write the refreshed answer in the editor.");
      expect(tutor.restores.at(-1)?.activeContext).toMatchObject({ blockId: "lesson--001-first--edit-answer", markdown: "Write the refreshed answer in the editor.", authorGuidance: "Private editor rubric: require the refreshed marker." });
      const privateRecords = await privateTimeline(session.sessionRoot);
      expect(privateRecords.filter((record: any) => record.type === "session_started")).toHaveLength(1);
    } finally { await server.close(); }
  });

  it("keeps a server-submitted accepted attempt completable after a content reload", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted before reload." });
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, mainTutor: tutor });
    try {
      await waitForWatchPath(fakeWatch, resolve(session.contentRoot, "lessons/001-first/blocks"));
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "factory acceptance marker" })).status).toBe(202);
      await waitForWorkbookState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted", "editor acceptance before reload");

      const reloaded = nextSseEvent(server.url, "content-reloaded");
      await writeBlock(resolve(dir, "lessons/001-first"), "edit-answer", "editor-practice", "Edit", "Reloaded editor instructions.", "Private editor rubric: mention the factory acceptance marker.", "factory/answer.md");
      fakeWatch.emit(resolve(session.contentRoot, "lessons/001-first/blocks"), "edit-answer.md");
      await reloaded;

      const restored = await state(server.url);
      expect(block(restored, "lesson--001-first--edit-answer")).toMatchObject({ checkpoint: { status: "accepted" }, workAccepted: true });
      expect(restored.progress.readyBlocks).toContain("lesson--001-first--run-supplied-command");
      const completed = await completeBlock(server.url, "lesson--001-first--edit-answer").then((response) => response.json() as Promise<any>);
      expect(completed).toMatchObject({ outcome: "completed", state: { progress: { activeBlockId: "lesson--001-first--run-supplied-command" } } });
    } finally { await server.close(); }
  });

  it("falls back to the next valid block when a structural reload removes the current block", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, mainTutor: new FakeMainTutor() });
    try {
      await waitForWatchPath(fakeWatch, resolve(session.contentRoot, "lessons/001-first"));
      await introduceAndOpenEditor(server.url);
      const before = await state(server.url);
      expect(before.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      expect(before.progress.completedBlocks).toContain("lesson--001-first--orientation");

      const reloaded = nextSseEvent(server.url, "content-reloaded");
      await rm(resolve(dir, "lessons/001-first/blocks/edit-answer.md"));
      await writeLesson(resolve(dir, "lessons/001-first"), "First lesson", ["orientation", "run-supplied-command", "change-job", "reflection", "transition"], "Fixture lesson introduction.", "refactor-line");
      fakeWatch.emit(resolve(session.contentRoot, "lessons/001-first"), "lesson.md");
      await reloaded;

      const next = await state(server.url);
      expect(next.progress.activeBlockId).toBe("lesson--001-first--run-supplied-command");
      expect(next.progress.completedBlocks).toContain("lesson--001-first--orientation");
      expect(next.orderedBlocks.map((entry: any) => entry.id)).not.toContain("lesson--001-first--edit-answer");
      expect(next.timeline.some((record: any) => record.type === "message" && record.source === "authored" && record.blockId === "lesson--001-first--edit-answer")).toBe(false);
    } finally { await server.close(); }
  });

  it("hot reloads lesson topology changes and rescans new block directories", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, mainTutor: new FakeMainTutor() });
    try {
      await waitForWatchPath(fakeWatch, session.contentRoot);
      await mkdir(resolve(dir, "lessons/003-third/blocks"), { recursive: true });
      await writeLesson(resolve(dir, "lessons/003-third"), "Third lesson", ["third-orientation"]);
      await writeBlock(resolve(dir, "lessons/003-third"), "third-orientation", "narrative", "Third orientation", "New topology block.");
      const reloaded = nextSseEvent(server.url, "content-reloaded");
      await writeFile(resolve(dir, "workbook.md"), [
        "---",
        "parts:",
        "  - id: loop",
        "    lessons:",
        "      - 001-first",
        "      - 002-second",
        "      - 003-third",
        "---",
        "# Fixture workbook",
        "",
        "Welcome to the fixture workbook.",
      ].join("\n"), "utf8");
      fakeWatch.emit(session.contentRoot, "workbook.md");
      await reloaded;

      const next = await state(server.url);
      expect(next.progress.activeBlockId).toBe("workbook--introduction");
      expect(next.orderedBlocks.map((entry: any) => entry.id)).toContain("lesson--003-third--third-orientation");
      await waitForWatchPath(fakeWatch, resolve(session.contentRoot, "lessons/003-third/blocks"));
    } finally { await server.close(); }
  });

  it("rejects hot reloads that add an interactive workspace missing from the running session", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, mainTutor: new FakeMainTutor() });
    try {
      await waitForWatchPath(fakeWatch, session.contentRoot);
      const before = await state(server.url);
      expect(before.orderedBlocks.map((entry: any) => entry.id)).not.toContain("lesson--003-third--new-editor");

      await mkdir(resolve(dir, "lessons/003-third/blocks"), { recursive: true });
      await writeLesson(resolve(dir, "lessons/003-third"), "Third lesson", ["new-editor"], "New workspace lesson.", "new-workspace");
      await writeBlock(resolve(dir, "lessons/003-third"), "new-editor", "editor-practice", "New editor", "Edit in a new live workspace.", "Private new workspace rubric.", "answer.md");
      const rejected = nextSseEvent(server.url, "content-reload-error");
      await writeFile(resolve(dir, "workbook.md"), [
        "---",
        "parts:",
        "  - id: loop",
        "    lessons:",
        "      - 001-first",
        "      - 002-second",
        "      - 003-third",
        "---",
        "# Fixture workbook",
        "",
        "Welcome to the fixture workbook.",
      ].join("\n"), "utf8");
      fakeWatch.emit(session.contentRoot, "workbook.md");
      const error = await rejected;
      expect(error.message).toMatch(/new-workspace|start a new session/i);

      const after = await state(server.url);
      expect(after.workbook.title).toBe(before.workbook.title);
      expect(after.orderedBlocks.map((entry: any) => entry.id)).not.toContain("lesson--003-third--new-editor");
      await expect(access(resolve(session.workspacesRoot, "new-workspace"))).rejects.toThrow();
    } finally { await server.close(); }
  });

  it("keeps the last valid workbook through reload errors and recovers on the next valid save", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, mainTutor: new FakeMainTutor() });
    try {
      await waitForWatchPath(fakeWatch, session.contentRoot);
      const invalid = nextSseEvent(server.url, "content-reload-error");
      await writeFile(resolve(dir, "workbook.md"), "---\ntitle: Broken\n# missing closing front matter\n", "utf8");
      fakeWatch.emit(session.contentRoot, "workbook.md");
      const error = await invalid;
      expect(error.message).toMatch(/front matter|workbook\.md/i);
      expect((await state(server.url)).workbook.title).toBe("Fixture workbook");

      const recovered = nextSseEvent(server.url, "content-reloaded");
      await writeFile(resolve(dir, "workbook.md"), [
        "---",
        "parts:",
        "  - id: loop",
        "    lessons:",
        "      - 001-first",
        "      - 002-second",
        "---",
        "# Recovered workbook",
        "",
        "Recovered introduction.",
      ].join("\n"), "utf8");
      fakeWatch.emit(session.contentRoot, "workbook.md");
      await recovered;
      const next = await state(server.url);
      expect(next.workbook.title).toBe("Recovered workbook");
      expect(next.introduction).toBe("Recovered introduction.");
    } finally { await server.close(); }
  });

  it("does not let a delayed review from before hot reload write into the new generation", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const pending = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(pending.promise);
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, mainTutor: tutor });
    try {
      await waitForWatchPath(fakeWatch, session.contentRoot);
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "old draft" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 1, "review to start before reload");

      const reloaded = nextSseEvent(server.url, "content-reloaded");
      await writeFile(resolve(dir, "workbook.md"), (await readFile(resolve(dir, "workbook.md"), "utf8")).replace("Welcome to the fixture workbook.", "Reloaded introduction."), "utf8");
      fakeWatch.emit(session.contentRoot, "workbook.md");
      await reloaded;

      pending.resolve({ outcome: "accepted", message: "Old review accepted." });
      await waitMs(20);
      const next = await state(server.url);
      expect(JSON.stringify(next.timeline)).not.toContain("Old review accepted");
      expect(next.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      const privateRecords = (await readFile(tutorialSessionStatePath(session.sessionRoot, "workbook/events.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      expect(privateRecords.some((record: any) => record.type === "attempt_accepted")).toBe(false);
    } finally { await server.close(); }
  });

  it("ignores a stale editor revision submitted after a newer one so only the latest can unlock", async () => {
    const { dir, session } = await sessionFixture();
    const latestDecision = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(latestDecision.promise, { outcome: "accepted", message: "Old stale review accepted." });
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", revision: 2, text: "newest draft" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => tutor.reviews.length === 1, "latest editor review to start");

      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", revision: 1, text: "stale old draft" })).status).toBe(202);
      await waitMs(20);
      expect(tutor.reviews).toHaveLength(1);
      expect(tutor.reviews[0]!.attempt.version).toBe(2);
      expect(tutor.reviews[0]!.attempt.evidence).toMatchObject({ kind: "editor", text: "newest draft" });

      latestDecision.resolve({ outcome: "accepted", message: "Latest review accepted." });
      const accepted = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "latest editor acceptance");
      expect(block(accepted, "edit-answer")?.revision).toBe(2);
      expect(block(accepted, "edit-answer")?.checkpoint?.successMessage).toBe("Latest review accepted.");
      await expect(readFile(resolve(session.workspaceRoots["refactor-line"]!, "factory/answer.md"), "utf8")).resolves.toBe("newest draft");
    } finally { await server.close(); }
  });

  it("retains prior editor feedback while a newer review is pending and when that provider fails", async () => {
    const { dir, session } = await sessionFixture();
    const providerFailure = deferred<TutorDecision>();
    const nextPendingReview = deferred<TutorDecision>();
    const tutor = new FakeMainTutor({ outcome: "feedback", message: "Mention the factory acceptance marker." }, providerFailure.promise, nextPendingReview.promise);
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", revision: 1, text: "first draft" })).status).toBe(202);
      const firstFeedback = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "feedback", "first editor feedback");
      expect(block(firstFeedback, "edit-answer")?.checkpoint?.feedback).toBe("Mention the factory acceptance marker.");

      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", revision: 2, text: "second draft" })).status).toBe(202);
      const reviewing = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "reviewing", "second editor reviewing");
      expect(block(reviewing, "edit-answer")?.checkpoint?.feedback).toBe("Mention the factory acceptance marker.");
      expect(block(reviewing, "edit-answer")?.checkpoint?.reviewNotice).toMatch(/updating feedback/i);

      providerFailure.reject(new Error("provider down"));
      const failed = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.reviewNotice?.match(/temporarily unavailable/i), "failed editor review retaining feedback");
      expect(block(failed, "edit-answer")?.checkpoint?.feedback).toBe("Mention the factory acceptance marker.");
      expect(block(failed, "edit-answer")?.checkpoint?.status).toBe("feedback");
      expect(block(failed, "edit-answer")?.checkpoint?.reviewNotice).toMatch(/try another attempt/i);

      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", revision: 3, text: "third draft" })).status).toBe(202);
      const pendingAfterFailure = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.revision === 3 && block(next, "edit-answer")?.checkpoint?.status === "reviewing", "third editor review pending after failure");
      expect(block(pendingAfterFailure, "edit-answer")?.checkpoint?.feedback).toBe("Mention the factory acceptance marker.");
      expect(block(pendingAfterFailure, "edit-answer")?.checkpoint?.reviewNotice).toMatch(/updating feedback/i);
      expect(block(pendingAfterFailure, "edit-answer")?.checkpoint?.feedback).not.toMatch(/temporarily unavailable/i);
      nextPendingReview.resolve({ outcome: "feedback", message: "Now mention the marker and batch size." });
    } finally { await server.close(); }
  });

  it("keeps scoped lesson workspace private while editor attempts resolve beneath it", async () => {
    const dir = await fixture({ editorPath: "answer.md", firstLessonWorkspace: "scoped-lesson" });
    const session = await (await SessionWorkspaceManager.create(dir)).createSession({ id: "scoped-runtime" });
    const tutor = new FakeMainTutor();
    tutor.queue.push({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      const opened = await state(server.url);
      expect(JSON.stringify(opened)).not.toContain("workspaces/scoped-lesson");
      expect(block(opened, "edit-answer")?.draftText).toBe("");

      await postEditor(server.url, { blockId: "edit-answer", text: "scoped learner answer" });
      const accepted = await waitForWorkbookState(server.url, (value) => block(value, "edit-answer")?.checkpoint?.status === "accepted", "accepted scoped editor attempt");

      expect(JSON.stringify(accepted)).not.toContain("workspaces/scoped-lesson");
      expect(block(accepted, "edit-answer")?.checkpoint.evidence.text).toBe("scoped learner answer");
      await expect(readFile(resolve(session.workspaceRoots["scoped-lesson"]!, "answer.md"), "utf8")).resolves.toBe("scoped learner answer");
      await expect(access(resolve(session.workspacesRoot, "refactor-line/answer.md"))).rejects.toThrow();
      await expect(readFile(resolve(dir, "workspaces/scoped-lesson/factory/answer.md"), "utf8")).resolves.toBe("authored answer\n");
    } finally { await server.close(); }
  });

  it("exposes a fresh seeded spec.md and accepts unchanged content through one review", async () => {
    const dir = await fixture({ editorPath: "spec.md", firstLessonWorkspace: "scoped-lesson" });
    const seededText = "seeded spec.md draft";
    await writeFile(resolve(dir, "workspaces/scoped-lesson/spec.md"), seededText, "utf8");
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Accepted editor answer." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      const opened = await state(server.url);
      expect(block(opened, "edit-answer")).toMatchObject({ revision: 0, draftText: seededText });

      const draft = await postEditor(server.url, { blockId: "edit-answer", text: seededText });
      expect(draft.status).toBe(202);
      const accepted = await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "seeded editor acceptance");
      expect(tutor.reviews).toHaveLength(1);
      expect(tutor.reviews[0]!.attempt.evidence).toMatchObject({ kind: "editor", text: seededText });
      expect(await readFile(resolve(dir, "workspaces/scoped-lesson/spec.md"), "utf8")).toBe(seededText);
      expect(block(accepted, "edit-answer")).toMatchObject({ revision: 1 });
      await waitForPrivateTimeline(dir, (records) => records.filter((record) => record.type === "message" && record.blockId === "lesson--001-first--edit-answer" && record.presentation === "review" && record.text === "Accepted editor answer.").length === 1, "the seeded editor review record");
    } finally { await server.close(); }
  });

  it("starts a scoped terminal block in its lesson workspace", async () => {
    const dir = await fixture({ firstLessonWorkspace: "scoped-lesson" });
    await mkdir(resolve(dir, "workspaces/scoped-lesson"), { recursive: true });
    const ptys: ServerFakePty[] = [];
    const optionsSeen: terminalModule.TerminalPtyOptions[] = [];
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({
      target: dir,
      webRoot: resolve(dir, "web"),
      port: 0,
      terminalPtyFactory: (options) => { optionsSeen.push(options); const pty = new ServerFakePty(false); ptys.push(pty); return pty; },
      mainTutor: tutor,
          });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      const active = await state(server.url);
      expect(block(active, "run-supplied-command")?.active).toBe(true);
      const ws = await connect(server.url, server.url);
      ws.send(JSON.stringify({ type: "input", data: "pwd\r" }));
      await waitMs(20);
      ws.close();

      expect(optionsSeen.map((options) => options.containerWorkdir)).toContain("/workspace");
      expect(ptys.at(-1)?.writes).toEqual(["pwd\r"]);
    } finally { await server.close(); }
  });

  it("keeps authored content read-only while editor attempts and workbook state use the session roots", async () => {
    const { dir, session } = await sessionFixture();
    const tutor = new FakeMainTutor();
    tutor.queue.push({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await postEditor(server.url, { blockId: "edit-answer", text: "learner answer with factory acceptance marker" });
      await waitForWorkbookState(server.url, (value) => block(value, "edit-answer")?.checkpoint?.status === "accepted", "accepted session-root editor attempt");

      await expect(readFile(resolve(dir, "workspaces/refactor-line/factory/answer.md"), "utf8")).resolves.toBe("authored answer\n");
      await expect(readFile(resolve(session.workspaceRoots["refactor-line"]!, "factory/answer.md"), "utf8")).resolves.toBe("learner answer with factory acceptance marker");
      await expect(readFile(tutorialSessionStatePath(session.sessionRoot, "workbook/events.jsonl"), "utf8")).resolves.toContain("session_started");
      await expect(readFile(tutorialSessionStatePath(session.sessionRoot, "workbook/attempts/by-id", tutor.reviews[0]!.attempt.id + ".json"), "utf8")).resolves.toContain(tutor.reviews[0]!.attempt.id);
      await expect(access(tutorialStatePath(dir, "workbook", "events.jsonl"))).rejects.toThrow();
    } finally { await server.close(); }
  });

  it("prestarts embedded terminals in the learner workspace with session-local Git and disposes them on close", async () => {
    const { dir, session } = await sessionFixture();
    const pty = new ServerFakePty();
    let terminalOptions: any;
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: (options) => { terminalOptions = options; return pty; }, terminalDebounceMs: 1, mainTutor: tutor });
    expect(terminalOptions).toBeUndefined();
    expect(pty.writes).toEqual([]);
    try {
      await introduceAndOpenEditor(server.url);
      await postEditor(server.url, { blockId: "edit-answer", text: "draft" });
      await waitForWorkbookState(server.url, (value) => block(value, "edit-answer")?.checkpoint?.status === "accepted", "accepted editor before terminal");
      await postEvent(server.url, { blockId: "edit-answer", action: "continue" });
      const ws = await connect(server.url);
      await waitMs(20);
      ws.close();
      await expect(access(resolve(session.workspaceRoots["refactor-line"]!, ".git"))).resolves.toBeUndefined();
      await expect(access(resolve(dir, ".git"))).rejects.toThrow();
    } finally { await server.close(); }
    expect(pty.killed).toBe(true);
  });

  it("returns the committed completeBlock transition when terminal prestart fails", async () => {
    const dir = await fixture();
    let starts = 0;
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({
      target: dir,
      webRoot: resolve(dir, "web"),
      port: 0,
      terminalPtyFactory: () => { starts += 1; throw new Error("PTY factory failed"); },
      mainTutor: tutor,
          });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "factory acceptance marker" })).status).toBe(202);
      await waitForWorkbookState(server.url, (value) => block(value, "edit-answer")?.checkpoint?.status === "accepted", "accepted editor before failed terminal prestart");

      const response = await completeBlock(server.url, "lesson--001-first--edit-answer");
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ outcome: "completed", state: { progress: { activeBlockId: "lesson--001-first--run-supplied-command" } } });
      expect(starts).toBeGreaterThan(0);

      const ws = await connect(server.url, server.url);
      const terminalError = await waitFor(ws, (message) => message.type === "terminal-error");
      expect(terminalError.message).toMatch(/embedded terminal could not start/i);
      ws.close();
    } finally { await server.close(); }
  });

  it("returns the committed submitEvent transition when terminal prestart fails", async () => {
    const dir = await fixture();
    let starts = 0;
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({
      target: dir,
      webRoot: resolve(dir, "web"),
      port: 0,
      terminalPtyFactory: () => { starts += 1; throw new Error("PTY factory failed"); },
      mainTutor: tutor,
          });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "edit-answer", text: "factory acceptance marker" })).status).toBe(202);
      await waitForWorkbookState(server.url, (value) => block(value, "edit-answer")?.checkpoint?.status === "accepted", "accepted editor before failed terminal event prestart");

      const response = await postEvent(server.url, { blockId: "edit-answer", action: "continue" });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ progress: { activeBlockId: "lesson--001-first--run-supplied-command" } });
      expect(starts).toBeGreaterThan(0);
    } finally { await server.close(); }
  });

  it("preserves an active terminal across watched prose-only reloads of the same block and workspace", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const ptys: ServerFakePty[] = [];
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, terminalPtyFactory: () => { const pty = new ServerFakePty(); ptys.push(pty); return pty; }, mainTutor: tutor });
    try {
      await waitForWatchPath(fakeWatch, resolve(session.contentRoot, "lessons/001-first/blocks"));
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      const ws = await connect(server.url, server.url);
      let closed = false;
      ws.once("close", () => { closed = true; });

      const reloaded = nextSseEvent(server.url, "content-reloaded");
      await writeBlock(resolve(dir, "lessons/001-first"), "run-supplied-command", "terminal-practice", "Run", "Reloaded terminal prose.", "Observe run result.");
      fakeWatch.emit(resolve(session.contentRoot, "lessons/001-first/blocks"), "run-supplied-command.md");
      await reloaded;
      await waitMs(20);
      expect(ptys).toHaveLength(1);
      expect(ptys[0]!.killed).toBe(false);
      expect(closed).toBe(false);

      const output = waitFor(ws, (message) => message.type === "output" && message.data.includes("ran:after reload"));
      ws.send(JSON.stringify({ type: "input", data: "after reload\r" }));
      await output;
      expect(ptys).toHaveLength(1);
      expect(ptys[0]!.writes).toContain("after reload\r");
      ws.close();
    } finally { await server.close(); }
  });

  it("reconciles watched reloads by closing a terminal whose active block changed and ignoring its stale output", async () => {
    const { dir, session } = await sessionFixture();
    const fakeWatch = fakeContentWatchFactory();
    const ptys: ServerFakePty[] = [];
    const messages: any[] = [];
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, session, webRoot: resolve(dir, "web"), port: 0, watchContent: true, contentWatchFactory: fakeWatch.factory, contentWatchDebounceMs: 1, terminalPtyFactory: () => { const pty = new ServerFakePty(false); ptys.push(pty); return pty; }, mainTutor: tutor });
    try {
      await waitForWatchPath(fakeWatch, resolve(session.contentRoot, "lessons/001-first/blocks"));
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      expect((await state(server.url)).progress.activeBlockId).toBe("lesson--001-first--run-supplied-command");
      const ws = await connect(server.url, server.url);
      ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
      const closed = new Promise<[number, string]>((resolvePromise) => ws.once("close", (code, reason) => resolvePromise([code, reason.toString()])));

      const reloaded = nextSseEvent(server.url, "content-reloaded");
      await writeBlock(resolve(dir, "lessons/001-first"), "run-supplied-command", "narrative", "Run", "Reloaded as prose.");
      fakeWatch.emit(resolve(session.contentRoot, "lessons/001-first/blocks"), "run-supplied-command.md");
      await reloaded;
      await expect(closed).resolves.toEqual([1012, "Terminal content reloaded."]);
      ptys[0]!.data?.(`${bashCommandMarker("stale after reload")}stale output\r\n${bashFinishedMarker()}`);
      await waitMs(20);

      expect(ptys[0]!.killed).toBe(true);
      expect(JSON.stringify(messages)).not.toContain("stale output");
      await expect(privateTimeline(session.sessionRoot)).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "terminal-command-submitted", command: "stale after reload" })]));
    } finally { await server.close(); }
  });

  it("rejects an explicit invalid runtime provision source instead of silently falling back", async () => {
    const { dir, session } = await sessionFixture();

    await expect(startWorkbookServer({
      target: dir,
      session,
      runtimeProvision: { mounts: [{ source: resolve(dir, "missing-runtime"), target: "runtime-tools", readonly: true }] },
      webRoot: resolve(dir, "web"),
      port: 0,
      embeddedTerminal: false,
      mainTutor: new FakeMainTutor(),
          })).rejects.toThrow(/runtime mount source|no such file|ENOENT/i);
  });

  it("opens the introduction as durable tutor conversation before any real block is active", async () => {
    const dir = await fixture();
    const firstTutor = new FakeMainTutor();
    firstTutor.replyQueue.push(new Error("intro provider secret"));
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: firstTutor });
    let persistedTimeline: any[];
    try {
      const initial = await state(firstServer.url);
      expect(initial.introductionComplete).toBe(false);
      expect(initial.progress.activeBlockId).toBe("workbook--introduction");
      expect(initial.progress.workAcceptedBlocks).toContain("workbook--introduction");
      expect(initial.progress.readyBlocks).toEqual(["part--loop"]);
      expect(initial.revealedBlockIds).toEqual(["workbook--introduction"]);
      expect(initial.timeline.filter((record: any) => record.type === "message")).toEqual([
        expect.objectContaining({ lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "authored", presentation: "course", text: expect.stringContaining("# Fixture workbook") }),
        expect.objectContaining({ lessonId: "part--loop", blockId: "part--loop", role: "assistant", source: "authored", presentation: "course", text: expect.stringContaining("# Part 1") })
      ]);
      expect(initial.timeline[0].text).toContain("Welcome to the fixture workbook.");
      expect((await postHint(firstServer.url, { blockId: "workbook--introduction" })).status).toBe(405);
      expect((await postEditor(firstServer.url, { blockId: "lesson--001-first--edit-answer", text: "too soon" })).status).toBe(409);

      const response = await postMessage(firstServer.url, { blockId: "workbook--introduction", text: "Can I ask before we start?" });
      expect(response.status).toBe(202);
      const chatted = await response.json() as any;
      expect(chatted.introductionComplete).toBe(false);
      expect(firstTutor.replies).toHaveLength(1);
      expect(firstTutor.replies[0]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook--introduction", blockId: "workbook--introduction", text: "Can I ask before we start?" } });
      expect(chatted.timeline.slice(-2)).toEqual([
        expect.objectContaining({ lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "user", source: "learner", presentation: "chat", text: "Can I ask before we start?" }),
        expect.objectContaining({ lessonId: "workbook--introduction", blockId: "workbook--introduction", type: "tutor_failed", operation: "reply" }),
      ]);
      expect(JSON.stringify(chatted.timeline)).not.toContain("intro provider secret");
      const retryFailure = chatted.timeline.at(-1);
      const retried = await fetch(`${firstServer.url}/api/workbook/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failureId: retryFailure.failureId }) }).then((retry) => retry.json() as any);
      expect(firstTutor.replies).toHaveLength(2);
      expect(firstTutor.replies[1]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook--introduction", blockId: "workbook--introduction", text: "Can I ask before we start?" } });
      expect(retried.timeline.at(-1)).toMatchObject({ lessonId: "workbook--introduction", blockId: "workbook--introduction", role: "assistant", source: "main_tutor", presentation: "chat", text: "Try the workspace-relative path." });
      persistedTimeline = retried.timeline;
    } finally { await firstServer.close(); }

    const secondTutor = new FakeMainTutor();
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: secondTutor });
    try {
      const restored = await state(secondServer.url);
      expect(restored.timeline).toEqual(persistedTimeline!);
      expect(restored.introductionComplete).toBe(false);
      expect(secondTutor.restores).toHaveLength(1);
      expect(secondTutor.restores[0]!.activeContext).toBeUndefined();
      expect(secondTutor.restores[0]!.records.filter((record) => record.type === "message")).toEqual(persistedTimeline!.filter((record) => record.type === "message"));
      expect((await postMessage(secondServer.url, { blockId: "workbook--introduction", text: "Still before the first block?" })).status).toBe(202);
    } finally { await secondServer.close(); }
  });

  it("renders active-block conversation after its ready successor was already revealed", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    try {
      // Startup accepts the introduction and reveals the part preamble, but the introduction
      // remains active until Continue. Its later conversation must not be swallowed by that row.
      const replied = await postMessage(server.url, { blockId: "workbook--introduction", text: "Question for the active introduction." });
      expect(replied.status).toBe(202);
      const browserState = await replied.json() as any;
      const timeline = browserState.timeline;
      expect(timeline.map((record: any) => [record.source, record.blockId, record.text])).toEqual(expect.arrayContaining([
        ["authored", "part--loop", expect.stringContaining("Part 1")],
        ["learner", "workbook--introduction", "Question for the active introduction."],
        ["main_tutor", "workbook--introduction", "Try the workspace-relative path."],
      ]));

      const continuationRecordIds: string[] = [];
      const markup = renderToStaticMarkup(createElement(TimelineThread, {
        records: timeline,
        activeLessonId: "workbook--introduction",
        activeBlockId: "workbook--introduction",
        onSend: async () => undefined,
        onRetry: async () => undefined,
        renderContinuation: (record) => { continuationRecordIds.push(record.id); return null; },
      }));

      const reply = timeline.find((record: any) => record.source === "main_tutor" && record.blockId === "workbook--introduction");
      expect(markup).toContain("Question for the active introduction.");
      expect(markup).toContain("Try the workspace-relative path.");
      expect(markup.indexOf("Question for the active introduction.")).toBeLessThan(markup.indexOf("Try the workspace-relative path."));
      expect(markup.indexOf("Try the workspace-relative path.")).toBeLessThan(markup.indexOf("Part 1"));
      expect(continuationRecordIds).toContain(reply.id);
    } finally { await server.close(); }
  });

  it("retries a failed intro reply without adopting the newly active block context after continue", async () => {
    const dir = await fixture();
    const tutor = new FakeMainTutor();
    tutor.replyQueue.push(new Error("intro provider failed once"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: tutor });
    try {
      const failed = await postMessage(server.url, { blockId: "workbook--introduction", text: "Question before the first lesson." }).then((response) => response.json() as any);
      const failure = failed.timeline.at(-1);
      expect(failure).toMatchObject({ type: "tutor_failed", lessonId: "workbook--introduction", blockId: "workbook--introduction", operation: "reply" });

      const opened = await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      expect(opened.progress.activeBlockId).toBe("part--loop");
      expect((await fetch(`${server.url}/api/workbook/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failureId: failure.failureId }) })).status).toBe(202);

      expect(tutor.replies).toHaveLength(2);
      expect(tutor.replies[0]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook--introduction", blockId: "workbook--introduction" } });
      expect(tutor.replies[1]).toMatchObject({ activeContext: undefined, learnerMessage: { lessonId: "workbook--introduction", blockId: "workbook--introduction" } });
      const retriedTimeline = (await state(server.url)).timeline;
      expect(retriedTimeline.at(-1)).toMatchObject({ type: "message", lessonId: "workbook--introduction", blockId: "workbook--introduction", source: "main_tutor", text: "Try the workspace-relative path." });
    } finally { await server.close(); }
  });

  it("projects current-format completed-introduction openings without adding a late introduction note", async () => {
    const dir = await fixture();
    await mkdir(resolve(dir, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(tutorialStatePath(dir, "workbook", "events.jsonl"), currentTimelineText([
      timelineRecord(1, { type: "session_started" }),
      timelineRecord(2, { type: "workbook_introduction_completed" }),
    ]));

    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    let authored: any[];
    try {
      const recovered = await state(firstServer.url);
      authored = recovered.timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(authored.map((record: any) => [record.lessonId, record.blockId])).toEqual([
        ["part--loop", "part--loop"],
        ["lesson--001-first", "lesson--001-first"],
      ]);
      expect(JSON.stringify(recovered.timeline)).not.toContain("workbook--introduction");
      expect(recovered.timeline.find((record: any) => record.type === "message" && record.blockId === "workbook--introduction")).toBeUndefined();
    } finally { await firstServer.close(); }

    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    try {
      const restoredAuthored = (await state(secondServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(restoredAuthored).toEqual(authored!);
    } finally { await secondServer.close(); }
  });

  it("projects current-format lesson milestones through the canonical ordered block stream", async () => {
    const dir = await fixture();
    await mkdir(resolve(dir, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(tutorialStatePath(dir, "workbook", "events.jsonl"), currentTimelineText([
      timelineRecord(1, { type: "session_started" }),
      timelineRecord(2, { type: "workbook_introduction_completed" }),
      timelineRecord(3, { type: "block_completed", blockId: "part--loop" }),
      timelineRecord(4, { type: "block_completed", blockId: "lesson--001-first" }),
      timelineRecord(5, { type: "block_completed", lessonId: "001-first", blockId: "lesson--001-first--orientation" }),
      timelineRecord(6, { type: "block_completed", lessonId: "001-first", blockId: "lesson--001-first--edit-answer" }),
      timelineRecord(7, { type: "block_completed", lessonId: "001-first", blockId: "lesson--001-first--run-supplied-command" }),
      timelineRecord(8, { type: "block_completed", lessonId: "001-first", blockId: "lesson--001-first--change-job" }),
      timelineRecord(9, { type: "block_completed", lessonId: "001-first", blockId: "lesson--001-first--reflection" }),
      timelineRecord(10, { type: "block_completed", lessonId: "001-first", blockId: "lesson--001-first--transition" }),
    ]));

    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    try {
      const recovered = await state(server.url);
      expect(recovered.progress.completedLessons).toContain("001-first");
      expect(recovered.progress.completedBlocks).toEqual(expect.arrayContaining([
        "lesson--001-first--orientation",
        "lesson--001-first--edit-answer",
        "lesson--001-first--run-supplied-command",
        "lesson--001-first--change-job",
        "lesson--001-first--reflection",
        "lesson--001-first--transition",
      ]));
      expect(recovered.progress.activeBlockId).toBe("lesson--002-second");
    } finally { await server.close(); }
  });

  it("projects missing current-format frames before an already-authored active block without rewriting append order", async () => {
    const dir = await fixture();
    await mkdir(resolve(dir, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(tutorialStatePath(dir, "workbook", "events.jsonl"), currentTimelineText([
      timelineRecord(1, { type: "session_started" }),
      timelineRecord(2, { type: "workbook_introduction_completed" }),
      timelineRecord(3, { type: "message", lessonId: "001-first", blockId: "lesson--001-first--orientation", role: "assistant", source: "authored", presentation: "course", text: "## Orientation\n\nStart with the concept." }),
    ]));

    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    let projectedAuthored: any[];
    try {
      projectedAuthored = (await state(firstServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(projectedAuthored.map((record: any) => [record.id, record.lessonId, record.blockId])).toEqual([
        [expect.any(String), "part--loop", "part--loop"],
        [expect.any(String), "lesson--001-first", "lesson--001-first"],
        ["fixture-event-3", "001-first", "lesson--001-first--orientation"],
      ]);
      const canonicalLog = (await privateTimeline(dir)).filter((record) => record.type === "message" && record.source === "authored");
      expect(canonicalLog.map((record: any) => [record.id, record.lessonId, record.blockId])).toEqual([
        ["fixture-event-3", "001-first", "lesson--001-first--orientation"],
        [expect.any(String), "part--loop", "part--loop"],
        [expect.any(String), "lesson--001-first", "lesson--001-first"],
      ]);
    } finally { await firstServer.close(); }

    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    try {
      const restoredAuthored = (await state(secondServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(restoredAuthored).toEqual(projectedAuthored!);
    } finally { await secondServer.close(); }
  });

  it("continues the introduction by recording part, lesson frame, and first block authored messages once", async () => {
    const dir = await fixture();
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    let authoredAfterContinue: any[];
    try {
      const opened = await fetch(`${firstServer.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      authoredAfterContinue = opened.timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(authoredAfterContinue.map((record: any) => [record.lessonId, record.blockId])).toEqual([
        ["workbook--introduction", "workbook--introduction"],
        ["part--loop", "part--loop"],
        ["lesson--001-first", "lesson--001-first"],
      ]);
      expect(authoredAfterContinue[1].text).toContain("# Part 1 — Loop");
      expect(authoredAfterContinue[1].text).toContain("Part copy.");
      expect(opened.progress.activeBlockId).toBe("part--loop");
      expect(JSON.stringify(opened.timeline)).not.toContain("Private editor rubric");
    } finally { await firstServer.close(); }

    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    try {
      const restoredAuthored = (await state(secondServer.url)).timeline.filter((record: any) => record.type === "message" && record.source === "authored");
      expect(restoredAuthored).toEqual(authoredAfterContinue!);
    } finally { await secondServer.close(); }
  });

  it("serves content without private tutor data and rejects inactive actions", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    try {
      const initial = await state(server.url);
      expect(initial.chapters.map((chapter: any) => [chapter.id, chapter.lesson])).toEqual([["001-first", undefined], ["002-second", undefined]]);
      expect((await postEvent(server.url, { blockId: "lesson--001-first--orientation", action: "continue" })).status).toBe(409);
      await completeBlock(server.url, "workbook--introduction");
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "too soon" })).status).toBe(409);
      expect((await postEvent(server.url, { blockId: "lesson--001-first--change-job", action: "continue" })).status).toBe(409);
      await continueActive(server.url);
      await continueActive(server.url);
      const opened = await completeBlock(server.url, "lesson--001-first--orientation").then((response) => response.json()).then((result: any) => result.state);
      expect(opened.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      expect(JSON.stringify(opened)).not.toContain("Private editor rubric");
      expect(JSON.stringify(opened)).not.toContain("Observe run result");
    } finally { await server.close(); }
  });

  it("projects only a ready terminal successor's authored block into public chapter content", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "factory acceptance marker" })).status).toBe(202);
      const projected = await waitForWorkbookState(server.url, (next) =>
        block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted"
        && next.progress.readyBlocks.includes("lesson--001-first--run-supplied-command"), "ready terminal successor");

      expect(projected.revealedBlockIds).not.toContain("lesson--001-first--run-supplied-command");
      expect(projected.renderedBlockIds).toContain("lesson--001-first--run-supplied-command");
      expect(projected.chapters.find((chapter: any) => chapter.id === "001-first")?.lesson.blocks.map((candidate: any) => candidate.id)).toEqual([
        "lesson--001-first--orientation",
        "lesson--001-first--edit-answer",
        "lesson--001-first--run-supplied-command",
      ]);
      expect(projected.chapters[0].lesson.blocks.find((candidate: any) => candidate.id === "lesson--001-first--run-supplied-command")).toMatchObject({ type: "terminal-practice", markdown: "Run the supplied command." });
      expect(JSON.stringify(projected.chapters)).not.toContain("Change the job and run again.");
    } finally { await server.close(); }
  });

  it("activates a terminal practice block without generating a main-tutor briefing", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, mainTutor);
      const opened = await state(server.url);
      expect(opened.progress.activeBlockId).toBe("lesson--001-first--run-supplied-command");
      const records = await privateTimeline(dir);
      expect(records.find((record) => record.type === "message" && record.source === "authored" && record.blockId === "lesson--001-first--run-supplied-command")).toBeTruthy();
      expect(records.filter((record: any) => record.type === "block_tutor_briefed")).toEqual([]);
      expect(JSON.stringify(opened)).not.toContain("Observe run result");
    } finally { await server.close(); }
  });

  it("does not treat an unfinished command from an old terminal session as running in ordinary chat", async () => {
    const dir = await fixture();
    const oldPty = new ServerFakePty(false);
    const firstTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => oldPty, mainTutor: firstTutor });
    const blockId = "lesson--001-first--run-supplied-command";
    const staleCommand = "printf stale-old-session-context";
    try {
      await introduceAndOpenEditor(firstServer.url);
      await acceptEditor(firstServer.url, firstTutor);
      const ws = await connect(firstServer.url, firstServer.url);
      oldPty.data?.(bashCommandMarker(staleCommand));
      ws.send(JSON.stringify({ type: "input", data: `${staleCommand}\r` }));
      await waitForPrivateTimeline(dir, (records) => records.some((record) => record.type === "terminal-command-submitted" && record.command === staleCommand), "old terminal session command submission");
      ws.close();
    } finally { await firstServer.close(); }

    const newPty = new ServerFakePty(false);
    const secondTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => newPty, mainTutor: secondTutor });
    try {
      const ws = await connect(secondServer.url, secondServer.url);
      newPty.data?.("fresh-session-output\r\n");

      const response = await postMessage(secondServer.url, { blockId, text: "What does the terminal show now?" });
      expect(response.status).toBe(202);
      const replyContext = secondTutor.replies.at(-1)!.activeContext as any;
      expect(replyContext.terminal).toMatchObject({ transcript: expect.stringContaining("fresh-session-output") });
      expect(replyContext.terminal.latestCommand).toBeUndefined();
      expect(JSON.stringify(await response.json())).not.toMatch(/fresh-session-output|stale-old-session-context|workbook-command|evidenceRef|attemptId/);
      ws.close();
    } finally { await secondServer.close(); }
  });

  it("omits an old-session finished command from ordinary chat when finished evidence is missing or inconsistent", async () => {
    for (const scenario of ["missing", "inconsistent"] as const) {
      const dir = await fixture();
      const oldPty = new ServerFakePty(false);
      const firstTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
      const firstServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => oldPty, mainTutor: firstTutor });
      const blockId = "lesson--001-first--run-supplied-command";
      const staleCommand = `printf stale-old-finished-${scenario}-context`;
      try {
        await introduceAndOpenEditor(firstServer.url);
        await acceptEditor(firstServer.url, firstTutor);
        const ws = await connect(firstServer.url, firstServer.url);
        oldPty.data?.(bashCommandMarker(staleCommand));
        ws.send(JSON.stringify({ type: "input", data: `${staleCommand}\r` }));
        await waitForWorkbookState(firstServer.url, () => oldPty.writes.includes(`${staleCommand}\r`), "terminal input to reach the pty");
        oldPty.data?.(`stale-finished-output\r\n${bashFinishedMarker(7)}`);
        const records = await waitForPrivateTimeline(dir, (latest) => latest.some((record) => record.type === "terminal-command-finished"), "old finished command evidence");
        const finished = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }> => record.type === "terminal-command-finished")!;
        const evidence = new TerminalEvidenceRepository({ stateRoot: tutorialStatePath(dir) });
        const evidencePath = resolve(evidence.evidenceDirectory, `${finished.evidenceRef}.json`);
        if (scenario === "missing") await rm(evidencePath);
        else await writeFile(evidencePath, `${JSON.stringify({ kind: "finished", command: "tampered command", exitStatus: 0, interactions: [{ kind: "output", data: "tampered output" }] })}\n`, "utf8");
        ws.close();
      } finally { await firstServer.close(); }

      const newPty = new ServerFakePty(false);
      const secondTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
      const secondServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => newPty, mainTutor: secondTutor });
      try {
        const ws = await connect(secondServer.url, secondServer.url);
        newPty.data?.(`fresh-${scenario}-session-output\r\n`);

        const response = await postMessage(secondServer.url, { blockId, text: `What does the terminal show after the ${scenario} stale evidence?` });
        expect(response.status).toBe(202);
        const replyContext = secondTutor.replies.at(-1)!.activeContext as any;
        expect(replyContext.terminal).toMatchObject({ transcript: expect.stringContaining(`fresh-${scenario}-session-output`) });
        expect(replyContext.terminal.latestCommand).toBeUndefined();
        expect(JSON.stringify(await response.json())).not.toMatch(/fresh-missing-session-output|fresh-inconsistent-session-output|stale-old-finished|tampered output|workbook-command|evidenceRef|attemptId/);
        ws.close();
      } finally { await secondServer.close(); }
    }
  });

  it("gives ordinary Main Tutor chat private active terminal context for a running command only", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      const blockId = "lesson--001-first--run-supplied-command";
      const ws = await connect(server.url, server.url);
      const command = "printf private-running-context";
      pty.data?.(bashCommandMarker(command));
      ws.send(JSON.stringify({ type: "input", data: `${command}\r` }));
      await waitForWorkbookState(server.url, () => pty.writes.includes(`${command}\r`), "terminal input to reach the pty");
      pty.data?.("private-running-output\r\n");
      await waitForPrivateTimeline(dir, (records) => records.some((record) => record.type === "terminal-command-submitted" && record.command === command), "running command submission");

      const response = await postMessage(server.url, { blockId, text: "What does the terminal show?" });
      expect(response.status).toBe(202);
      const browserState = await response.json() as any;
      const replyContext = tutor.replies.at(-1)!.activeContext as any;
      expect(replyContext.terminal).toMatchObject({
        transcript: expect.stringContaining(command),
        latestCommand: { command, status: "running" }
      });
      expect(replyContext.terminal.transcript).toContain("private-running-output");
      expect(replyContext.terminal.latestCommand.finishedEvidence).toBeUndefined();
      expect(JSON.stringify(browserState)).not.toMatch(/private-running-context|private-running-output|workbook-command|evidenceRef|attemptId/);
      expect(JSON.stringify(await timelineSnapshot(server.url))).not.toMatch(/private-running-context|private-running-output|workbook-command|evidenceRef|attemptId/);
      ws.close();
    } finally { await server.close(); }
  });

  it("gives ordinary Main Tutor chat private active terminal context for a finished command with evidence", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      const blockId = "lesson--001-first--run-supplied-command";
      const ws = await connect(server.url, server.url);
      const command = "printf private-finished-context";
      pty.data?.(bashCommandMarker(command));
      ws.send(JSON.stringify({ type: "input", data: `${command}\r` }));
      await waitForWorkbookState(server.url, () => pty.writes.includes(`${command}\r`), "terminal input to reach the pty");
      pty.data?.(`private-finished-output\r\n${bashFinishedMarker(7)}`);
      await waitForPrivateTimeline(dir, (records) => records.some((record) => record.type === "terminal-command-finished"), "finished command evidence");

      const response = await postMessage(server.url, { blockId, text: "Why did that command fail?" });
      expect(response.status).toBe(202);
      const browserState = await response.json() as any;
      const replyContext = tutor.replies.at(-1)!.activeContext as any;
      expect(replyContext.terminal).toMatchObject({
        transcript: expect.stringContaining("private-finished-output"),
        latestCommand: {
          command,
          status: "finished",
          exitStatus: 7,
          finishedEvidence: {
            kind: "finished",
            command,
            exitStatus: 7,
            interactions: expect.arrayContaining([
              { kind: "input", data: `${command}\r` },
              { kind: "output", data: expect.stringContaining("private-finished-output") }
            ])
          }
        }
      });
      expect(replyContext.terminal.latestCommand.evidenceRef).toMatch(/.+/);
      expect(JSON.stringify(browserState)).not.toMatch(/private-finished-context|private-finished-output|workbook-command|evidenceRef|attemptId/);
      expect(JSON.stringify(await timelineSnapshot(server.url))).not.toMatch(/private-finished-context|private-finished-output|workbook-command|evidenceRef|attemptId/);
      ws.close();
    } finally { await server.close(); }
  });

  it("treats the latest ordinary-chat terminal command as running when finished evidence is missing or inconsistent", async () => {
    for (const scenario of ["missing", "inconsistent"] as const) {
      const dir = await fixture();
      const pty = new ServerFakePty(false);
      const tutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
      const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
      try {
        await introduceAndOpenEditor(server.url);
        await acceptEditor(server.url, tutor);
        const blockId = "lesson--001-first--run-supplied-command";
        const ws = await connect(server.url, server.url);
        const command = `printf private-${scenario}-context`;
        pty.data?.(bashCommandMarker(command));
        ws.send(JSON.stringify({ type: "input", data: `${command}\r` }));
        await waitForWorkbookState(server.url, () => pty.writes.includes(`${command}\r`), "terminal input to reach the pty");
        pty.data?.(`private-${scenario}-output\r\n${bashFinishedMarker(7)}`);
        const records = await waitForPrivateTimeline(dir, (latest) => latest.some((record) => record.type === "terminal-command-finished"), "finished command evidence");
        const finished = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }> => record.type === "terminal-command-finished")!;
        const evidence = new TerminalEvidenceRepository({ stateRoot: tutorialStatePath(dir) });
        const evidencePath = resolve(evidence.evidenceDirectory, `${finished.evidenceRef}.json`);
        if (scenario === "missing") await rm(evidencePath);
        else await writeFile(evidencePath, `${JSON.stringify({ kind: "finished", command: "tampered command", exitStatus: 0, interactions: [{ kind: "output", data: "tampered output" }] })}\n`, "utf8");

        const response = await postMessage(server.url, { blockId, text: `What happened in the ${scenario} terminal attempt?` });
        expect(response.status).toBe(202);
        const replyContext = tutor.replies.at(-1)!.activeContext as any;
        expect(replyContext.terminal).toMatchObject({
          transcript: expect.stringContaining(`private-${scenario}-output`),
          latestCommand: { command, status: "running" }
        });
        expect(replyContext.terminal.latestCommand).not.toHaveProperty("exitStatus");
        expect(replyContext.terminal.latestCommand).not.toHaveProperty("evidenceRef");
        expect(replyContext.terminal.latestCommand).not.toHaveProperty("finishedEvidence");
        expect(JSON.stringify(await response.json())).not.toMatch(/private-missing-context|private-inconsistent-context|private-missing-output|private-inconsistent-output|tampered output|evidenceRef|attemptId/);
        ws.close();
      } finally { await server.close(); }
    }
  });

  it("rejects legacy unexpected-output and help event actions on an active terminal block and appends no record", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "accepted", message: "Editor accepted." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, mainTutor);
      const activeState = await state(server.url);
      expect(block(activeState, "lesson--001-first--run-supplied-command")?.active).toBe(true);
      const before = await privateTimeline(dir);

      const unexpectedResponse = await postEvent(server.url, { blockId: "lesson--001-first--run-supplied-command", action: "unexpected", evidence: "command not found" });
      expect(unexpectedResponse.status).toBe(400);

      const helpResponse = await postEvent(server.url, { blockId: "lesson--001-first--run-supplied-command", action: "help", request: "I'm stuck" });
      expect(helpResponse.status).toBe(400);

      const after = await privateTimeline(dir);
      expect(after).toEqual(before);
    } finally { await server.close(); }
  });

  it("records feedback for an incomplete attempt instead of silently staying in draft progress", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "feedback", message: "Add the marker before continuing." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "unfinished" })).status).toBe(202);
      const feedback = await waitForWorkbookState(server.url, (next) => mainTutor.reviews.length === 1 && block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "feedback", "review feedback");
      expect(block(feedback, "lesson--001-first--edit-answer")?.checkpoint).toMatchObject({ status: "feedback", feedback: "Add the marker before continuing." });
      await waitForPrivateTimeline(dir, (records) => records.some((record) => record.type === "message" && record.source === "main_tutor" && record.presentation === "review" && record.text === "Add the marker before continuing."), "feedback review message");
    } finally { await server.close(); }
  });

  it("keeps editor automatic review on the main tutor without timeline duplication", async () => {
    const dir = await fixture();
    const mainTutor = new FakeMainTutor({ outcome: "feedback", message: "Add the exact marker before this can continue." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "almost" })).status).toBe(202);
      const feedback = await waitForWorkbookState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "feedback" && mainTutor.reviews.length === 1, "main tutor editor feedback");
      expect(mainTutor.reviews[0]!.activeWorkspaceRoot).toBe(await realpath(resolve(dir, "workspaces/refactor-line")));
      expect(block(feedback, "lesson--001-first--edit-answer")?.checkpoint?.feedback).toBe("Add the exact marker before this can continue.");
      // The review message is appended to the log after the checkpoint status flips, so waiting on
      // the status alone would let this assert before the record it forbids could exist. Wait for
      // the log entry, then read state: now "absent from the public timeline" means the projection
      // dropped it, not that nothing had been written yet.
      await waitForPrivateTimeline(dir, (records) => records.some((record) => record.type === "message" && record.source === "main_tutor" && record.presentation === "review" && record.text === "Add the exact marker before this can continue."), "the editor review recorded in the event log");
      expect((await state(server.url)).timeline.filter((record: any) => record.type === "message" && record.source === "main_tutor" && record.presentation === "review")).toEqual([]);
    } finally { await server.close(); }
  });

  it("sends state SSE for async editor review feedback without a public timeline record", async () => {
    const dir = await fixture();
    const decision = deferred<TutorDecision>();
    const mainTutor = new FakeMainTutor(decision.promise);
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor });
    try {
      await introduceAndOpenEditor(server.url);
      const beforeTimeline = await timelineSnapshot(server.url);
      const stateEvent = nextSseEvent(server.url, "state");
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "almost" })).status).toBe(202);
      await waitForWorkbookState(server.url, () => mainTutor.reviews.length === 1, "editor review to reach the tutor");

      decision.resolve({ outcome: "feedback", message: "Add the exact marker before this can continue." });
      await expect(stateEvent).resolves.toMatchObject({ blockId: "lesson--001-first--edit-answer", revision: 1, status: "feedback" });
      const feedback = await state(server.url);
      expect(block(feedback, "lesson--001-first--edit-answer")?.checkpoint).toMatchObject({ status: "feedback", feedback: "Add the exact marker before this can continue." });
      expect(await timelineSnapshot(server.url)).toEqual(beforeTimeline);
    } finally { await server.close(); }
  });

  it("calls the Main Tutor directly on Bash-finished terminal evidence and never records a terminal-coach event", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      { outcome: "feedback", message: "Fix the command path." },
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      const blockId = "lesson--001-first--run-supplied-command";
      const command = "cat -n";
      pty.data?.(bashCommandMarker(command));
      await waitForPrivateTimeline(dir, (records) => records.some((record) => record.type === "terminal-command-submitted"), "Bash submission");
      expect(tutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal")).toHaveLength(0);
      expect(block(await state(server.url), blockId)?.terminal).toEqual({ phase: "running" });

      pty.data?.(`output for ${command}\r\n${bashFinishedMarker()}`);
      const feedback = await waitForWorkbookState(server.url, (next) => block(next, blockId)?.terminal?.phase === "feedback", "direct terminal feedback");
      expect(block(feedback, blockId)?.terminal).toEqual({ phase: "feedback", message: "Fix the command path." });

      const terminalReviews = tutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal");
      expect(terminalReviews).toHaveLength(1);
      expect(terminalReviews[0]!.privateGuidance).toBe("Observe run result.");
      expect(terminalReviews[0]!.activeContext?.terminal).toBeUndefined();
      expect(terminalReviews[0]!.activeWorkspaceRoot).toBe(await realpath(resolve(dir, "workspaces/refactor-line")));
      const reviewEvidence = JSON.parse(terminalReviewTranscript(terminalReviews[0]!));
      expect(reviewEvidence).toMatchObject({
        label: "finished-terminal-review-evidence",
        commandEvidence: { kind: "finished", command, exitStatus: 0 },
        transcriptSnapshot: { label: expect.any(String), transcript: expect.stringContaining(`output for ${command}`) },
      });

      const records = await privateTimeline(dir);
      const finished = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }> => record.type === "terminal-command-finished");
      expect(finished).toBeTruthy();
      const evidence = new TerminalEvidenceRepository({ stateRoot: tutorialStatePath(dir) });
      expect(await evidence.read(finished!.evidenceRef)).toMatchObject({ kind: "finished", command, exitStatus: 0, transcriptSnapshot: expect.any(Object) });
      expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ type: "terminal-review-requested", attemptId: finished!.attemptId, evidenceRef: finished!.evidenceRef })]));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "terminal-coach-handoff-recorded" }));
      expect(JSON.stringify(feedback)).not.toMatch(/cat -n|output for|attemptId|evidenceRef|Observe run result/);
    } finally { await server.close(); }
  });

  it("persists a labelled bounded transcript snapshot for direct terminal review", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const tail = "VISIBLE-TRANSCRIPT-TAIL";
    const hugeOutputChunks = [
      ...Array.from({ length: 5 }, () => `${"x".repeat(4_000)}\r\n`),
      `${"y".repeat(4_000)}${tail}\r\n`,
    ];
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      { outcome: "feedback", message: "Read the last lines and try again." },
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      pty.data?.(bashCommandMarker("long output"));
      for (const chunk of hugeOutputChunks) pty.data?.(chunk);
      pty.data?.(bashFinishedMarker(1));
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.terminal?.phase === "feedback", "bounded transcript reviewed");

      const terminalReview = tutor.reviews.find((review) => review.attempt.evidence.kind === "terminal")!;
      const reviewEvidence = JSON.parse(terminalReviewTranscript(terminalReview));
      expect(reviewEvidence.transcriptSnapshot.label).toMatch(/terminal transcript/i);
      expect(Buffer.byteLength(reviewEvidence.transcriptSnapshot.transcript, "utf8")).toBeLessThanOrEqual(MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_BYTES);
      expect(reviewEvidence.transcriptSnapshot.transcript).toContain(tail);
      expect(reviewEvidence.transcriptSnapshot.truncated).toBe(true);

      const records = await privateTimeline(dir);
      const finished = records.find((record): record is Extract<WorkbookTimelineRecord, { type: "terminal-command-finished" }> => record.type === "terminal-command-finished")!;
      const evidence = await new TerminalEvidenceRepository({ stateRoot: tutorialStatePath(dir) }).read(finished.evidenceRef);
      expect(Buffer.byteLength(evidence!.transcriptSnapshot!.transcript, "utf8")).toBeLessThanOrEqual(MAX_TERMINAL_TRANSCRIPT_SNAPSHOT_BYTES);
      expect(evidence!.transcriptSnapshot).toMatchObject({ label: expect.stringMatching(/terminal transcript/i), truncated: true });
    } finally { await server.close(); }
  });

  it("persists an accepted terminal's sanitized snapshot and rebuilds it after reload without a terminal-coach event", async () => {
    const dir = await fixture();
    const ptys: ServerFakePty[] = [];
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      { outcome: "accepted", message: "Terminal accepted." },
    );
    const server = await startWorkbookServer({
      target: dir,
      webRoot: resolve(dir, "web"),
      port: 0,
      terminalPtyFactory: () => {
        const pty = new ServerFakePty();
        ptys.push(pty);
        return pty;
      },
      mainTutor: tutor
    });
    const blockId = "lesson--001-first--run-supplied-command";
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      await submitTerminalAttempt(server.url, blockId);
      const accepted = await waitForWorkbookState(server.url, (next) =>
        block(next, blockId)?.terminal?.phase === "complete"
        && typeof block(next, blockId)?.terminalSnapshot?.transcript === "string", "durable terminal snapshot");

      const snapshot = block(accepted, blockId).terminalSnapshot;
      expect(snapshot.transcript).toContain(`ran:run ${blockId}`);
      expect(snapshot.transcript).not.toMatch(/workbook-command|workbook-finished|attemptId|evidenceRef|Observe run result/);
      expect((await timelineSnapshot(server.url)).some((record) => record.type === "terminal-transcript-snapshotted")).toBe(false);
      const records = await privateTimeline(dir);
      expect(records).toContainEqual(expect.objectContaining({ type: "terminal-transcript-snapshotted", lessonId: "001-first", blockId, transcript: snapshot.transcript }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "terminal-coach-handoff-recorded" }));

      await completeBlock(server.url, blockId);
      expect(ptys[0]!.killed).toBe(true);
    } finally { await server.close(); }

    const reloaded = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() });
    try {
      const restored = await state(reloaded.url);
      expect(block(restored, blockId)?.terminal).toEqual({ phase: "complete", message: "Terminal accepted." });
      expect(block(restored, blockId)?.terminalSnapshot).toEqual({ transcript: expect.stringContaining(`ran:run ${blockId}`) });
    } finally { await reloaded.close(); }
  });

  it("automatically retries a transient Main Tutor terminal-review failure once against the same evidence", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      new Error("provider detail that must stay private"),
      { outcome: "feedback", message: "Recovered direct feedback." },
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      pty.data?.(bashCommandMarker("run"));
      pty.data?.(`done\r\n${bashFinishedMarker()}`);
      const recovered = await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.terminal?.message === "Recovered direct feedback.", "automatic terminal review retry");

      const terminalReviews = tutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal");
      expect(terminalReviews).toHaveLength(2);
      expect(terminalReviewTranscript(terminalReviews[0]!)).toBe(terminalReviewTranscript(terminalReviews[1]!));
      const records = await privateTimeline(dir);
      const requests = records.filter((record) => record.type === "terminal-review-requested");
      expect(requests).toHaveLength(2);
      expect(new Set(requests.map((record: any) => record.evidenceRef)).size).toBe(1);
      expect(records).not.toContainEqual(expect.objectContaining({ type: "terminal-review-failed" }));
      expect(JSON.stringify(recovered)).not.toContain("provider detail");
    } finally { await server.close(); }
  });

  it("limits the Default Main Tutor to one low-level provider prompt per durable terminal review request and logs failures generically", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const logLines: string[] = [];
    const lowLevelPrompts: string[] = [];
    const logger = {
      info: (message: string) => { logLines.push(`INFO ${message}`); },
      error: (message: string, error?: unknown) => { logLines.push(`ERROR ${message}${error ? ` ${String(error)}` : ""}`); }
    };
    const sessionFactory = async (request: WorkbookTutorSessionFactoryRequest) => {
      const subscribers = new Set<(event: PiTutorSessionEvent) => void>();
      const emitAssistant = (text: string) => subscribers.forEach((listener) => listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }));
      const emitError = () => subscribers.forEach((listener) => listener({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          errorMessage: "provider-error terminal-secret Observe run result /tmp/private"
        }
      }));
      const session = createResilientTutorSession({
        state: { model: { provider: "CodexProvider", id: "secret-model" } },
        subscribe(listener: (event: PiTutorSessionEvent) => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
        async prompt(prompt: string) {
          lowLevelPrompts.push(prompt);
          if (prompt.includes("finished-terminal-review-evidence")) { emitError(); return; }
          if (prompt.includes("WORKBOOK ATTEMPT REVIEW")) {
            await (request.customTools.find((tool: any) => tool.name === "accept_current_attempt") as any).execute("tool-call", {});
            emitAssistant("Editor accepted.");
            return;
          }
          emitAssistant("Tutor reply.");
        },
        dispose() {}
      }, logger, "Workbook tutor", { wait: async () => {} });
      return { ...session, compact: async () => ({ summary: "Summary." }) };
    };
    const tutor = new DefaultMainWorkbookTutor({ workspace: dir, log: logger, sessionFactory });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, logger, terminalPtyFactory: () => pty, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      expect((await postEditor(server.url, { blockId: "lesson--001-first--edit-answer", text: "factory acceptance marker" })).status).toBe(202);
      await waitForWorkbookState(server.url, (next) => block(next, "edit-answer")?.checkpoint?.status === "accepted", "default tutor editor acceptance");
      expect((await completeBlock(server.url, "lesson--001-first--edit-answer")).status).toBe(202);

      pty.data?.(bashCommandMarker("terminal-secret"));
      pty.data?.(`terminal-secret-output\r\n${bashFinishedMarker()}`);
      await waitForWorkbookState(server.url, (next) => Boolean(block(next, "run-supplied-command")?.terminal?.retryFailureId), "default tutor terminal failure");

      const records = await privateTimeline(dir);
      const requests = records.filter((record) => record.type === "terminal-review-requested");
      const terminalPrompts = lowLevelPrompts.filter((prompt) => prompt.includes("finished-terminal-review-evidence"));
      expect(requests).toHaveLength(2);
      expect(terminalPrompts).toHaveLength(requests.length);
      expect(logLines.join("\n")).not.toMatch(/CodexProvider|secret-model|provider-error|terminal-secret|terminal-secret-output|Observe run result|\/tmp\/private/);
    } finally { await server.close(); }
  });

  it("exposes durable terminal-local Retry review after automatic calls exhaust and succeeds after restart without another command", async () => {
    const dir = await fixture();
    const firstPty = new ServerFakePty(false);
    const logLines: string[] = [];
    const logger = { info: (message: string) => { logLines.push(message); }, error: (message: string, error?: unknown) => { logLines.push(`${message} ${String(error ?? "")}`); } };
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      new Error("Codex provider leaked secret-command Observe run result secret-output /tmp/private"),
      new Error("second provider detail secret-command secret-output"),
    );
    const first = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, logger, terminalPtyFactory: () => firstPty, mainTutor: tutor });
    let failureId = "";
    let evidenceRef = "";
    try {
      await introduceAndOpenEditor(first.url);
      await acceptEditor(first.url, tutor);
      firstPty.data?.(bashCommandMarker("secret-command"));
      firstPty.data?.(`secret-output\r\n${bashFinishedMarker()}`);
      const failed = await waitForWorkbookState(first.url, (next) => Boolean(block(next, "run-supplied-command")?.terminal?.retryFailureId), "retryable terminal review failure");
      const terminal = block(failed, "run-supplied-command")!.terminal;
      expect(terminal).toMatchObject({ phase: "feedback", message: expect.stringMatching(/Review is temporarily unavailable.*retry the review/i), retryFailureId: expect.any(String) });
      failureId = terminal.retryFailureId;
      expect(failed.timeline.filter((record: any) => record.type === "tutor_failed")).toEqual([]);
      expect(JSON.stringify(failed)).not.toMatch(/secret-command|secret-output|Observe run result|Codex|provider|\/tmp\/private/);

      const records = await privateTimeline(dir);
      const requests = records.filter((record) => record.type === "terminal-review-requested") as any[];
      expect(requests).toHaveLength(2);
      evidenceRef = requests[0]!.evidenceRef;
      expect(new Set(requests.map((record) => record.evidenceRef))).toEqual(new Set([evidenceRef]));
      expect(records).toContainEqual(expect.objectContaining({ type: "terminal-review-failed", failureId, evidenceRef }));
      expect(records.filter((record) => record.type === "terminal-command-submitted")).toHaveLength(1);
      expect(records.filter((record) => record.type === "terminal-command-finished")).toHaveLength(1);
      expect(records).not.toContainEqual(expect.objectContaining({ type: "terminal-coach-handoff-recorded" }));

      const logText = logLines.join("\n");
      expect(logText).toMatch(/Terminal direct review/);
      expect(logText).toMatch(/durationMs=\d+/);
      expect(logText).toMatch(/outcome=infrastructure_failure|outcome=retryable_failure/);
      expect(logText).not.toMatch(/secret-command|secret-output|Observe run result|Codex|provider|\/tmp\/private/);
    } finally { await first.close(); }

    const retryTutor = new FakeMainTutor({ outcome: "accepted", message: "Accepted after Retry review." });
    const second = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: retryTutor });
    try {
      const restoredFailure = await state(second.url);
      expect(block(restoredFailure, "run-supplied-command")?.terminal?.retryFailureId).toBe(failureId);
      expect(retryTutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal")).toHaveLength(0);

      const response = await postRetry(second.url, { failureId });
      expect(response.status).toBe(202);
      const retrying = await response.json() as any;
      expect(block(retrying, "run-supplied-command")?.terminal).toEqual({ phase: "checking" });
      const accepted = await waitForWorkbookState(second.url, (next) => block(next, "run-supplied-command")?.terminal?.phase === "complete", "manual retry accepted");
      expect(block(accepted, "run-supplied-command")?.terminal).toEqual({ phase: "complete", message: "Accepted after Retry review." });

      const recordsAfterRetry = await privateTimeline(dir);
      expect(recordsAfterRetry.filter((record) => record.type === "terminal-command-submitted")).toHaveLength(1);
      expect(recordsAfterRetry.filter((record) => record.type === "terminal-command-finished")).toHaveLength(1);
      const requestsAfterRetry = recordsAfterRetry.filter((record) => record.type === "terminal-review-requested") as any[];
      expect(requestsAfterRetry).toHaveLength(3);
      expect(new Set(requestsAfterRetry.map((record) => record.evidenceRef))).toEqual(new Set([evidenceRef]));
    } finally { await second.close(); }
  });

  it("does not start a new automatic-call budget when manual terminal retry fails", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const firstTutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      new Error("first automatic provider secret"),
      new Error("second automatic provider secret"),
    );
    const first = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: firstTutor });
    let firstFailureId = "";
    try {
      await introduceAndOpenEditor(first.url);
      await acceptEditor(first.url, firstTutor);
      pty.data?.(bashCommandMarker("manual-failure-secret"));
      pty.data?.(`done\r\n${bashFinishedMarker()}`);
      const failed = await waitForWorkbookState(first.url, (next) => Boolean(block(next, "run-supplied-command")?.terminal?.retryFailureId), "initial terminal review failure");
      firstFailureId = block(failed, "run-supplied-command")!.terminal!.retryFailureId!;
    } finally { await first.close(); }

    const retryTutor = new FakeMainTutor(new Error("manual retry provider secret"));
    const second = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: retryTutor });
    try {
      const response = await postRetry(second.url, { failureId: firstFailureId });
      expect(response.status).toBe(202);
      const failedAgain = await waitForWorkbookState(second.url, (next) => {
        const terminal = block(next, "run-supplied-command")?.terminal;
        return terminal?.phase === "feedback" && terminal.retryFailureId === undefined;
      }, "manual terminal retry failure without another entitlement");
      expect(block(failedAgain, "run-supplied-command")?.terminal?.message).toMatch(/Review is temporarily unavailable/i);
      expect(JSON.stringify(failedAgain)).not.toMatch(/manual-failure-secret|provider secret/);
      expect(retryTutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal")).toHaveLength(1);
      const records = await privateTimeline(dir);
      expect(records.filter((record) => record.type === "terminal-command-submitted")).toHaveLength(1);
      expect(records.filter((record) => record.type === "terminal-command-finished")).toHaveLength(1);
      const requests = records.filter((record) => record.type === "terminal-review-requested") as any[];
      expect(requests).toHaveLength(3);
      expect(requests.map((record) => record.callNumber)).toEqual([1, 2, 3]);
      expect(requests.filter((record) => record.mode === "automatic")).toHaveLength(2);
      expect(requests.filter((record) => record.mode === "manual")).toHaveLength(1);
      const failures = records.filter((record) => record.type === "terminal-review-failed") as any[];
      expect(failures).toHaveLength(2);
      const hiddenFinalFailureId = failures.at(-1)!.failureId;
      const secondRetry = await postRetry(second.url, { failureId: hiddenFinalFailureId });
      expect(secondRetry.status).toBe(409);
      expect((await privateTimeline(dir)).filter((record) => record.type === "terminal-review-requested")).toHaveLength(3);
    } finally { await second.close(); }
  });

  for (const scenario of [
    { name: "empty accepted text", decision: { outcome: "accepted" as const, message: "" } },
    { name: "empty feedback text", decision: { outcome: "feedback" as const, message: "" } },
  ]) {
    it(`classifies ${scenario.name} from terminal review as infrastructure failure, not learner feedback`, async () => {
      const dir = await fixture();
      const pty = new ServerFakePty(false);
      const tutor = new FakeMainTutor(
        { outcome: "accepted", message: "Editor accepted." },
        scenario.decision,
        scenario.decision,
      );
      const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
      try {
        await introduceAndOpenEditor(server.url);
        await acceptEditor(server.url, tutor);
        pty.data?.(bashCommandMarker("run"));
        pty.data?.(`done\r\n${bashFinishedMarker()}`);
        const failed = await waitForWorkbookState(server.url, (next) => Boolean(block(next, "run-supplied-command")?.terminal?.retryFailureId), `${scenario.name} retryable failure`);
        expect(block(failed, "run-supplied-command")?.terminal).toMatchObject({ phase: "feedback", message: expect.stringMatching(/Review is temporarily unavailable/) });
        const records = await privateTimeline(dir);
        expect(records).toContainEqual(expect.objectContaining({ type: "terminal-review-failed" }));
        expect(records).not.toContainEqual(expect.objectContaining({ type: "terminal-feedback-recorded", text: "" }));
        expect(records).not.toContainEqual(expect.objectContaining({ type: "attempt_accepted", summary: "" }));
      } finally { await server.close(); }
    });
  }

  it("bounds a hung Main Tutor terminal review and ignores the late result after timeout", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const scheduler = new FakeTerminalAssessmentScheduler();
    const hung = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      hung.promise,
      new Error("second call also unavailable"),
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, terminalAssessmentScheduler: scheduler, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      pty.data?.(bashCommandMarker("run"));
      pty.data?.(`done\r\n${bashFinishedMarker()}`);
      await waitForWorkbookState(server.url, (next) => block(next, "run-supplied-command")?.terminal?.phase === "checking" && tutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal").length === 1 && scheduler.pending === 1, "hung Main Tutor timeout pending");
      scheduler.runNext();
      const failed = await waitForWorkbookState(server.url, (next) => Boolean(block(next, "run-supplied-command")?.terminal?.retryFailureId), "hung Main Tutor timeout feedback");
      expect(block(failed, "run-supplied-command")?.terminal?.message).toMatch(/Review is temporarily unavailable.*retry the review/i);
      expect(tutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal")).toHaveLength(2);
      expect(scheduler.pending).toBe(0);

      hung.resolve({ outcome: "feedback", message: "Late feedback must not replace the timeout." });
      await waitMs(30);
      expect(block(await state(server.url), "run-supplied-command")?.terminal?.message).toMatch(/Review is temporarily unavailable/i);
      expect(await privateTimeline(dir)).not.toContainEqual(expect.objectContaining({ type: "terminal-feedback-recorded", text: "Late feedback must not replace the timeout." }));
    } finally { await server.close(); }
  });

  it("drops a stale direct terminal review result when Bash submits a newer command", async () => {
    const dir = await fixture();
    const pty = new ServerFakePty(false);
    const oldReview = deferred<TutorDecision>();
    const tutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      oldReview.promise,
    );
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => pty, mainTutor: tutor });
    try {
      await introduceAndOpenEditor(server.url);
      await acceptEditor(server.url, tutor);
      pty.data?.(bashCommandMarker("old"));
      pty.data?.(`old output\r\n${bashFinishedMarker()}`);
      await waitForWorkbookState(server.url, () => tutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal").length === 1, "old direct terminal review request");
      pty.data?.(bashCommandMarker("new"));
      oldReview.resolve({ outcome: "feedback", message: "Old result must never appear." });
      await waitMs(30);
      const publicState = await state(server.url);
      expect(block(publicState, "run-supplied-command")?.terminal).toEqual({ phase: "running" });
      expect(JSON.stringify(publicState)).not.toContain("Old result must never appear.");
      expect(await privateTimeline(dir)).not.toContainEqual(expect.objectContaining({ type: "terminal-feedback-recorded", text: "Old result must never appear." }));
    } finally { await server.close(); }
  });

  it("recovers a pending direct terminal review from durable request and evidence after restart", async () => {
    const dir = await fixture();
    const firstPty = new ServerFakePty(false);
    const waitingReview = deferred<TutorDecision>();
    const firstTutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      waitingReview.promise,
    );
    const first = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => firstPty, mainTutor: firstTutor });
    let evidenceRef = "";
    try {
      await introduceAndOpenEditor(first.url);
      await acceptEditor(first.url, firstTutor);
      firstPty.data?.(bashCommandMarker("finished"));
      firstPty.data?.(`done\r\n${bashFinishedMarker()}`);
      const records = await waitForPrivateTimeline(dir, (latest) => latest.some((record) => record.type === "terminal-review-requested"), "first direct terminal review request");
      evidenceRef = (records.find((record) => record.type === "terminal-review-requested") as any).evidenceRef;
      expect(firstTutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal")).toHaveLength(1);
    } finally { await first.close(); }

    const secondTutor = new FakeMainTutor({ outcome: "feedback", message: "Recovered feedback." });
    const second = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => new ServerFakePty(false), mainTutor: secondTutor });
    try {
      const recovered = await waitForWorkbookState(second.url, (next) => block(next, "run-supplied-command")?.terminal?.message === "Recovered feedback.", "recovered direct terminal review");
      expect(block(recovered, "run-supplied-command")?.terminal).toEqual({ phase: "feedback", message: "Recovered feedback." });
      const terminalReview = secondTutor.reviews.find((review) => review.attempt.evidence.kind === "terminal")!;
      const reviewEvidence = JSON.parse(terminalReviewTranscript(terminalReview));
      expect(reviewEvidence.commandEvidence.command).toBe("finished");
      const requests = (await privateTimeline(dir)).filter((record) => record.type === "terminal-review-requested") as any[];
      expect(requests).toHaveLength(2);
      expect(requests.map((record) => record.callNumber)).toEqual([1, 2]);
      expect(requests.map((record) => record.mode)).toEqual(["automatic", "automatic"]);
      expect(new Set(requests.map((record) => record.evidenceRef))).toEqual(new Set([evidenceRef]));
      expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
    } finally { await second.close(); }
  });

  it("turns a pending terminal review into a generic retryable failure on restart when the automatic budget is already consumed", async () => {
    const dir = await fixture();
    const firstPty = new ServerFakePty(false);
    const pendingSecondReview = deferred<TutorDecision>();
    const firstTutor = new FakeMainTutor(
      { outcome: "accepted", message: "Editor accepted." },
      new Error("first automatic provider failure"),
      pendingSecondReview.promise,
    );
    const first = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => firstPty, mainTutor: firstTutor });
    let evidenceRef = "";
    try {
      await introduceAndOpenEditor(first.url);
      await acceptEditor(first.url, firstTutor);
      firstPty.data?.(bashCommandMarker("restart-budget-secret"));
      firstPty.data?.(`done\r\n${bashFinishedMarker()}`);
      const records = await waitForPrivateTimeline(dir, (latest) => latest.filter((record) => record.type === "terminal-review-requested").length === 2, "second automatic direct terminal review request");
      const requests = records.filter((record) => record.type === "terminal-review-requested") as any[];
      evidenceRef = requests[0]!.evidenceRef;
      expect(firstTutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal")).toHaveLength(2);
    } finally { await first.close(); }

    const secondTutor = new FakeMainTutor({ outcome: "feedback", message: "Should not replay beyond budget." });
    const second = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, terminalPtyFactory: () => new ServerFakePty(false), mainTutor: secondTutor });
    try {
      const failed = await waitForWorkbookState(second.url, (next) => Boolean(block(next, "run-supplied-command")?.terminal?.retryFailureId), "restart automatic budget exhausted failure");
      expect(block(failed, "run-supplied-command")?.terminal).toMatchObject({ phase: "feedback", message: expect.stringMatching(/Review is temporarily unavailable.*retry the review/i), retryFailureId: expect.any(String) });
      expect(JSON.stringify(failed)).not.toMatch(/restart-budget-secret|provider failure/);
      expect(secondTutor.reviews.filter((review) => review.attempt.evidence.kind === "terminal")).toHaveLength(0);
      const records = await privateTimeline(dir);
      const requests = records.filter((record) => record.type === "terminal-review-requested") as any[];
      expect(requests).toHaveLength(2);
      expect(requests.map((record) => record.callNumber)).toEqual([1, 2]);
      expect(new Set(requests.map((record) => record.evidenceRef))).toEqual(new Set([evidenceRef]));
      expect(records).toContainEqual(expect.objectContaining({ type: "terminal-review-failed", requestId: requests[1]!.requestId, evidenceRef }));
    } finally { await second.close(); }
  });

  it("rejects sessions containing old Practice Coach handoff events instead of replaying them", async () => {
    const dir = await fixture();
    await mkdir(resolve(dir, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(tutorialStatePath(dir, "workbook", "events.jsonl"), currentTimelineText([
      timelineRecord(1, { type: "session_started" }),
      timelineRecord(2, { type: "terminal-coach-handoff-recorded", attemptId: "11111111-1111-4111-8111-111111111111", outcome: "ready", text: "Legacy private handoff." }),
    ]));

    await expect(startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() })).rejects.toThrow(UnsupportedWorkbookSessionError);
    await expect(startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0, embeddedTerminal: false, mainTutor: new FakeMainTutor() })).rejects.toThrow(/terminal-coach-handoff-recorded.*start fresh/i);
  });


});
