import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbookTerminalManager, type TerminalClient, type TerminalObserver, type TerminalPty, type TerminalPtyFactory } from "../src/workbook/terminal.js";

class FakePty implements TerminalPty {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  cwd = "";
  #data: ((data: string) => void)[] = [];
  #exit: ((event: { exitCode: number }) => void)[] = [];
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.killed = true; }
  onData(callback: (data: string) => void): void { this.#data.push(callback); }
  onExit(callback: (event: { exitCode: number }) => void): void { this.#exit.push(callback); }
  emitData(data: string): void { this.#data.forEach((callback) => callback(data)); }
  emitExit(exitCode: number): void { this.#exit.forEach((callback) => callback({ exitCode })); }
}

class FakeClient implements TerminalClient {
  messages: any[] = [];
  closed = false;
  send(message: string): void { this.messages.push(JSON.parse(message)); }
  close(): void { this.closed = true; }
}

function setup(observer: TerminalObserver = { observe: vi.fn(async () => ({ status: "waiting" })) }, debounceMs = 5, maxTranscriptBytes = 120) {
  let active: any = { lessonId: "lesson", blockId: "practice", command: "npm test", context: "root", expectedObservation: "tests pass" };
  const ptys: FakePty[] = [];
  const factory: TerminalPtyFactory = ({ cwd }) => { const pty = new FakePty(); pty.cwd = cwd; ptys.push(pty); return pty; };
  const completed: any[] = [];
  const manager = new WorkbookTerminalManager({
    workspace: "/tmp/workspace",
    getActiveBlock: () => active,
    observer,
    onVerifiedCompletion: async (block) => { completed.push(block); return { progressed: true }; },
    ptyFactory: factory,
    debounceMs,
    maxTranscriptBytes
  });
  return { manager, ptys, completed, setActive: (next: any) => { active = next; }, observer };
}

afterEach(() => vi.useRealTimers());

describe("WorkbookTerminalManager", () => {
  it("starts the PTY in the canonical workspace without writing a command", () => {
    const { manager, ptys } = setup();
    const client = new FakeClient();
    expect(manager.attach(client)).toBe(true);
    expect(ptys[0]?.cwd).toBe("/tmp/workspace");
    expect(ptys[0]?.writes).toEqual([]);
  });

  it("forwards explicit input bytes, Ctrl-C, and bounded resize", () => {
    const { manager, ptys } = setup();
    manager.attach(new FakeClient());
    manager.receive({ type: "input", data: "abc" });
    manager.receive({ type: "input", data: "\x03" });
    manager.receive({ type: "resize", cols: 999, rows: 999 });
    expect(ptys[0]?.writes).toEqual(["abc", "\x03"]);
    expect(ptys[0]?.resizes).toEqual([[500, 200]]);
  });

  it("debounces observation after command submission and keeps transcript bounded", async () => {
    vi.useFakeTimers();
    const observe = vi.fn(async () => ({ status: "advice" as const, message: "Use npm test." }));
    const { manager, ptys } = setup({ observe }, 20, 80);
    const client = new FakeClient();
    manager.attach(client);
    manager.receive({ type: "input", data: `echo ${"x".repeat(80)}\r` });
    ptys[0]!.emitData("short output");
    await vi.advanceTimersByTimeAsync(25);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0].transcript.length).toBeLessThanOrEqual(80);
    expect(client.messages.at(-1)).toMatchObject({ type: "advice", blockId: "practice", message: "Use npm test." });
  });

  it("does not observe inactive or non-observed blocks", async () => {
    vi.useFakeTimers();
    const observe = vi.fn(async () => ({ status: "complete" as const }));
    const { manager, ptys, setActive } = setup({ observe }, 5);
    setActive(undefined);
    manager.attach(new FakeClient());
    manager.receive({ type: "input", data: "npm test\r" });
    ptys[0]!.emitData("pass");
    await vi.advanceTimersByTimeAsync(10);
    expect(observe).not.toHaveBeenCalled();
  });

  it("sends verified completion through the server-owned callback only", async () => {
    vi.useFakeTimers();
    const { manager, ptys, completed } = setup({ observe: async () => ({ status: "complete", summary: "saw pass" }) }, 5);
    const client = new FakeClient();
    manager.attach(client);
    manager.receive({ type: "input", data: "npm test\r" });
    ptys[0]!.emitData("pass");
    await vi.advanceTimersByTimeAsync(10);
    expect(completed).toHaveLength(1);
    expect(client.messages.at(-1)).toMatchObject({ type: "verified-complete", state: { progressed: true } });
  });

  it("keeps one client at a time, replays buffered output on reconnect, and cleans up the shell", () => {
    const { manager, ptys } = setup();
    const first = new FakeClient();
    const second = new FakeClient();
    const third = new FakeClient();
    expect(manager.attach(first)).toBe(true);
    ptys[0]!.emitData("hello");
    expect(manager.attach(second)).toBe(false);
    manager.detach(first);
    expect(manager.attach(third)).toBe(true);
    expect(third.messages[0]).toMatchObject({ type: "output", data: "hello" });
    manager.dispose();
    expect(ptys[0]?.killed).toBe(true);
    expect(third.closed).toBe(true);
  });
});
