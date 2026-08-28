import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDockerTerminalReady, createDockerPty, dockerContainerUser, dockerExecArguments, dockerRunArguments, WorkbookTerminalManager, type SubmitAttempt, type TerminalClient, type TerminalPty, type TerminalPtyFactory } from "../src/workbook/terminal.js";
import { trustRuntimeProvision } from "../src/workbook/runtime-provision.js";

class FakePty implements TerminalPty {
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  opens = 0;
  cwd = "";
  #data: ((data: string) => void)[] = [];
  #exit: ((event: { exitCode: number }) => void)[] = [];
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.killed = true; }
  open(): void { this.opens += 1; }
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

const redactingFakeDocker = "#!/bin/sh\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    OPENCODE_API_KEY=*) printf '%s\\n' 'OPENCODE_API_KEY=<redacted>' >> \"$WORKBOOK_TERMINAL_DOCKER_ARGS\" ;;\n    *) printf '%s\\n' \"$arg\" >> \"$WORKBOOK_TERMINAL_DOCKER_ARGS\" ;;\n  esac\ndone\nprintf '%s\\n' --- >> \"$WORKBOOK_TERMINAL_DOCKER_ARGS\"\n";

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

  it("mounts no external runtime paths by default while keeping learner work roots writable", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "workbook-terminal-mounts-"));
    tempDirs.push(workspace);
    await mkdir(resolve(workspace, "factory/refactor/.tmp"), { recursive: true });
    await mkdir(resolve(workspace, "calculator"));
    await mkdir(resolve(workspace, ".tmp"));
    await mkdir(resolve(workspace, ".tutorial/.tmp"), { recursive: true });
    await mkdir(resolve(workspace, ".git"));

    const args = dockerRunArguments({ workspace, name: "workbook-terminal-test", apiKey: "<redacted>" });
    const mounts = args.filter((arg) => arg.startsWith("type=bind"));

    expect(args).toContain("--read-only");
    const envIndex = args.indexOf("--env");
    expect(args[envIndex + 1]).toMatch(/^OPENCODE_API_KEY=.+/);
    expect(args).toContain("--tmpfs");
    expect(args.some((arg) => /^\/home\/learner\/\.pi\/agent:uid=.+,gid=.+,mode=0700$/.test(arg))).toBe(true);
    expect(mounts).toContain(`type=bind,src=${workspace},dst=/workspace,readonly`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, "factory")},dst=/workspace/factory`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, "calculator")},dst=/workspace/calculator`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, ".tmp")},dst=/workspace/.tmp`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, ".tutorial/.tmp")},dst=/workspace/.tutorial/.tmp`);
    expect(mounts).toContain(`type=bind,src=${resolve(workspace, ".git")},dst=/workspace/.git`);
    expect(mounts).not.toContain(expect.stringContaining("auth.json"));
    expect(mounts).not.toContain(`type=bind,src=${workspace},dst=/workspace`);
    expect(mounts.filter((mount) => mount.endsWith(",readonly"))).toEqual([`type=bind,src=${workspace},dst=/workspace,readonly`]);
  });

  it("mounts trusted runtime provision sources read-only at safe workspace targets", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "workbook-terminal-workspace-"));
    const runtimeSource = await mkdtemp(resolve(tmpdir(), "workbook-runtime-source-"));
    tempDirs.push(workspace, runtimeSource);
    await mkdir(resolve(workspace, "runtime-tools"));
    const runtimeProvision = trustRuntimeProvision({ mounts: [{ source: runtimeSource, target: "runtime-tools", readonly: true }] });

    const args = dockerRunArguments({ workspace, runtimeProvision, name: "workbook-terminal-test", apiKey: "<redacted>" });
    const mounts = args.filter((arg) => arg.startsWith("type=bind"));

    const runtimeHostSource = runtimeProvision.mounts[0]!.hostSource;
    expect(mounts).toContain(`type=bind,src=${runtimeHostSource},dst=/workspace/runtime-tools,readonly`);
    expect(mounts).not.toContain(`type=bind,src=${runtimeHostSource},dst=/workspace/runtime-tools`);
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

  it("prepares root .tmp as writable learner scratch before Docker preflight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbook-fake-docker-"));
    const workspace = await mkdtemp(join(tmpdir(), "workbook-terminal-workspace-"));
    tempDirs.push(directory, workspace);
    const capture = join(directory, "docker-args");
    const docker = join(directory, "docker");
    await writeFile(docker, redactingFakeDocker);
    await chmod(docker, 0o755);
    const previousPath = process.env.PATH;
    const previousKey = process.env.OPENCODE_API_KEY;
    const previousCapture = process.env.WORKBOOK_TERMINAL_DOCKER_ARGS;
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.OPENCODE_API_KEY = "<redacted>";
    process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = capture;
    try {
      assertDockerTerminalReady(workspace);
      expect((await stat(resolve(workspace, ".tmp"))).isDirectory()).toBe(true);
      expect((await stat(resolve(workspace, ".tutorial/.tmp"))).isDirectory()).toBe(true);
      const args = await readFile(capture, "utf8");
      expect(args).toContain(`type=bind,src=${resolve(workspace, ".tmp")},dst=/workspace/.tmp`);
      expect(args).toContain(`type=bind,src=${resolve(workspace, ".tutorial/.tmp")},dst=/workspace/.tutorial/.tmp`);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousKey;
      if (previousCapture === undefined) delete process.env.WORKBOOK_TERMINAL_DOCKER_ARGS; else process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = previousCapture;
    }
  });

  it("passes trusted runtime provision through Docker preflight without creating target directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbook-fake-docker-"));
    const workspace = await mkdtemp(join(tmpdir(), "workbook-terminal-workspace-"));
    const runtimeSource = await mkdtemp(join(tmpdir(), "workbook-runtime-source-"));
    tempDirs.push(directory, workspace, runtimeSource);
    const runtimeProvision = trustRuntimeProvision({ mounts: [{ source: runtimeSource, target: "runtime-tools", readonly: true }] });
    const capture = join(directory, "docker-args");
    const docker = join(directory, "docker");
    await writeFile(docker, redactingFakeDocker);
    await chmod(docker, 0o755);
    const previousPath = process.env.PATH;
    const previousKey = process.env.OPENCODE_API_KEY;
    const previousCapture = process.env.WORKBOOK_TERMINAL_DOCKER_ARGS;
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.OPENCODE_API_KEY = "<redacted>";
    process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = capture;
    try {
      assertDockerTerminalReady({ workspace, runtimeProvision });
      await expect(stat(resolve(workspace, "runtime-tools"))).rejects.toThrow();
      const args = await readFile(capture, "utf8");
      expect(args).toContain(`type=bind,src=${runtimeProvision.mounts[0]!.hostSource},dst=/workspace/runtime-tools,readonly`);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousKey;
      if (previousCapture === undefined) delete process.env.WORKBOOK_TERMINAL_DOCKER_ARGS; else process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = previousCapture;
    }
  });

  it("rejects unsafe or writable runtime provision declarations before Docker arguments are built", async () => {
    const runtimeSource = await mkdtemp(resolve(tmpdir(), "workbook-runtime-source-"));
    tempDirs.push(runtimeSource);

    for (const target of ["/absolute", "../escape", "safe/../escape", "safe//empty", ".", ".git/hooks"]) {
      expect(() => trustRuntimeProvision({ mounts: [{ source: runtimeSource, target, readonly: true }] })).toThrow(/runtime mount target|git metadata/i);
    }
    expect(() => trustRuntimeProvision({ mounts: [{ source: runtimeSource, target: "safe", readonly: false as true }] })).toThrow(/read-only/i);
    expect(() => trustRuntimeProvision({ mounts: [
      { source: runtimeSource, target: "safe", readonly: true },
      { source: runtimeSource, target: "safe", readonly: true },
    ] })).toThrow(/duplicate/i);
    expect(() => trustRuntimeProvision({ mounts: [
      { source: runtimeSource, target: "safe", readonly: true },
      { source: runtimeSource, target: "safe/nested", readonly: true },
    ] })).toThrow(/conflicting/i);
  });

  it("preflights Pi authentication in the same isolated container it will run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbook-fake-docker-"));
    const workspace = await mkdtemp(join(tmpdir(), "workbook-terminal-workspace-"));
    tempDirs.push(directory, workspace);
    const capture = join(directory, "docker-args");
    const docker = join(directory, "docker");
    await writeFile(docker, redactingFakeDocker);
    await chmod(docker, 0o755);
    const previousPath = process.env.PATH;
    const previousKey = process.env.OPENCODE_API_KEY;
    const previousCapture = process.env.WORKBOOK_TERMINAL_DOCKER_ARGS;
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.OPENCODE_API_KEY = "<redacted>";
    process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = capture;
    try {
      assertDockerTerminalReady(workspace);
      const args = await readFile(capture, "utf8");
      expect(args).toMatch(/run\n-d\n--rm\n--name\nworkbook-terminal-/);
      expect(args).not.toContain("workbook-terminal-preflight-");
      expect(args).toContain("exec\nworkbook-terminal-");
      expect(args).toContain("--input-type=module\n-e\n");
      expect(args).toContain("rm\n-f\nworkbook-terminal-");
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousKey;
      if (previousCapture === undefined) delete process.env.WORKBOOK_TERMINAL_DOCKER_ARGS; else process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = previousCapture;
    }
  });

  it("refuses startup when Pi cannot authenticate inside the terminal container", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbook-fake-docker-"));
    const workspace = await mkdtemp(join(tmpdir(), "workbook-terminal-workspace-"));
    tempDirs.push(directory, workspace);
    const docker = join(directory, "docker");
    await writeFile(docker, "#!/bin/sh\nif [ \"$1\" = exec ]; then exit 1; fi\n");
    await chmod(docker, 0o755);
    const previousPath = process.env.PATH;
    const previousKey = process.env.OPENCODE_API_KEY;
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.OPENCODE_API_KEY = "<redacted>";
    try {
      expect(() => assertDockerTerminalReady(workspace)).toThrow(/could not authenticate pi/i);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousKey;
    }
  });

  it("starts and preflights the retained Docker container without opening an interactive shell", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workbook-fake-docker-"));
    const workspace = await mkdtemp(join(tmpdir(), "workbook-terminal-workspace-"));
    tempDirs.push(directory, workspace);
    const capture = join(directory, "docker-args");
    const docker = join(directory, "docker");
    await writeFile(docker, redactingFakeDocker);
    await chmod(docker, 0o755);
    const previousPath = process.env.PATH;
    const previousKey = process.env.OPENCODE_API_KEY;
    const previousCapture = process.env.WORKBOOK_TERMINAL_DOCKER_ARGS;
    process.env.PATH = `${directory}:${previousPath}`;
    process.env.OPENCODE_API_KEY = "<redacted>";
    process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = capture;
    try {
      const terminal = createDockerPty({ cwd: workspace, cols: 90, rows: 24 });
      try {
        const args = await readFile(capture, "utf8");
        expect(args).toMatch(/run\n-d\n--rm\n--name\nworkbook-terminal-/);
        expect(args).toContain("exec\nworkbook-terminal-");
        expect(args).toContain("--input-type=module\n-e\n");
        expect(args).not.toContain("exec\n-it\n");
      } finally {
        (terminal as any).stopContainer?.();
      }
      const afterDispose = await readFile(capture, "utf8");
      expect(afterDispose).toContain("rm\n-f\nworkbook-terminal-");
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousKey;
      if (previousCapture === undefined) delete process.env.WORKBOOK_TERMINAL_DOCKER_ARGS; else process.env.WORKBOOK_TERMINAL_DOCKER_ARGS = previousCapture;
    }
  });

  it("passes private Bash prompt protocol environment", () => {
    const args = dockerExecArguments("workbook-terminal-test");

    expect(args).toContain("PS1=$ ");
    expect(args).toContain("PS0=\x1b]633;workbook-command;$(fc -ln -1 | base64 -w 0)\x07");
    expect(args).toContain("PROMPT_COMMAND=status=$?; printf '\\033]633;workbook-finished;%s\\007' \"$status\"");
  });

  it("prestarts the terminal in the canonical workspace without opening a shell or writing a command", () => {
    const { manager, ptys } = setup();
    manager.start();
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.cwd).toBe("/tmp/workspace");
    expect(ptys[0]?.opens).toBe(0);
    expect(ptys[0]?.writes).toEqual([]);

    const client = new FakeClient();
    expect(manager.attach(client)).toBe(true);
    expect(ptys).toHaveLength(1);
    expect(ptys[0]?.opens).toBe(1);
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
    const submitAttempt = vi.fn<SubmitAttempt>(async () => undefined);
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
    // toMatchObject above does not narrow the evidence union for the checker, so narrow it here.
    const evidence = submitAttempt.mock.calls[0]![0].evidence;
    if (evidence.kind !== "terminal") throw new Error(`Expected terminal evidence, got ${evidence.kind}.`);
    expect(evidence.transcript.length).toBeLessThanOrEqual(80);
    expect(evidence.terminalHtml).not.toContain("\u001b[");
    expect(client.messages.at(-1)).toMatchObject({ type: "attempt-status", blockId: "practice", status: "submitted" });
  });

  it("submits a superseding paused snapshot when terminal output resumes", async () => {
    vi.useFakeTimers();
    const submitAttempt = vi.fn<SubmitAttempt>(async () => undefined);
    const { manager, ptys } = setup(submitAttempt, 5);
    manager.attach(new FakeClient());

    manager.receive({ type: "input", data: "npm test\r" });
    ptys[0]!.emitData("first result");
    await vi.advanceTimersByTimeAsync(6);
    ptys[0]!.emitData("late result");
    await vi.advanceTimersByTimeAsync(6);

    expect(submitAttempt).toHaveBeenCalledTimes(2);
    const firstEvidence = submitAttempt.mock.calls[0]![0].evidence;
    const secondEvidence = submitAttempt.mock.calls[1]![0].evidence;
    if (firstEvidence.kind !== "terminal" || secondEvidence.kind !== "terminal") throw new Error("Expected terminal evidence.");
    expect(firstEvidence.transcript).toContain("first result");
    expect(firstEvidence.transcript).not.toContain("late result");
    expect(secondEvidence.transcript).toContain("late result");
  });

  it("submits the newest generation after output changes during an in-flight observation", async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    const firstSubmission = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const submitAttempt = vi.fn<SubmitAttempt>(async () => {
      if (submitAttempt.mock.calls.length === 1) await firstSubmission;
    });
    const { manager, ptys } = setup(submitAttempt, 5);
    manager.attach(new FakeClient());

    manager.receive({ type: "input", data: "npm test\r" });
    ptys[0]!.emitData("first result");
    await vi.advanceTimersByTimeAsync(6);
    expect(submitAttempt).toHaveBeenCalledTimes(1);

    ptys[0]!.emitData("late result");
    await vi.advanceTimersByTimeAsync(6);
    expect(submitAttempt).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(6);

    expect(submitAttempt).toHaveBeenCalledTimes(2);
    const firstEvidence = submitAttempt.mock.calls[0]![0].evidence;
    const secondEvidence = submitAttempt.mock.calls[1]![0].evidence;
    if (firstEvidence.kind !== "terminal" || secondEvidence.kind !== "terminal") throw new Error("Expected terminal evidence.");
    expect(firstEvidence.transcript).not.toContain("late result");
    expect(secondEvidence.transcript).toContain("late result");
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
    const submitAttempt = vi.fn<SubmitAttempt>(async () => undefined);
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
