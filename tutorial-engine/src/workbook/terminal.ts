import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as pty from "node-pty";
import type { TutorialLogger } from "./runtime-log.js";
import { createTutorialLogger } from "./runtime-log.js";
import { NO_RUNTIME_PROVISION, type TrustedRuntimeProvision } from "./runtime-provision.js";
import { publicTerminalFrame } from "./public-terminal-contract.js";
import { TerminalObservation, type TerminalObservationFact } from "./terminal-observation.js";
import { TerminalShellProtocol } from "./terminal-shell-protocol.js";

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

export interface TerminalPtyOptions { cwd: string; cols: number; rows: number; runtimeProvision?: TrustedRuntimeProvision; containerWorkdir?: string; }
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
const DEFAULT_WRITABLE_SCRATCH_DIRECTORIES = [".tmp"] as const;
export type TerminalPtyFactory = (options: TerminalPtyOptions) => TerminalPty;
export interface DockerRunArgumentsOptions { workspace: string; name: string; apiKey: string; runtimeProvision?: TrustedRuntimeProvision; }

export interface ActiveObservedTerminalBlock {
  lessonId: string;
  blockId: string;
  workspaceId: string;
  workspaceRoot: string;
}

export interface ActiveTerminalTranscriptContext {
  lessonId: string;
  blockId: string;
  /** Private, bounded, session-memory-only transcript for Main Tutor context. */
  transcript: string;
}

/** The only terminal text persisted into the browser-safe event stream. */
export interface ActiveTerminalPublicSnapshot {
  lessonId: string;
  blockId: string;
  transcript: string;
}

export interface WorkbookTerminalManagerOptions {
  workspace: string;
  runtimeProvision?: TrustedRuntimeProvision;
  getActiveBlock(): ActiveObservedTerminalBlock | undefined;
  /** Receives Bash-authoritative command lifecycle facts. */
  observationSink(fact: TerminalObservationFact): Promise<void> | void;
  ptyFactory?: TerminalPtyFactory;
  logger?: TutorialLogger;
}

const MAX_REPLAY_BYTES = 64_000;
const MAX_ACTIVE_TERMINAL_CONTEXT_BYTES = 64_000;
const MAX_PUBLIC_TERMINAL_SNAPSHOT_BYTES = 16_000;
const MAX_INPUT_BYTES = 16_384;
const MAX_COLS = 500;
const MAX_ROWS = 200;

function boundedAppend(previous: string, addition: string, limit: number): string {
  const next = previous + addition;
  return next.length > limit ? next.slice(-limit) : next;
}
function terminalKey(block: ActiveObservedTerminalBlock): string { return `${block.lessonId}:${block.blockId}`; }

/**
 * Browser terminal frames can include escape sequences and control bytes. Historical output is
 * rendered in a `<pre>`, not replayed into xterm, so retain only printable text and basic layout.
 * Commands, protocol markers, evidence references, and private tutor context are never included.
 */
export function publicTerminalTranscript(output: string): string {
  return output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b./g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\n\t\x20-\x7e]/g, "")
    .replace(/\b((?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret))\b\s*(?:=|:)\s*\S+/gi, "$1= [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
}

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
  const args = ["run", "-d", "--rm", "--name", options.name, "--label", "workbook-terminal=true", "--user", dockerContainerUser(), "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=768m", "--cpus=1", "--network=bridge", "--init", "--env", `${OPENCODE_API_KEY_ENV}=${options.apiKey}`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--tmpfs", `${CONTAINER_AGENT_DIR}:uid=${uid},gid=${gid},mode=0700`, "--mount", bindMount(workspace, "/workspace"), "--workdir", "/workspace"];
  for (const mount of provision.mounts) {
    args.push("--mount", bindMount(mount.hostSource, `/workspace/${mount.workspaceTarget}`, true));
  }
  return args;
}

