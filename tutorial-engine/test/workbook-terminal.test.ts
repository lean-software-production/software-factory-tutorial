import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbookTerminalManager, dockerContainerUser, dockerExecArguments, dockerRunArguments, publicTerminalTranscript, type ActiveObservedTerminalBlock, type TerminalClient, type TerminalPty, type TerminalPtyFactory, type TerminalPtyOptions } from "../src/workbook/terminal.js";
import type { TerminalObservationFact } from "../src/workbook/terminal-observation.js";

class FakePty implements TerminalPty {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  opened = 0;
  killed = false;
  #data: Array<(data: string) => void> = [];
  #exit: Array<(event: { exitCode: number }) => void> = [];
  constructor(private readonly synchronousOutput?: (data: string) => string | undefined) {}
  write(data: string): void {
    this.writes.push(data);
    const output = this.synchronousOutput?.(data);
    if (output) this.emit(output);
  }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.killed = true; }
  open(): void { if (!this.opened) this.opened += 1; }
  onData(callback: (data: string) => void): void { this.#data.push(callback); }
  onExit(callback: (event: { exitCode: number }) => void): void { this.#exit.push(callback); }
  emit(data: string): void { this.#data.forEach((callback) => callback(data)); }
  emitExit(event: { exitCode: number }): void { this.#exit.forEach((callback) => callback(event)); }
}

class FakeClient implements TerminalClient {
  messages: any[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  send(message: string): void { this.messages.push(JSON.parse(message)); }
  close(code?: number, reason?: string): void { this.closed.push([code, reason]); }
}

function marker(command: string): string { return `\x1b]633;workbook-command;${Buffer.from(command).toString("base64")}\x07`; }
function finished(exitStatus = 0): string { return `\x1b]633;workbook-finished;${exitStatus}\x07`; }

const activePractice: ActiveObservedTerminalBlock = { lessonId: "lesson", blockId: "practice", workspaceId: "refactor-line", workspaceRoot: "/tmp/workspace/refactor-line" };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(options: { initialActiveBlock?: ActiveObservedTerminalBlock } = {}) {
  const initialActiveBlock = "initialActiveBlock" in options ? options.initialActiveBlock : activePractice;
  const facts: TerminalObservationFact[] = [];
  const ptys: FakePty[] = [];
  const active = { block: initialActiveBlock };
  const factory: TerminalPtyFactory = () => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const manager = new WorkbookTerminalManager({
    workspace: "/tmp/workspace",
    getActiveBlock: () => active.block,
    observationSink: async (fact) => { facts.push(fact); },
    ptyFactory: factory,
  });
  return { manager, ptys, facts, active };
}

describe("workbook terminal image", () => {
  it("installs Git without recommendations and isolates its ambient configuration", async () => {
    const dockerfile = await readFile(resolve("docker/workbook-terminal.Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/apt-get install\s+--yes\s+--no-install-recommends\s+git/);
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*");
    expect(dockerfile).toMatch(/ENV GIT_CONFIG_NOSYSTEM=1/);
    expect(dockerfile).toMatch(/ENV GIT_CONFIG_GLOBAL=\/dev\/null/);
    expect(dockerfile).toMatch(/ENV GIT_TERMINAL_PROMPT=0/);
  });
});

describe("WorkbookTerminalManager", () => {
  it("sanitizes control sequences and common secrets before durable terminal output", () => {
    expect(publicTerminalTranscript("\u001b[31mvisible\u001b[0m\r\nAPI_KEY=top-secret\nBearer abc.def")).toBe("visible\nAPI_KEY= [redacted]\nBearer [redacted]");
  });

  it("uses the host identity and installs Bash's private command markers", () => {
    expect(dockerContainerUser()).toBe(`${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`);
    expect(dockerExecArguments("terminal").join(" ")).toContain("workbook-command");
    expect(dockerExecArguments("terminal").join(" ")).toContain("workbook-finished");
    expect(() => dockerExecArguments("terminal", "/workspace/workspaces/scoped-lesson")).toThrow(/workdir/);
    expect(() => dockerExecArguments("terminal", "/workspace/../escape")).toThrow(/workdir/);
  });

  it("mounts only the active live workspace read-write at /workspace", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "workbook-terminal-workspaces-"));
    tempDirs.push(workspace);
    await mkdir(resolve(workspace, "sibling"), { recursive: true });

    const args = dockerRunArguments({ workspace, name: "terminal", apiKey: "test-key" });

    expect(args.join("\n")).toContain(`src=${workspace},dst=/workspace`);
    expect(args.join("\n")).not.toContain(`dst=/workspace,readonly`);
    expect(args.join("\n")).not.toContain(`dst=/workspace/sibling`);
  });

  it("opens one transport shell before attach, then forwards input and bounds resize", () => {
    const { manager, ptys } = setup();
    manager.start();
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.opened).toBe(1);

    const client = new FakeClient();
    expect(manager.attach(client)).toBe(true);
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.opened).toBe(1);
    manager.receive({ type: "input", data: "echo hi\r" });
    manager.receive({ type: "resize", cols: 999, rows: 999 });
    expect(ptys[0]?.writes).toEqual(["echo hi\r"]);
    expect(ptys[0]?.resizes).toEqual([[500, 200]]);
  });

  it("replaces a preloaded PTY before learner input reaches a different active workspace", async () => {
    const facts: TerminalObservationFact[] = [];
    const ptys: FakePty[] = [];
    const optionsSeen: TerminalPtyOptions[] = [];
    const active: { block?: ActiveObservedTerminalBlock } = { block: undefined };
    const manager = new WorkbookTerminalManager({
      workspace: "/tmp/workspace",
      getActiveBlock: () => active.block,
      observationSink: async (fact) => { facts.push(fact); },
      ptyFactory: (options) => {
        optionsSeen.push(options);
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });

    active.block = activePractice;
    manager.start();
    expect(optionsSeen[0]?.cwd).toBe(activePractice.workspaceRoot);
    active.block = { lessonId: "lesson", blockId: "practice", workspaceId: "scoped-lesson", workspaceRoot: "/tmp/workspace/scoped-lesson" };
    ptys[0]!.emit(marker("stale original command"));
    manager.receive({ type: "input", data: "pwd\r" });
    ptys[1]!.emit(marker("pwd"));
    await Promise.resolve();

    expect(ptys).toHaveLength(2);
    expect(ptys[0]!.killed).toBe(true);
    expect(ptys[0]!.writes).toEqual([]);
    expect(ptys[1]!.writes).toEqual(["pwd\r"]);
    expect(optionsSeen[1]?.cwd).toBe("/tmp/workspace/scoped-lesson");
    expect(optionsSeen[1]?.containerWorkdir).toBe("/workspace");
    expect(facts).toEqual([expect.objectContaining({ type: "terminal-command-submitted", command: "pwd" })]);
  });

  it("ignores a stale preloaded PTY exit after replacing it for a scoped lesson workspace", async () => {
    const facts: TerminalObservationFact[] = [];
    const ptys: FakePty[] = [];
    const active: { block?: ActiveObservedTerminalBlock } = { block: undefined };
    const manager = new WorkbookTerminalManager({
      workspace: "/tmp/workspace",
      getActiveBlock: () => active.block,
      observationSink: async (fact) => { facts.push(fact); },
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    const client = new FakeClient();

    active.block = activePractice;
    manager.start();
    manager.attach(client);
    active.block = { lessonId: "lesson", blockId: "practice", workspaceId: "scoped-lesson", workspaceRoot: "/tmp/workspace/scoped-lesson" };
    manager.receive({ type: "input", data: "pwd\r" });
    ptys[1]!.emit(marker("pwd"));
    ptys[1]!.emit("replacement output\r\n");
    ptys[0]!.emitExit({ exitCode: 130 });
    manager.receive({ type: "input", data: "echo still usable\r" });
    ptys[1]!.emit(finished(0));
    await Promise.resolve();

    expect(ptys).toHaveLength(2);
    expect(ptys[0]!.killed).toBe(true);
    expect(ptys[1]!.writes).toEqual(["pwd\r", "echo still usable\r"]);
    expect(client.messages.some((message) => message.type === "exit")).toBe(false);
    expect(manager.activePublicSnapshot()).toEqual({ lessonId: "lesson", blockId: "practice", transcript: "replacement output\n" });
    expect(manager.activeTranscriptContext()?.transcript).toContain("replacement output");
    expect(facts.map((fact) => fact.type)).toEqual(["terminal-command-submitted", "terminal-command-finished"]);
    expect(facts[1]).toMatchObject({ type: "terminal-command-finished", evidence: { command: "pwd", exitStatus: 0 } });
  });

  it("treats the active block key as part of the PTY identity even within one workspace", async () => {
    const { manager, ptys, facts, active } = setup();
    const client = new FakeClient();
    manager.attach(client);
    ptys[0]!.emit("first output\r\n");
    active.block = { lessonId: "lesson", blockId: "other", workspaceId: "refactor-line", workspaceRoot: "/tmp/workspace/refactor-line" };

    ptys[0]!.emit(`${marker("stale")}stale output\r\n${finished(0)}`);
    manager.receive({ type: "input", data: "echo fresh\r" });
    ptys[1]!.emit(`${marker("echo fresh")}fresh output\r\n${finished(0)}`);
    await Promise.resolve();

    expect(ptys).toHaveLength(2);
    expect(ptys[0]!.killed).toBe(true);
    expect(ptys[1]!.writes).toEqual(["echo fresh\r"]);
    expect(client.closed).toEqual([[1012, "Terminal switched to another block."]]);
    expect(JSON.stringify(client.messages)).not.toContain("stale output");
    expect(manager.activePublicSnapshot()).toEqual({ lessonId: "lesson", blockId: "other", transcript: "fresh output\n" });
    expect(facts.map((fact) => fact.type)).toEqual(["terminal-command-submitted", "terminal-command-finished"]);
    expect(facts[1]).toMatchObject({ type: "terminal-command-finished", evidence: { command: "echo fresh" } });
  });

  it("reconciles content reloads by preserving the same active terminal and retiring changed ones", () => {
    const { manager, ptys, active } = setup();
    const client = new FakeClient();
    manager.attach(client);
    ptys[0]!.emit("kept output\r\n");

    manager.reconcileActiveTerminal();
    manager.receive({ type: "input", data: "same block\r" });
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.killed).toBe(false);
    expect(ptys[0]!.writes).toEqual(["same block\r"]);
    expect(client.closed).toEqual([]);

    active.block = { lessonId: "lesson", blockId: "changed", workspaceId: "refactor-line", workspaceRoot: "/tmp/workspace/refactor-line" };
    manager.reconcileActiveTerminal();
    ptys[0]!.emit("stale after reload\r\n");

    expect(ptys[0]!.killed).toBe(true);
    expect(client.closed).toEqual([[1012, "Terminal content reloaded."]]);
    expect(manager.activePublicSnapshot()).toBeUndefined();
    expect(JSON.stringify(client.messages)).not.toContain("stale after reload");
  });

  it("rejects preactive input and does not observe markers before a terminal block is active", async () => {
    const { manager, ptys, facts, active } = setup({ initialActiveBlock: undefined });
    manager.start();
    manager.attach(new FakeClient());

    manager.receive({ type: "input", data: "echo bypass\r" });
    manager.receive({ type: "resize", cols: 100, rows: 30 });
    await Promise.resolve();

    expect(ptys).toHaveLength(0);
    expect(facts).toEqual([]);

    active.block = activePractice;
    manager.receive({ type: "input", data: "echo active\r" });
    ptys[0]!.emit(marker("active command"));
    await Promise.resolve();
    expect(facts).toEqual([expect.objectContaining({ type: "terminal-command-submitted", command: "active command" })]);
  });

  it("creates no attempt before Bash submits and never puts marker bytes on the transport", async () => {
    const { manager, ptys, facts } = setup();
    manager.start();
    expect(facts).toEqual([]);
    const client = new FakeClient();
    manager.attach(client);
    manager.receive({ type: "input", data: "typed\r" });
    ptys[0]!.emit("$ typed\r\n");
    await Promise.resolve();
    expect(facts).toEqual([]);

    ptys[0]!.emit(`${marker("cat -n")}waiting\r\n`);
    await Promise.resolve();
    expect(facts).toEqual([expect.objectContaining({ type: "terminal-command-submitted", command: "cat -n" })]);
    expect(JSON.stringify(client.messages)).toContain("waiting");
    expect(JSON.stringify(client.messages)).not.toContain("workbook-command");
  });

  it("keeps private active terminal transcript scoped to the current block", () => {
    const { manager, ptys, active } = setup();
    manager.attach(new FakeClient());
    manager.receive({ type: "input", data: "private command\r" });
    ptys[0]!.emit("private output\r\n");

    expect(manager.activeTranscriptContext()).toEqual({
      lessonId: "lesson",
      blockId: "practice",
      transcript: "[TERMINAL INPUT]\nprivate command\r[TERMINAL OUTPUT]\nprivate output\r\n"
    });

    active.block = { lessonId: "lesson", blockId: "other", workspaceId: "refactor-line", workspaceRoot: "/tmp/workspace/refactor-line" };
    expect(manager.activeTranscriptContext()).toBeUndefined();
  });

  it("resets a completed terminal transport before a distinct terminal block can attach", () => {
    const { manager, ptys, active } = setup();
    const firstClient = new FakeClient();
    manager.attach(firstClient);
    ptys[0]!.emit("\u001b[31mterminal A output\u001b[0m\r\n");

    expect(manager.activePublicSnapshot()).toEqual({ lessonId: "lesson", blockId: "practice", transcript: "terminal A output\n" });
    manager.resetAfterTerminalContinuation(activePractice);

    expect(ptys[0]!.killed).toBe(true);
    expect(firstClient.closed).toEqual([[1012, "Terminal advanced to the next block."]]);
    active.block = { lessonId: "lesson", blockId: "other", workspaceId: "refactor-line", workspaceRoot: "/tmp/workspace/refactor-line" };
    const secondClient = new FakeClient();
    expect(manager.attach(secondClient)).toBe(true);
    expect(ptys).toHaveLength(2);
    expect(secondClient.messages).toEqual([]);
    ptys[1]!.emit("terminal B output\r\n");
    expect(manager.activePublicSnapshot()).toEqual({ lessonId: "lesson", blockId: "other", transcript: "terminal B output\n" });
  });

  it("records accepted input before synchronous PTY output caused by that input", async () => {
    const facts: TerminalObservationFact[] = [];
    const pty = new FakePty((data) => `sync-output:${data}`);
    const manager = new WorkbookTerminalManager({
      workspace: "/tmp/workspace",
      getActiveBlock: () => activePractice,
      observationSink: async (fact) => { facts.push(fact); },
      ptyFactory: () => pty,
    });
    manager.attach(new FakeClient());
    pty.emit(marker("cat"));

    manager.receive({ type: "input", data: "typed line\r" });
    pty.emit(finished(0));
    await Promise.resolve();

    const transcript = manager.activeTranscriptContext()?.transcript ?? "";
    expect(transcript.indexOf("[TERMINAL INPUT]\ntyped line\r")).toBeLessThan(transcript.indexOf("[TERMINAL OUTPUT]\nsync-output:typed line\r"));
    expect(facts[1]).toMatchObject({ type: "terminal-command-finished", evidence: { interactions: [
      { type: "interactive-input", data: "typed line\r" },
      { type: "terminal-output", data: "sync-output:typed line\r" },
    ] } });
  });

  it("captures one immutable final command fact and no output checkpoints", async () => {
    const { manager, ptys, facts } = setup();
    manager.attach(new FakeClient());
    ptys[0]!.emit(marker("cat"));
    ptys[0]!.emit("one\r\n");
    manager.receive({ type: "input", data: "two\r" });
    ptys[0]!.emit("two\r\n");
    ptys[0]!.emit(finished(0));
    await Promise.resolve();

    expect(facts.map((fact) => fact.type)).toEqual(["terminal-command-submitted", "terminal-command-finished"]);
    const completion = facts[1];
    expect(completion).toMatchObject({ type: "terminal-command-finished", evidence: { command: "cat", exitStatus: 0, interactions: [
      { type: "terminal-output", data: "one\r\n" },
      { type: "interactive-input", data: "two\r" },
      { type: "terminal-output", data: "two\r\n" },
    ] } });
  });

  it("drops an unfinished command when a later Bash command supersedes it", async () => {
    const { manager, ptys, facts } = setup();
    manager.attach(new FakeClient());
    ptys[0]!.emit(marker("old"));
    ptys[0]!.emit("old output");
    ptys[0]!.emit(marker("new"));
    ptys[0]!.emit("new output");
    ptys[0]!.emit(finished());
    await Promise.resolve();

    expect(facts).toHaveLength(3);
    expect(facts[2]).toMatchObject({ type: "terminal-command-finished", evidence: { command: "new" } });
  });
});
