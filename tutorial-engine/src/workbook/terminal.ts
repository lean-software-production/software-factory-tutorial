import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as pty from "node-pty";
import type { TutorialLogger } from "./runtime-log.js";
import { createTutorialLogger } from "./runtime-log.js";
import type { SubmitAttempt } from "./attempts.js";
import { NO_RUNTIME_PROVISION, type TrustedRuntimeProvision } from "./runtime-provision.js";
export type { SubmitAttempt } from "./attempts.js";

export type TerminalClient = { send(message: string): void; close(code?: number, reason?: string): void };
export type TerminalMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface TerminalPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  /** Activate an already-prepared terminal without writing learner bytes. */
  open?(): void;
}

export interface TerminalPtyOptions { cwd: string; cols: number; rows: number; runtimeProvision?: TrustedRuntimeProvision; }
interface DockerPty extends TerminalPty { stopContainer?(): void; }
const WORKBOOK_TERMINAL_IMAGE = "lean-software-production/workbook-terminal:latest";
const OPENCODE_API_KEY_ENV = "OPENCODE_API_KEY";
const CONTAINER_AGENT_DIR = "/home/learner/.pi/agent";
const PI_PREFLIGHT = [
  "const { execFileSync } = await import('node:child_process');",
  "const globalRoot = execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim();",
  "const { ModelRuntime } = await import(`${globalRoot}/@earendil-works/pi-coding-agent/dist/index.js`);",
  "if ((await ModelRuntime.create().then((runtime) => runtime.getAvailable())).length === 0) process.exit(1);"
].join(" ");
const DEFAULT_WRITABLE_WORKSPACE_PATHS = ["factory", "calculator", ".tmp", ".tutorial/.tmp", ".git"] as const;
const DEFAULT_WRITABLE_SCRATCH_DIRECTORIES = [".tmp", ".tutorial/.tmp"] as const;
export type TerminalPtyFactory = (options: TerminalPtyOptions) => TerminalPty;
export interface DockerRunArgumentsOptions { workspace: string; name: string; apiKey: string; writableWorkspacePaths?: readonly string[]; runtimeProvision?: TrustedRuntimeProvision; }

export interface ActiveObservedTerminalBlock {
  lessonId: string;
  blockId: string;
  command: string;
  context: string;
  expectedObservation: string;
}

export type PracticeTranscript = { lessonId: string; blockId: string; transcript: string };

export interface WorkbookTerminalManagerOptions {
  workspace: string;
  runtimeProvision?: TrustedRuntimeProvision;
  getActiveBlock(): ActiveObservedTerminalBlock | undefined;
  submitAttempt: SubmitAttempt;
  ptyFactory?: TerminalPtyFactory;
  logger?: TutorialLogger;
  debounceMs?: number;
  maxTranscriptBytes?: number;
}

const MAX_REPLAY_BYTES = 64_000;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 12_000;
const DEFAULT_DEBOUNCE_MS = 700;
const MAX_INPUT_BYTES = 16_384;
const MAX_COLS = 500;
const MAX_ROWS = 200;

function boundedAppend(previous: string, addition: string, limit: number): string {
  const next = previous + addition;
  return next.length > limit ? next.slice(-limit) : next;
}
function stripTerminalControls(text: string): string { return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); }
function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!); }

function terminalKey(block: ActiveObservedTerminalBlock): string { return `${block.lessonId}:${block.blockId}`; }

/** The tmpfs Pi state must be writable by the shell that runs inside the container. */
export function dockerContainerUser(): string {
  return `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`;
}

export function requireOpenCodeApiKey(): string {
  const key = process.env[OPENCODE_API_KEY_ENV]?.trim();
  if (!key) throw new Error(`Embedded terminal requires ${OPENCODE_API_KEY_ENV}.`);
  return key;
}