export const WORKBOOK_TERMINAL_PROMPT_COMMAND = "status=$?; printf '\\033]633;workbook-finished;%s\\007' \"$status\"; trap 'trap - DEBUG; __workbook_command_file=$(mktemp /tmp/workbook-command.XXXXXX 2>/dev/null || true); command=; if [ -n \"$__workbook_command_file\" ] && fc -ln -1 > \"$__workbook_command_file\" 2>/dev/null; then command=$(<\"$__workbook_command_file\"); fi; if [ -n \"$__workbook_command_file\" ]; then rm -f \"$__workbook_command_file\"; fi; command=${command#	}; command=${command# }; if [ -z \"$command\" ]; then command=$BASH_COMMAND; fi; printf \"\\033]633;workbook-command;\"; printf '%s' \"$command\" | base64 -w 0; printf \"\\007\"' DEBUG";

function assertContainerWorkdir(path: string): string {
  if (path !== "/workspace") throw new Error(`Unsafe terminal workdir: ${path}`);
  return path;
}

export function dockerExecArguments(name: string, containerWorkdir = "/workspace"): string[] {
  return ["exec", "-it", "--env", "PS1=$ ", "--env", `PROMPT_COMMAND=${WORKBOOK_TERMINAL_PROMPT_COMMAND}`, "--workdir", assertContainerWorkdir(containerWorkdir), name, "/bin/bash", "--noprofile", "--norc", "-i"];
}

/** Starts a hardened, per-practice container; browser bytes can only reach docker exec. */
export function createDockerPty(options: TerminalPtyOptions): TerminalPty {
  return new PreparedDockerPty(options);
}

