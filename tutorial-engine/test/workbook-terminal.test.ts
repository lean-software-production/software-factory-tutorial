import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDockerTerminalReady, dockerContainerUser, dockerExecArguments, dockerRunArguments, WorkbookTerminalManager, type SubmitAttempt, type TerminalClient, type TerminalPty, type TerminalPtyFactory } from "../src/workbook/terminal.js";

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

function setup(submitAttempt: SubmitAttempt = vi.fn(async () => undefined), debounceMs = 5, maxTranscriptBytes = 120) {
  let active: any = { lessonId: "lesson", blockId: "practice", command: "npm test", context: "root", expectedObservation: "tests pass" };
  const ptys: FakePty[] = [];
  const factory: TerminalPtyFactory = ({ cwd }) => { const pty = new FakePty(); pty.cwd = cwd; ptys.push(pty); return pty; };
  const manager = new WorkbookTerminalManager({
    workspace: "/tmp/workspace",
    getActiveBlock: () => active,
    submitAttempt,
    ptyFactory: factory,
    debounceMs,
    maxTranscriptBytes
  });
  return { manager, ptys, setActive: (next: any) => { active = next; }, submitAttempt };
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("WorkbookTerminalManager", () => {
  it("uses the host identity so the isolated Pi state is writable", () => {
    expect(dockerContainerUser()).toBe(`${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`);
  });

  it("mounts only learner work roots read-write and supplies Pi with the API key", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "workbook-terminal-mounts-"));
    tempDirs.push(workspace);
    await mkdir(resolve(workspace, "factory/refactor/.tmp"), { recursive: true });
    await mkdir(resolve(workspace, "calculator"));
    await mkdir(resolve(workspace, ".tutorial/.tmp"), { recursive: true });
    await mkdir(resolve(workspace, ".git"));
    const dependencyRoot = await mkdtemp(resolve(tmpdir(), "workbook-terminal-deps-"));
    tempDirs.push(dependencyRoot);
    await mkdir(resolve(dependencyRoot, "node_modules/.bin"), { recursive: true });
    await writeFile(resolve(dependencyRoot, "package.json"), "{}\n", "utf8");
    await mkdir(resolve(dependencyRoot, ".git"));

    const args = dockerRunArguments({ workspace, dependencyRoot, name: "workbook-terminal-test", apiKey: "test-opencode-key" });
    const mounts = args.filter((arg) => arg.startsWith("type=bind"));

    expect(args).toContain("--read-only");
    expect(args).toContain("--env");
    expect(args).toContain("OPENCODE_API_KEY=test-opencode-key");
    expect(args).toContain("--tmpfs");
    expect(args.some((arg) => /^\/home\/learner\/\.pi\/agent:uid=.+,gid=.+,mode=0700$/.test(arg))).toBe(true);
    expect(mounts).toContain(`type=bind,src=${workspace},dst=/workspace,readonly`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, "factory")},dst=/workspace/factory`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, "calculator")},dst=/workspace/calculator`);
    expect(mounts).not.toContain(`type=bind,src=${resolve(workspace, ".tutorial/.tmp")},dst=/workspace/.tutorial/.tmp`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, ".git")},dst=/workspace/.git`);
    expect(mounts).toContain(`type=bind,src=${resolve(dependencyRoot, "node_modules")},dst=/workspace/node_modules,readonly`);
    expect(mounts).toContain(`type=bind,src=${resolve(dependencyRoot, "package.json")},dst=/workspace/package.json,readonly`);
    expect(mounts).not.toContain(`type=bind,src=${resolve(dependencyRoot, ".git")},dst=/workspace/.git,readonly`);
    expect(mounts).not.toContain(expect.stringContaining("auth.json"));
    expect(mounts).not.toContain(`type=bind,src=${workspace},dst=/workspace`);
  });

  it("rejects terminal preflight before Docker work when OPENCODE_API_KEY is absent", () => {
    const previous = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      expect(() => assertDockerTerminalReady()).toThrow(/OPENCODE_API_KEY/);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previous;
    }
  });

  it("preflights Pi authentication in the same isolated container it will run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbook-fake-docker-"));
    tempDirs.push(directory);
    const capture = join(directory, "docker-args");
    const docker = join(directory, "docker");
    await writeFile(docker, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$WORKBOOK_TERMINAL_DOCKER_ARGS\"\nprintf '%s\\n' --- >> \"$WORKBOOK_TERMINAL_DOCKER_ARGS\"\n");
    await chmod(docker, 0o755);
    const previousPath = process.env.PATH;
    const previousKey = process.env.OPENCODE_API_KEY;
    const previousCapture = process.env.WORKBOOK_TERMINAL_DOCKER_ARGS;
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.OPENCODE_API_KEY = "test-opencode-key";
    process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = capture;
    try {
      assertDockerTerminalReady("/workspace");
      const args = await readFile(capture, "utf8");
      expect(args).toMatch(/run\n-d\n--rm\n--name\nworkbook-terminal-preflight-/);
      expect(args).toContain("exec\nworkbook-terminal-preflight-");
      expect(args).toContain("--input-type=module\n-e\n");
      expect(args).toContain("rm\n-f\nworkbook-terminal-preflight-");
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousKey;
      if (previousCapture === undefined) delete process.env.WORKBOOK_TERMINAL_DOCKER_ARGS; else process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = previousCapture;
    }
  });

  it("refuses startup when Pi cannot authenticate inside the terminal container", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbook-fake-docker-"));
    tempDirs.push(directory);
    const docker = join(directory, "docker");
    await writeFile(docker, "#!/bin/sh\nif [ \"$1\" = exec ]; then exit 1; fi\n");
    await chmod(docker, 0o755);
    const previousPath = process.env.PATH;
    const previousKey = process.env.OPENCODE_API_KEY;
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.OPENCODE_API_KEY = "test-opencode-key";
    try {
      expect(() => assertDockerTerminalReady("/workspace")).toThrow(/could not authenticate pi/i);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousKey;
    }
  });

  it("starts a bare Bash prompt without resolving a container user", () => {
    expect(dockerExecArguments("workbook-terminal-test")).toEqual([
      "exec", "-it", "--env", "PS1=$ ", "--workdir", "/workspace", "workbook-terminal-test",
      "/bin/bash", "--noprofile", "--norc", "-i"
    ]);
  });

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

  it("submits paused bounded transcripts and frozen terminal HTML as attempt evidence", async () => {
    vi.useFakeTimers();
    const submitAttempt = vi.fn(async () => undefined);
    const { manager, ptys } = setup(submitAttempt, 20, 80);
    const client = new FakeClient();
    manager.attach(client);
    manager.receive({ type: "input", data: `echo ${"x".repeat(80)}\r` });
    expect(client.messages.at(-1)).toMatchObject({ type: "attempt-status", blockId: "practice", status: "running" });
    ptys[0]!.emitData("\u001b[32m<tag> short output\u001b[0m");
    await vi.advanceTimersByTimeAsync(25);

    expect(submitAttempt).toHaveBeenCalledTimes(1);
    expect(submitAttempt.mock.calls[0]![0]).toMatchObject({
      lessonId: "lesson",
      blockId: "practice",
      privateGuidance: "tests pass",
      evidence: { kind: "terminal", terminalHtml: expect.stringContaining("&lt;tag&gt; short output") }
    });
    expect(submitAttempt.mock.calls[0]![0].evidence.transcript.length).toBeLessThanOrEqual(80);
    expect(submitAttempt.mock.calls[0]![0].evidence.terminalHtml).not.toContain("\u001b[");
    expect(client.messages.at(-1)).toMatchObject({ type: "attempt-status", blockId: "practice", status: "submitted" });
  });

  it("retains bounded terminal attempts as reflection evidence in memory", () => {
    const { manager, ptys } = setup();
    manager.attach(new FakeClient());
    manager.receive({ type: "input", data: "wrong command\r" });
    ptys[0]!.emitData("command not found");
    const [evidence] = manager.practiceTranscripts();
    expect(evidence).toMatchObject({ lessonId: "lesson", blockId: "practice" });
    expect(evidence?.transcript).toContain("wrong command");
    expect(evidence?.transcript).toContain("command not found");
  });

  it("does not submit attempts for inactive or non-observed blocks", async () => {
    vi.useFakeTimers();
    const submitAttempt = vi.fn(async () => undefined);
    const { manager, ptys, setActive } = setup(submitAttempt, 5);
    setActive(undefined);
    manager.attach(new FakeClient());
    manager.receive({ type: "input", data: "npm test\r" });
    ptys[0]!.emitData("pass");
    await vi.advanceTimersByTimeAsync(10);
    expect(submitAttempt).not.toHaveBeenCalled();
  });

  it("reports attempt submission failure without external-terminal fallback wording", async () => {
    vi.useFakeTimers();
    const { manager, ptys } = setup(async () => { throw new Error("adapter down"); }, 5);
    const client = new FakeClient();
    manager.attach(client);
    manager.receive({ type: "input", data: "npm test\r" });
    ptys[0]!.emitData("output");
    await vi.advanceTimersByTimeAsync(10);
    const error = client.messages.find((message) => message.type === "attempt-error");
    expect(error).toMatchObject({ blockId: "practice", message: expect.stringMatching(/could not submit/i) });
    expect(error.message).not.toMatch(/external|own terminal|fallback/i);
  });

  it("reports a PTY startup failure without external-terminal fallback wording", () => {
    const manager = new WorkbookTerminalManager({
      workspace: "/tmp/workspace", getActiveBlock: () => undefined, submitAttempt: async () => undefined,
      ptyFactory: () => { throw new Error("spawn failed"); }
    });
    const client = new FakeClient();
    expect(manager.attach(client)).toBe(true);
    expect(client.messages).toContainEqual({ type: "terminal-error", message: expect.stringMatching(/could not start/i) });
    expect(JSON.stringify(client.messages)).not.toMatch(/external|own terminal|fallback/i);
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