export function assertDockerTerminalReady(workspace: string | { workspace: string; runtimeProvision?: TrustedRuntimeProvision } = process.cwd()): void {
  const roots = typeof workspace === "string" ? { workspace, runtimeProvision: NO_RUNTIME_PROVISION } : { workspace: workspace.workspace, runtimeProvision: workspace.runtimeProvision ?? NO_RUNTIME_PROVISION };
  const terminal = createDockerPty({ cwd: roots.workspace, runtimeProvision: roots.runtimeProvision, cols: 90, rows: 24 }) as DockerPty;
  terminal.stopContainer?.();
}

function bindMount(src: string, dst: string, readonly = false): string {
  return `type=bind,src=${src},dst=${dst}${readonly ? ",readonly" : ""}`;
}

function prepareDefaultWritableWorkspaceDirectories(workspace: string): void {
  for (const child of DEFAULT_WRITABLE_SCRATCH_DIRECTORIES) mkdirSync(resolve(workspace, child), { recursive: true });
}

function assertSafeMountChild(child: string): void {
  const segments = child.split(/[\\/]+/);
  if (!child || isAbsolute(child) || /^[a-zA-Z]:[\\/]/.test(child) || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`Refusing unsafe mount path: ${child}`);
}

function insideRoot(root: string, candidate: string): boolean {
  const inside = relative(root, candidate);
  return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

function safeChildPath(root: string, child: string, label: string): string {
  assertSafeMountChild(child);
  const resolvedRoot = resolve(root);
  const realRoot = realpathSync(resolvedRoot);
  const candidate = resolve(resolvedRoot, child);
  const candidateUnderRealRoot = resolve(realRoot, child);
  if (insideRoot(realRoot, candidateUnderRealRoot)) return candidate;
  throw new Error(`Refusing to mount ${child} because it resolves outside the ${label}.`);
}

function safeExistingChildForMount(root: string, child: string, label: string): string | undefined {
  const candidate = safeChildPath(root, child, label);
  if (!existsSync(candidate)) return undefined;
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  if (insideRoot(realRoot, realCandidate)) return candidate;
  throw new Error(`Refusing to mount ${child} because it resolves outside the ${label}.`);
}

function workspaceChildForMount(workspace: string, child: string): string | undefined {
  return safeExistingChildForMount(workspace, child, "workbook workspace");
}

function assertDockerDaemonAndImage(): void {
  try { execFileSync("docker", ["info"], { stdio: "ignore" }); }
  catch { throw new Error("Docker must be running before starting the workbook terminal."); }
  try { execFileSync("docker", ["image", "inspect", WORKBOOK_TERMINAL_IMAGE], { stdio: "ignore" }); }
  catch { throw new Error(`Docker image ${WORKBOOK_TERMINAL_IMAGE} is missing. Run npm run --workspace=tutorial-engine build:workbook-terminal.`); }
}

function preflightPiAuthentication(name: string): void {
  try { execFileSync("docker", ["exec", name, "node", "--input-type=module", "-e", PI_PREFLIGHT], { stdio: "ignore", timeout: 20_000 }); }
  catch { throw new Error(`Could not authenticate Pi with ${OPENCODE_API_KEY_ENV} inside the workbook terminal.`); }
}

export function dockerRunArguments(options: DockerRunArgumentsOptions): string[] {
  const workspace = resolve(options.workspace);
  const provision = options.runtimeProvision ?? NO_RUNTIME_PROVISION;
  const [uid, gid] = dockerContainerUser().split(":");
  const args = ["run", "-d", "--rm", "--name", options.name, "--label", "workbook-terminal=true", "--user", dockerContainerUser(), "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=768m", "--cpus=1", "--network=bridge", "--init", "--env", `${OPENCODE_API_KEY_ENV}=${options.apiKey}`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--tmpfs", `${CONTAINER_AGENT_DIR}:uid=${uid},gid=${gid},mode=0700`, "--mount", bindMount(workspace, "/workspace", true), "--workdir", "/workspace"];
  for (const child of options.writableWorkspacePaths ?? DEFAULT_WRITABLE_WORKSPACE_PATHS) {
    const source = workspaceChildForMount(workspace, child);
    if (source) args.push("--mount", bindMount(source, `/workspace/${child}`));
  }
  for (const mount of provision.mounts) {
    args.push("--mount", bindMount(mount.hostSource, `/workspace/${mount.workspaceTarget}`, true));
  }
  return args;
}

export function dockerExecArguments(name: string): string[] {
  return ["exec", "-it", "--env", "PS1=$ ", "--workdir", "/workspace", name, "/bin/bash", "--noprofile", "--norc", "-i"];
}

/** Starts a hardened, per-practice container; browser bytes can only reach docker exec. */
export function createDockerPty(options: TerminalPtyOptions): TerminalPty {
  return new PreparedDockerPty(options);
}

class PreparedDockerPty implements DockerPty {
  readonly #workspace: string;
  readonly #runtimeProvision: TrustedRuntimeProvision | undefined;
  readonly #name = `workbook-terminal-${randomUUID()}`;
  #cols: number;
  #rows: number;
  #shell: TerminalPty | undefined;
  readonly #dataCallbacks: Array<(data: string) => void> = [];
  readonly #exitCallbacks: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  constructor(options: TerminalPtyOptions) {
    this.#workspace = resolve(options.cwd);
    this.#runtimeProvision = options.runtimeProvision;
    this.#cols = options.cols;
    this.#rows = options.rows;
    const apiKey = requireOpenCodeApiKey();
    assertDockerDaemonAndImage();
    prepareDefaultWritableWorkspaceDirectories(this.#workspace);
    const args = dockerRunArguments({ workspace: this.#workspace, runtimeProvision: this.#runtimeProvision, name: this.#name, apiKey });
    args.push(WORKBOOK_TERMINAL_IMAGE, "sleep", "infinity");
    try { execFileSync("docker", args, { stdio: "ignore" }); }
    catch (error) { throw new Error(`Could not start isolated terminal container: ${error instanceof Error ? error.message : String(error)}`); }
    try { preflightPiAuthentication(this.#name); }
    catch (error) { this.stopContainer(); throw error; }
  }

  open(): void {
    if (this.#shell) return;
    const shell = pty.spawn("docker", dockerExecArguments(this.#name), {
      name: "xterm-256color", cols: this.#cols, rows: this.#rows, cwd: this.#workspace, env: { ...process.env, TERM: "xterm-256color" }
    }) as TerminalPty;
    this.#shell = shell;
    shell.onData((data) => { for (const callback of this.#dataCallbacks) callback(data); });
    shell.onExit((event) => {
      this.#shell = undefined;
      for (const callback of this.#exitCallbacks) callback(event);
    });
  }

  write(data: string): void { this.open(); this.#shell?.write(data); }
  resize(cols: number, rows: number): void {
    this.#cols = cols;
    this.#rows = rows;
    this.#shell?.resize(cols, rows);
  }
  kill(): void { this.#shell?.kill(); this.#shell = undefined; }
  stopContainer(): void { this.kill(); try { execFileSync("docker", ["rm", "-f", this.#name], { stdio: "ignore" }); } catch { /* removal is best effort; --rm cleans a stopped container. */ } }
  onData(callback: (data: string) => void): void { this.#dataCallbacks.push(callback); }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void { this.#exitCallbacks.push(callback); }
}

/**
 * Owns one shell in a hardened workbook container. The host workspace is mounted
 * read-only except for explicit learner-work roots and scratch .tmp/ directories.
 * Trusted runtime provision mounts, when supplied by the launcher, are read-only.
 * Terminal bytes are transient until a paused transcript is
 * submitted as immutable attempt evidence.
 */
export class WorkbookTerminalManager {
  readonly workspace: string;
  readonly runtimeProvision: TrustedRuntimeProvision;
  #pty: TerminalPty | undefined;
  #client: TerminalClient | undefined;
  #replay = "";
  #transcript = "";
  #captureKey: string | undefined;
  #practiceTranscripts = new Map<string, PracticeTranscript>();
  #commandPending = false;
  #observeTimer: NodeJS.Timeout | undefined;
  #inFlight = false;
  #lastFingerprint = "";
  #lastError = new Map<string, string>();
  readonly #getActiveBlock: () => ActiveObservedTerminalBlock | undefined;
  readonly #submitAttempt: SubmitAttempt;
  readonly #ptyFactory: TerminalPtyFactory;
  readonly #log: TutorialLogger;
  readonly #debounceMs: number;
  readonly #maxTranscriptBytes: number;

  constructor(options: WorkbookTerminalManagerOptions) {
    this.workspace = resolve(options.workspace);
    this.runtimeProvision = options.runtimeProvision ?? NO_RUNTIME_PROVISION;
    this.#getActiveBlock = options.getActiveBlock;
    this.#submitAttempt = options.submitAttempt;
    this.#ptyFactory = options.ptyFactory ?? createDockerPty;
    this.#log = options.logger ?? createTutorialLogger();
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#maxTranscriptBytes = options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  }

  start(): void { this.#ensurePty(); }

  attach(client: TerminalClient): boolean {
    if (this.#client) return false;
    this.#client = client;
    try { this.#ensurePty(); this.#pty?.open?.(); }
    catch (error) {
      this.#client = undefined;
      const shell = this.#pty as DockerPty | undefined;
      shell?.kill(); shell?.stopContainer?.();
      this.#pty = undefined;
      this.#log.info(`Embedded terminal could not start: ${error instanceof Error ? error.message : String(error)}`);
      client.send(JSON.stringify({ type: "terminal-error", message: "The embedded terminal could not start on this machine. Check that Docker is running and the workbook terminal image is built, then refresh." }));
      return true;
    }
    if (this.#replay) client.send(JSON.stringify({ type: "output", data: this.#replay }));
    const block = this.#getActiveBlock();
    if (block) {
      const key = terminalKey(block);
      const error = this.#lastError.get(key);
      if (error) client.send(JSON.stringify({ type: "attempt-error", blockId: block.blockId, message: error }));
    }
    return true;
  }

  detach(client: TerminalClient): void {
    if (this.#client === client) this.#client = undefined;
  }

  receive(message: TerminalMessage): void {
    const shell = this.#pty;
    if (!shell) return;
    if (message.type === "input") {
      if (typeof message.data !== "string" || Buffer.byteLength(message.data, "utf8") > MAX_INPUT_BYTES) return;
      shell.write(message.data);
      this.#record("input", message.data);
      if (this.#isSubmittedCommand(message.data)) {
        this.#commandPending = true;
        this.#client?.send(JSON.stringify({ type: "attempt-status", blockId: this.#getActiveBlock()?.blockId, status: "running" }));
        this.#scheduleObservation();
      }
      if (message.data.includes("\x03")) this.#commandPending = false;
      return;
    }
    if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0) {
      shell.resize(Math.min(message.cols, MAX_COLS), Math.min(message.rows, MAX_ROWS));
    }
  }

  dispose(): void { this.#stopTerminal(); }

  transcriptForTesting(): string { return this.#transcript; }
  frozenTerminalHtml(): string { return `<pre class="frozen-terminal-output">${escapeHtml(stripTerminalControls(this.#replay || this.#transcript))}</pre>`; }

  #stopTerminal(): void {
    if (this.#observeTimer) clearTimeout(this.#observeTimer);
    this.#observeTimer = undefined;
    this.#client?.close(1001, "Workbook terminal stopped.");
    this.#client = undefined;
    const shell = this.#pty as DockerPty | undefined;
    shell?.kill(); shell?.stopContainer?.();
    this.#pty = undefined;
  }

  /** Bounded, in-memory evidence for the later reflection discussion. */
  practiceTranscripts(): PracticeTranscript[] { return [...this.#practiceTranscripts.values()]; }

  #ensurePty(): void {
    if (this.#pty) return;
    const instance = this.#ptyFactory({ cwd: this.workspace, runtimeProvision: this.runtimeProvision, cols: 90, rows: 24 });
    this.#pty = instance;
    instance.onData((data) => {
      this.#replay = boundedAppend(this.#replay, data, MAX_REPLAY_BYTES);
      this.#client?.send(JSON.stringify({ type: "output", data }));
      this.#record("output", data);
      if (this.#commandPending) {
        this.#client?.send(JSON.stringify({ type: "attempt-status", blockId: this.#getActiveBlock()?.blockId, status: "running" }));
        this.#scheduleObservation();
      }
    });
    instance.onExit(({ exitCode, signal }) => {
      this.#client?.send(JSON.stringify({ type: "exit", exitCode, signal }));
      (instance as DockerPty).stopContainer?.();
      if (this.#pty === instance) this.#pty = undefined;
    });
  }

  #record(kind: "input" | "output", data: string): void {
    const block = this.#getActiveBlock();
    if (!block) return;
    const key = terminalKey(block);
    if (this.#captureKey !== key) {
      this.#captureKey = key;
      this.#transcript = this.#practiceTranscripts.get(key)?.transcript ?? "";
      this.#commandPending = false;
      this.#lastFingerprint = "";
    }
    const label = kind === "input" ? "LEARNER INPUT" : "TERMINAL OUTPUT";
    this.#transcript = boundedAppend(this.#transcript, `\n[${label}]\n${data}`, this.#maxTranscriptBytes);
    this.#practiceTranscripts.set(key, { lessonId: block.lessonId, blockId: block.blockId, transcript: this.#transcript });
  }

  #isSubmittedCommand(data: string): boolean {
    // xterm sends the command text and its Enter key as separate input events.
    // A bare carriage return therefore still submits the visible input already
    // recorded above; the attempt can be feedback if it has no useful evidence.
    return /[\r\n]/.test(data);
  }

  #scheduleObservation(): void {
    if (this.#observeTimer) clearTimeout(this.#observeTimer);
    this.#observeTimer = setTimeout(() => void this.#submitPausedAttempt(), this.#debounceMs);
    this.#observeTimer.unref?.();
  }

  async #submitPausedAttempt(): Promise<void> {
    this.#observeTimer = undefined;
    if (!this.#commandPending || this.#inFlight) return;
    const block = this.#getActiveBlock();
    if (!block) return;
    const key = terminalKey(block);
    if (this.#captureKey !== key || !this.#transcript.trim()) return;
    const transcript = this.#transcript.slice(-this.#maxTranscriptBytes);
    const terminalHtml = this.frozenTerminalHtml();
    const fingerprint = `${key}\n${transcript}`;
    if (fingerprint === this.#lastFingerprint) return;
    this.#lastFingerprint = fingerprint;
    this.#inFlight = true;
    this.#client?.send(JSON.stringify({ type: "attempt-status", blockId: block.blockId, status: "checking" }));
    try {
      await this.#submitAttempt({
        lessonId: block.lessonId,
        blockId: block.blockId,
        privateGuidance: block.expectedObservation,
        evidence: { kind: "terminal", transcript, terminalHtml }
      });
      const stillActive = this.#getActiveBlock();
      if (!stillActive || terminalKey(stillActive) !== key) return;
      this.#commandPending = false;
      this.#lastError.delete(key);
      this.#client?.send(JSON.stringify({ type: "attempt-status", blockId: block.blockId, status: "submitted" }));
    } catch (error) {
      const message = "Could not submit the terminal attempt. Keep working in the embedded terminal; your next command will be checked again.";
      this.#lastError.set(key, message);
      this.#log.info(`Terminal attempt submission failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
      this.#client?.send(JSON.stringify({ type: "attempt-error", blockId: block.blockId, message }));
    } finally {
      this.#inFlight = false;
    }
  }
}
