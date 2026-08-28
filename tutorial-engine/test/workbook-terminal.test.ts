import { describe, expect, it } from "vitest";
import { WorkbookTerminalManager, dockerContainerUser, dockerExecArguments, type ActiveObservedTerminalBlock, type TerminalClient, type TerminalPty, type TerminalPtyFactory } from "../src/workbook/terminal.js";
import type { TerminalObservationFact } from "../src/workbook/terminal-observation.js";

class FakePty implements TerminalPty {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  opened = 0;
  #data: Array<(data: string) => void> = [];
  #exit: Array<(event: { exitCode: number }) => void> = [];
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void {}
  open(): void { if (!this.opened) this.opened += 1; }
  onData(callback: (data: string) => void): void { this.#data.push(callback); }
  onExit(callback: (event: { exitCode: number }) => void): void { this.#exit.push(callback); }
  emit(data: string): void { this.#data.forEach((callback) => callback(data)); }
}

class FakeClient implements TerminalClient {
  messages: any[] = [];
  send(message: string): void { this.messages.push(JSON.parse(message)); }
  close(): void {}
}

function marker(command: string): string { return `\x1b]633;workbook-command;${Buffer.from(command).toString("base64")}\x07`; }
function finished(exitStatus = 0): string { return `\x1b]633;workbook-finished;${exitStatus}\x07`; }

const activePractice: ActiveObservedTerminalBlock = { lessonId: "lesson", blockId: "practice" };

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

describe("WorkbookTerminalManager", () => {
  it("uses the host identity and installs Bash's private command markers", () => {
    expect(dockerContainerUser()).toBe(`${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`);
    expect(dockerExecArguments("terminal").join(" ")).toContain("workbook-command");
    expect(dockerExecArguments("terminal").join(" ")).toContain("workbook-finished");
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

  it("rejects preactive input and does not observe markers before a terminal block is active", async () => {
    const { manager, ptys, facts, active } = setup({ initialActiveBlock: undefined });
    manager.start();
    manager.attach(new FakeClient());

    manager.receive({ type: "input", data: "echo bypass\r" });
    manager.receive({ type: "resize", cols: 100, rows: 30 });
    ptys[0]!.emit(marker("preactive"));
    await Promise.resolve();

    expect(ptys[0]!.writes).toEqual([]);
    expect(ptys[0]!.resizes).toEqual([[100, 30]]);
    expect(facts).toEqual([]);

    active.block = activePractice;
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