class PreparedDockerPty implements DockerPty {
  readonly #workspace: string;
  readonly #runtimeProvision: TrustedRuntimeProvision | undefined;
  readonly #containerWorkdir: string;
  readonly #name = `workbook-terminal-${randomUUID()}`;
  #cols: number;
  #rows: number;
  #shell: TerminalPty | undefined;
  readonly #dataCallbacks: Array<(data: string) => void> = [];
  readonly #exitCallbacks: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  constructor(options: TerminalPtyOptions) {
    this.#workspace = resolve(options.cwd);
    this.#runtimeProvision = options.runtimeProvision;
    this.#containerWorkdir = assertContainerWorkdir(options.containerWorkdir ?? "/workspace");
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
    const shell = pty.spawn("docker", dockerExecArguments(this.#name, this.#containerWorkdir), {
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
 * Owns one shell in a hardened workbook container. The active live workspace is the only
 * learner workspace mounted at /workspace, and it is mounted read-write so lesson commands
 * can edit files. Trusted runtime provision mounts, when supplied by the launcher, are read-only.
 * Bash markers delimit the command evidence retained by the workflow.
 */
export class WorkbookTerminalManager {
  readonly workspace: string;
  readonly runtimeProvision: TrustedRuntimeProvision;
  #pty: TerminalPty | undefined;
  #ptyWorkspaceRoot: string | undefined;
  #ptyBlockKey: string | undefined;
  #client: TerminalClient | undefined;
  #replay = "";
  #terminalShellProtocol = new TerminalShellProtocol();
  #terminalObservation: TerminalObservation | undefined;
  #terminalObservationBlockKey: string | undefined;
  #activeTranscript = "";
  #activeTranscriptBlockKey: string | undefined;
  #activePublicTranscript = "";
  #activePublicTranscriptBlockKey: string | undefined;
  readonly #getActiveBlock: () => ActiveObservedTerminalBlock | undefined;
  readonly #observationSink: (fact: TerminalObservationFact) => Promise<void> | void;
  readonly #ptyFactory: TerminalPtyFactory;
  readonly #log: TutorialLogger;

  constructor(options: WorkbookTerminalManagerOptions) {
    this.workspace = resolve(options.workspace);
    this.runtimeProvision = options.runtimeProvision ?? NO_RUNTIME_PROVISION;
    this.#getActiveBlock = options.getActiveBlock;
    this.#observationSink = options.observationSink;
    this.#ptyFactory = options.ptyFactory ?? createDockerPty;
    this.#log = options.logger ?? createTutorialLogger();
  }

  start(): void { this.#ensurePty(); this.#pty?.open?.(); }

  attach(client: TerminalClient): boolean {
    if (this.#client) return false;
    try { this.#ensurePty(); this.#client = client; this.#pty?.open?.(); }
    catch (error) {
      this.#client = undefined;
      const shell = this.#pty as DockerPty | undefined;
      shell?.kill(); shell?.stopContainer?.();
      this.#pty = undefined;
      this.#ptyWorkspaceRoot = undefined;
      this.#ptyBlockKey = undefined;
      this.#log.info(`Embedded terminal could not start: ${error instanceof Error ? error.message : String(error)}`);
      client.send(publicTerminalFrame({ type: "terminal-error", message: "The embedded terminal could not start on this machine. Check that Docker is running and the workbook terminal image is built, then refresh." }));
      return true;
    }
    if (this.#replay) client.send(publicTerminalFrame({ type: "output", data: this.#replay }));
    return true;
  }

  detach(client: TerminalClient): void {
    if (this.#client === client) this.#client = undefined;
  }

  receive(message: TerminalMessage): void {
    if (message.type === "input") {
      if (typeof message.data !== "string" || Buffer.byteLength(message.data, "utf8") > MAX_INPUT_BYTES) return;
      const block = this.#getActiveBlock();
      if (!block) return;
      this.#ensurePtyForActiveBlock(block);
      const shell = this.#pty;
      if (!shell) return;
      this.#appendActiveTranscript("input", message.data);
      this.#terminalObservation?.observeInteractiveInput(message.data);
      shell.write(message.data);
      return;
    }
    const shell = this.#pty;
    if (!shell) return;
    if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0) {
      shell.resize(Math.min(message.cols, MAX_COLS), Math.min(message.rows, MAX_ROWS));
    }
  }

  activeTranscriptContext(): ActiveTerminalTranscriptContext | undefined {
    const block = this.#getActiveBlock();
    if (!block || !this.#currentPtyMatchesActiveBlock()) return undefined;
    if (this.#activeTranscriptBlockKey !== terminalKey(block) || !this.#activeTranscript) return undefined;
    return { lessonId: block.lessonId, blockId: block.blockId, transcript: this.#activeTranscript };
  }

  activePublicSnapshot(): ActiveTerminalPublicSnapshot | undefined {
    const block = this.#getActiveBlock();
    if (!block || !this.#currentPtyMatchesActiveBlock() || this.#activePublicTranscriptBlockKey !== terminalKey(block)) return undefined;
    return { lessonId: block.lessonId, blockId: block.blockId, transcript: this.#activePublicTranscript };
  }

  reconcileActiveTerminal(): void {
    const active = this.#getActiveBlock();
    if (!this.#pty) return;
    if (!active || this.#ptyBlockKey !== terminalKey(active) || this.#ptyWorkspaceRoot !== resolve(active.workspaceRoot)) {
      this.#retireTerminal(1012, "Terminal content reloaded.", "cancel");
    }
  }

  /** Discard one completed terminal's transport only after its continuation is durable. */
  resetAfterTerminalContinuation(leaving: ActiveObservedTerminalBlock): void {
    if (this.#terminalObservationBlockKey && this.#terminalObservationBlockKey !== terminalKey(leaving)) return;
    this.#retireTerminal(1012, "Terminal advanced to the next block.", "close");
  }

  dispose(): void { this.#stopTerminal(); }

  #stopTerminal(): void {
    this.#retireTerminal(1001, "Workbook terminal stopped.", "close");
  }

  #clearTerminalState(observation: "cancel" | "close"): void {
    if (observation === "cancel") this.#terminalObservation?.cancel();
    else this.#terminalObservation?.close();
    this.#terminalObservation = undefined;
    this.#terminalObservationBlockKey = undefined;
    this.#activeTranscript = "";
    this.#activeTranscriptBlockKey = undefined;
    this.#activePublicTranscript = "";
    this.#activePublicTranscriptBlockKey = undefined;
    this.#replay = "";
    this.#terminalShellProtocol = new TerminalShellProtocol();
  }

  #retireTerminal(clientCloseCode: number, clientCloseReason: string, observation: "cancel" | "close"): void {
    this.#clearTerminalState(observation);
    this.#client?.close(clientCloseCode, clientCloseReason);
    this.#client = undefined;
    const shell = this.#pty as DockerPty | undefined;
    shell?.kill(); shell?.stopContainer?.();
    this.#pty = undefined;
    this.#ptyWorkspaceRoot = undefined;
    this.#ptyBlockKey = undefined;
  }

  #ensurePty(): void {
    const active = this.#getActiveBlock();
    if (!active) return;
    this.#ensurePtyForActiveBlock(active);
  }

  #currentPtyMatchesActiveBlock(): boolean {
    const active = this.#getActiveBlock();
    return !!active && this.#ptyBlockKey === terminalKey(active) && this.#ptyWorkspaceRoot === resolve(active.workspaceRoot);
  }

  #ensurePtyForActiveBlock(active: ActiveObservedTerminalBlock): void {
    const activeRoot = resolve(active.workspaceRoot);
    const activeKey = terminalKey(active);
    if (this.#pty && this.#ptyWorkspaceRoot === activeRoot && this.#ptyBlockKey === activeKey) return;
    if (this.#pty) this.#retireTerminal(1012, "Terminal switched to another block.", "cancel");
    else this.#clearTerminalState("cancel");
    const instance = this.#ptyFactory({ cwd: activeRoot, runtimeProvision: this.runtimeProvision, cols: 90, rows: 24, containerWorkdir: "/workspace" });
    this.#pty = instance;
    this.#ptyWorkspaceRoot = activeRoot;
    this.#ptyBlockKey = activeKey;
    instance.onData((data) => {
      if (this.#pty !== instance) return;
      for (const event of this.#terminalShellProtocol.consume(data)) {
        if (event.type === "output") this.#forwardTerminalOutput(event.data);
        else if (event.type === "command-submitted") this.#observeCommandSubmitted(event.command);
        else if (this.#currentPtyMatchesActiveBlock()) this.#terminalObservation?.observeCommandFinished({ exitStatus: event.exitStatus });
      }
    });
    instance.onExit(({ exitCode, signal }) => {
      (instance as DockerPty).stopContainer?.();
      if (this.#pty !== instance) return;
      this.#client?.send(publicTerminalFrame({ type: "exit", exitCode, signal }));
      this.#clearTerminalState("close");
      this.#pty = undefined;
      this.#ptyWorkspaceRoot = undefined;
      this.#ptyBlockKey = undefined;
    });
  }

  #forwardTerminalOutput(data: string): void {
    if (!this.#currentPtyMatchesActiveBlock()) return;
    this.#replay = boundedAppend(this.#replay, data, MAX_REPLAY_BYTES);
    this.#appendActiveTranscript("output", data);
    this.#appendActivePublicOutput(data);
    this.#terminalObservation?.observeTerminalOutput(data);
    this.#client?.send(publicTerminalFrame({ type: "output", data }));
  }

  #appendActiveTranscript(kind: "input" | "output", data: string): void {
    if (!data) return;
    const block = this.#getActiveBlock();
    if (!block || !this.#currentPtyMatchesActiveBlock()) return;
    const key = terminalKey(block);
    if (this.#activeTranscriptBlockKey !== key) {
      this.#activeTranscriptBlockKey = key;
      this.#activeTranscript = "";
    }
    this.#activeTranscript = boundedAppend(this.#activeTranscript, `[TERMINAL ${kind.toUpperCase()}]\n${data}`, MAX_ACTIVE_TERMINAL_CONTEXT_BYTES);
  }

  #appendActivePublicOutput(data: string): void {
    const block = this.#getActiveBlock();
    if (!block || !this.#currentPtyMatchesActiveBlock()) return;
    const key = terminalKey(block);
    if (this.#activePublicTranscriptBlockKey !== key) {
      this.#activePublicTranscriptBlockKey = key;
      this.#activePublicTranscript = "";
    }
    this.#activePublicTranscript = boundedAppend(this.#activePublicTranscript, publicTerminalTranscript(data), MAX_PUBLIC_TERMINAL_SNAPSHOT_BYTES);
  }

  #observeCommandSubmitted(command: string): void {
    const block = this.#getActiveBlock();
    if (!block || !this.#currentPtyMatchesActiveBlock()) return;
    const key = terminalKey(block);
    let observation = this.#terminalObservation;
    if (this.#terminalObservationBlockKey !== key || !observation) {
      observation?.cancel();
      this.#terminalObservationBlockKey = key;
      observation = new TerminalObservation({
        blockId: block.blockId,
        createAttemptId: randomUUID,
        emit: (fact) => {
          void Promise.resolve(this.#observationSink(fact)).catch((error) => {
            this.#log.info(`Terminal observation failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      });
      this.#terminalObservation = observation;
    }
    observation.observeCommandSubmitted({ command });
  }
}
