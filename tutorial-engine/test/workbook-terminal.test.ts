import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS, OPENCODE_API_KEY_ENV, WORKBOOK_TERMINAL_AUTH_CLEANUP_PUBLIC_ERROR, WORKBOOK_TERMINAL_AUTH_PUBLIC_ERROR, WORKBOOK_TERMINAL_STARTUP_CLEANUP_PUBLIC_ERROR, WORKBOOK_TERMINAL_STARTUP_PUBLIC_ERROR, WorkbookTerminalManager, createDockerPty, dockerClientEnvironment, dockerContainerUser, dockerExecArguments, dockerRunArguments, dockerRunEnvironment, publicTerminalTranscript, type ActiveObservedTerminalBlock, type DockerCommandRunner, type TerminalClient, type TerminalPty, type TerminalPtyFactory, type TerminalPtyOptions } from "../src/workbook/terminal.js";
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolveDeferred = resolvePromise; rejectDeferred = rejectPromise; });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

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
  it("installs Git and jq without recommendations and isolates its ambient configuration", async () => {
    const dockerfile = await readFile(resolve("docker/workbook-terminal.Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/apt-get install\s+--yes\s+--no-install-recommends\s+git\s+jq/);
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*");
    expect(dockerfile).toContain("COPY package.json package-lock.json ./");
    expect(dockerfile).toContain("npm ci --workspace=tutorial/workspaces/refactor-line/calculator --include=dev --ignore-scripts");
    expect(dockerfile).toContain("ln -s /opt/workbook/node_modules /workspace/node_modules");
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

    const args = dockerRunArguments({ workspace, name: "terminal" });

    expect(args.join("\n")).toContain(`src=${workspace},dst=/workspace`);
    expect(args.join("\n")).toContain("--env\nOPENCODE_API_KEY");
    expect(args.join("\n")).not.toContain("test-key");
    expect(args.join("\n")).not.toContain("OPENCODE_API_KEY=");
    expect(args.join("\n")).not.toContain(`dst=/workspace,readonly`);
    expect(args.join("\n")).not.toContain(`dst=/workspace/sibling`);
    expect(dockerRunEnvironment("test-key", { PATH: "/bin" })).toEqual({ PATH: "/bin", OPENCODE_API_KEY: "test-key" });
  });

  it("uses a minimal Docker client environment without forwarding arbitrary secrets or proxy credentials", () => {
    const parent = {
      PATH: "/bin",
      HOME: "/home/learner",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_CONFIG: "/home/learner/.docker",
      XDG_RUNTIME_DIR: "/run/user/1000",
      OPENCODE_API_KEY: "parent-key",
      HTTPS_PROXY: "http://proxy-user:proxy-secret@example.test",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      NPM_TOKEN: "npm-secret"
    };

    expect(dockerClientEnvironment(parent)).toEqual({
      PATH: "/bin",
      HOME: "/home/learner",
      DOCKER_CONFIG: "/home/learner/.docker",
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      XDG_RUNTIME_DIR: "/run/user/1000"
    });
    expect(dockerRunEnvironment("child-key", parent)).toEqual({
      PATH: "/bin",
      HOME: "/home/learner",
      DOCKER_CONFIG: "/home/learner/.docker",
      DOCKER_CONTEXT: "desktop-linux",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      XDG_RUNTIME_DIR: "/run/user/1000",
      OPENCODE_API_KEY: "child-key"
    });
    expect(JSON.stringify(dockerRunEnvironment("child-key", parent))).not.toContain("proxy-secret");
    expect(JSON.stringify(dockerRunEnvironment("child-key", parent))).not.toContain("aws-secret");
    expect(JSON.stringify(dockerRunEnvironment("child-key", parent))).not.toContain("npm-secret");
    expect(JSON.stringify(dockerRunEnvironment("child-key", parent))).not.toContain("parent-key");
  });

  it("rejects asynchronous production Docker command runners during terminal startup", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "workbook-terminal-async-runner-"));
    tempDirs.push(workspace);
    await expect(() => createDockerPty({
      cwd: workspace,
      cols: 80,
      rows: 24,
      environment: { [OPENCODE_API_KEY_ENV]: "not-recorded", PATH: "/bin" },
      dockerCommandRunner: (() => Promise.resolve()) as any
    })).toThrow("Docker command runner must complete synchronously.");
    await Promise.resolve();
  });

  it("strictly cleans up attempted production docker startup failures with sanitized precedence", async () => {
    for (const [failAt, cleanupFails, expected, expectedStages] of [
      ["run", false, WORKBOOK_TERMINAL_STARTUP_PUBLIC_ERROR, ["info", "image", "run", "cleanup"]],
      ["run", true, WORKBOOK_TERMINAL_STARTUP_CLEANUP_PUBLIC_ERROR, ["info", "image", "run", "cleanup"]],
      ["pi-auth", false, WORKBOOK_TERMINAL_AUTH_PUBLIC_ERROR, ["info", "image", "run", "pi-auth", "cleanup"]],
      ["pi-auth", true, WORKBOOK_TERMINAL_AUTH_CLEANUP_PUBLIC_ERROR, ["info", "image", "run", "pi-auth", "cleanup"]]
    ] as const) {
      const workspace = await mkdtemp(resolve(tmpdir(), "workbook-terminal-startup-"));
      tempDirs.push(workspace);
      const calls: Array<{ stage: string; args: string[]; timeout: number }> = [];
      const runner: DockerCommandRunner = (_file, args, options) => {
        const stage = args[0] === "image" ? "image" : args[0] === "exec" ? "pi-auth" : args[0] === "rm" ? "cleanup" : args[0] ?? "unknown";
        calls.push({ stage, args, timeout: options.timeout });
        if (stage === failAt || (stage === "cleanup" && cleanupFails)) throw new Error(`${stage} raw cause not-recorded ${workspace}`);
      };

      let message = "";
      try {
        createDockerPty({ cwd: workspace, cols: 80, rows: 24, environment: { [OPENCODE_API_KEY_ENV]: "not-recorded", PATH: "/bin" }, dockerCommandRunner: runner });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe(expected);
      expect(calls.map((call) => call.stage)).toEqual(expectedStages);
      expect(calls.at(-1)).toMatchObject({ stage: "cleanup", timeout: DOCKER_TERMINAL_COMMAND_TIMEOUTS_MS.cleanup });
      expect(calls.at(-1)?.args).toEqual(["rm", "-f", expect.stringMatching(/^workbook-terminal-/)]);
      expect(calls.at(-1)?.args.join(" ")).not.toContain(workspace);
      for (const call of calls) {
        expect(call.args.join(" ")).not.toContain("not-recorded");
        expect(call.args.join(" ")).not.toContain("raw cause");
      }
      expect(message).not.toContain("not-recorded");
      expect(message).not.toContain(workspace);
      expect(message).not.toContain("raw cause");
    }
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

  it("tracks pending input epochs until observation sinks resolve", async () => {
    const submittedSink = deferred<void>();
    const facts: TerminalObservationFact[] = [];
    const ptys: FakePty[] = [];
    const manager = new WorkbookTerminalManager({
      workspace: "/tmp/workspace",
      getActiveBlock: () => activePractice,
      observationSink: async (fact) => { facts.push(fact); await submittedSink.promise; },
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    manager.attach(new FakeClient());

    manager.receive({ type: "input", data: "npm test\r" });
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);
    expect(manager.acquireCompletionFence(activePractice)).toBe(false);

    ptys[0]!.emit(marker("npm test"));
    await Promise.resolve();
    expect(facts).toEqual([expect.objectContaining({ type: "terminal-command-submitted", command: "npm test" })]);
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);
    expect(manager.acquireCompletionFence(activePractice)).toBe(false);

    submittedSink.resolve();
    await submittedSink.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasUnobservedInput(activePractice)).toBe(false);
  });

  it("cancels erased partial input epochs and collapses multiline input on one Bash observation", async () => {
    const submittedSink = deferred<void>();
    const facts: TerminalObservationFact[] = [];
    const ptys: FakePty[] = [];
    const manager = new WorkbookTerminalManager({
      workspace: "/tmp/workspace",
      getActiveBlock: () => activePractice,
      observationSink: async (fact) => { facts.push(fact); await submittedSink.promise; },
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    manager.attach(new FakeClient());

    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
    manager.releaseCompletionFence(activePractice);

    manager.receive({ type: "input", data: "\x1b[" });
    manager.receive({ type: "input", data: "A" });
    expect(manager.hasUnobservedInput(activePractice)).toBe(false);
    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
    manager.releaseCompletionFence(activePractice);

    manager.receive({ type: "input", data: "np" });
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);
    expect(manager.acquireCompletionFence(activePractice)).toBe(false);
    manager.receive({ type: "input", data: "\x7f\x7f" });
    expect(manager.hasUnobservedInput(activePractice)).toBe(false);
    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
    manager.releaseCompletionFence(activePractice);

    manager.receive({ type: "input", data: "ab\u0015" });
    expect(manager.hasUnobservedInput(activePractice)).toBe(false);
    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
    manager.releaseCompletionFence(activePractice);

    manager.receive({ type: "input", data: "cd\u0003" });
    expect(manager.hasUnobservedInput(activePractice)).toBe(false);
    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
    manager.releaseCompletionFence(activePractice);

    manager.receive({ type: "input", data: "echo one \\\r" });
    manager.receive({ type: "input", data: "  && echo two\r" });
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);
    ptys[0]!.emit(marker("echo one && echo two"));
    await Promise.resolve();
    expect(facts).toEqual([expect.objectContaining({ type: "terminal-command-submitted", command: "echo one && echo two" })]);
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);

    submittedSink.resolve();
    await submittedSink.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasUnobservedInput(activePractice)).toBe(false);
    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
  });

  it("ignores late old lifecycle sink resolution after recreating the same terminal block key", async () => {
    const oldSink = deferred<void>();
    const newSink = deferred<void>();
    const facts: TerminalObservationFact[] = [];
    const ptys: FakePty[] = [];
    const manager = new WorkbookTerminalManager({
      workspace: "/tmp/workspace",
      getActiveBlock: () => activePractice,
      observationSink: async (fact) => {
        facts.push(fact);
        if (fact.type === "terminal-command-submitted" && fact.command === "old") await oldSink.promise;
        if (fact.type === "terminal-command-submitted" && fact.command === "new") await newSink.promise;
      },
      ptyFactory: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    });
    manager.attach(new FakeClient());

    manager.receive({ type: "input", data: "old\r" });
    ptys[0]!.emit(marker("old"));
    await Promise.resolve();
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);

    manager.resetAfterTerminalContinuation(activePractice);
    expect(ptys[0]!.killed).toBe(true);
    manager.attach(new FakeClient());
    manager.receive({ type: "input", data: "new\r" });
    ptys[1]!.emit(marker("new"));
    await Promise.resolve();
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);

    oldSink.resolve();
    await oldSink.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasUnobservedInput(activePractice)).toBe(true);
    expect(manager.acquireCompletionFence(activePractice)).toBe(false);

    newSink.resolve();
    await newSink.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.hasUnobservedInput(activePractice)).toBe(false);
    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
    expect(facts).toEqual([
      expect.objectContaining({ type: "terminal-command-submitted", command: "old" }),
      expect.objectContaining({ type: "terminal-command-submitted", command: "new" })
    ]);
  });

  it("ignores old completion fence release and reset callbacks after a lifecycle change", () => {
    const { manager, ptys } = setup();
    manager.attach(new FakeClient());
    const oldCompletionBlock = { ...activePractice };
    expect(manager.acquireCompletionFence(oldCompletionBlock)).toBe(true);

    manager.resetAfterTerminalContinuation(oldCompletionBlock);
    expect(ptys[0]!.killed).toBe(true);

    const client = new FakeClient();
    manager.attach(client);
    const newCompletionBlock = { ...activePractice };
    expect(manager.acquireCompletionFence(newCompletionBlock)).toBe(true);
    manager.releaseCompletionFence(oldCompletionBlock);
    manager.resetAfterTerminalContinuation(oldCompletionBlock);
    manager.receive({ type: "input", data: "echo should not run\r" });

    expect(ptys[1]!.killed).toBe(false);
    expect(ptys[1]!.writes).toEqual([]);
    expect(client.messages.at(-1)?.data).toContain("not run");

    manager.releaseCompletionFence(newCompletionBlock);
    manager.receive({ type: "input", data: "echo restored\r" });
    expect(ptys[1]!.writes).toEqual(["echo restored\r"]);
  });

  it("rejects input after a completion fence without writing to transcript, observation, or PTY, then restores input on release", () => {
    const { manager, ptys, facts } = setup();
    const client = new FakeClient();
    manager.attach(client);

    expect(manager.acquireCompletionFence(activePractice)).toBe(true);
    manager.receive({ type: "input", data: "echo should not run\r" });

    expect(ptys[0]!.writes).toEqual([]);
    expect(facts).toEqual([]);
    expect(manager.activeTranscriptContext()).toBeUndefined();
    expect(client.messages.at(-1)).toMatchObject({ type: "output" });
    expect(client.messages.at(-1)?.data).toContain("not run");

    manager.releaseCompletionFence(activePractice);
    manager.receive({ type: "input", data: "echo restored\r" });
    expect(ptys[0]!.writes).toEqual(["echo restored\r"]);
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
