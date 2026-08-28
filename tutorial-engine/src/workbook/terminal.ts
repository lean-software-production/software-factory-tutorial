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
const MAX_INPUT_BYTES = 16_384;
const MAX_COLS = 500;
const MAX_ROWS = 200;

function boundedAppend(previous: string, addition: string, limit: number): string {
  const next = previous + addition;
  return next.length > limit ? next.slice(-limit) : next;
}
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
  return ["exec", "-it", "--env", "PS1=$ ", "--env", "PROMPT_COMMAND=status=$?; printf '\\033]633;workbook-finished;%s\\007' \"$status\"; trap 'command=$BASH_COMMAND; trap - DEBUG; printf \"\\033]633;workbook-command;\"; printf '%s' \"$command\" | base64 -w 0; printf \"\\007\"' DEBUG", "--workdir", "/workspace", name, "/bin/bash", "--noprofile", "--norc", "-i"];
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
 * Bash markers delimit the command evidence retained by the workflow.
 */
export class WorkbookTerminalManager {
  readonly workspace: string;
  readonly runtimeProvision: TrustedRuntimeProvision;
  #pty: TerminalPty | undefined;
  #client: TerminalClient | undefined;
  #replay = "";
  #terminalShellProtocol = new TerminalShellProtocol();
  #terminalObservation: TerminalObservation | undefined;
  #terminalObservationBlockKey: string | undefined;
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
    this.#client = client;
    try { this.#ensurePty(); this.#pty?.open?.(); }
    catch (error) {
      this.#client = undefined;
      const shell = this.#pty as DockerPty | undefined;
      shell?.kill(); shell?.stopContainer?.();
      this.#pty = undefined;
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
    const shell = this.#pty;
    if (!shell) return;
    if (message.type === "input") {
      if (typeof message.data !== "string" || Buffer.byteLength(message.data, "utf8") > MAX_INPUT_BYTES) return;
      // A browser may attach while its next terminal block is visibly preloaded. Transport output
      // is harmless then, but input cannot reach the shell until the workflow makes a terminal
      // block active; otherwise a preloaded canvas would bypass progression authority.
      if (!this.#getActiveBlock()) return;
      shell.write(message.data);
      this.#terminalObservation?.observeInteractiveInput(message.data);
      return;
    }
    if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols > 0 && message.rows > 0) {
      shell.resize(Math.min(message.cols, MAX_COLS), Math.min(message.rows, MAX_ROWS));
    }
  }

  dispose(): void { this.#stopTerminal(); }

  #stopTerminal(): void {
    this.#terminalObservation?.close();
    this.#terminalObservation = undefined;
    this.#terminalObservationBlockKey = undefined;
    this.#client?.close(1001, "Workbook terminal stopped.");
    this.#client = undefined;
    const shell = this.#pty as DockerPty | undefined;
    shell?.kill(); shell?.stopContainer?.();
    this.#pty = undefined;
  }

  #ensurePty(): void {
    if (this.#pty) return;
    this.#terminalShellProtocol = new TerminalShellProtocol();
    const instance = this.#ptyFactory({ cwd: this.workspace, runtimeProvision: this.runtimeProvision, cols: 90, rows: 24 });
    this.#pty = instance;
    instance.onData((data) => {
      for (const event of this.#terminalShellProtocol.consume(data)) {
        if (event.type === "output") this.#forwardTerminalOutput(event.data);
        else if (event.type === "command-submitted") this.#observeCommandSubmitted(event.command);
        else this.#terminalObservation?.observeCommandFinished({ exitStatus: event.exitStatus });
      }
    });
    instance.onExit(({ exitCode, signal }) => {
      this.#client?.send(publicTerminalFrame({ type: "exit", exitCode, signal }));
      (instance as DockerPty).stopContainer?.();
      if (this.#pty === instance) this.#pty = undefined;
      this.#terminalObservation?.close();
      this.#terminalObservation = undefined;
      this.#terminalObservationBlockKey = undefined;
    });
  }

  #forwardTerminalOutput(data: string): void {
    this.#replay = boundedAppend(this.#replay, data, MAX_REPLAY_BYTES);
    this.#client?.send(publicTerminalFrame({ type: "output", data }));
    this.#terminalObservation?.observeTerminalOutput(data);
  }

  #observeCommandSubmitted(command: string): void {
    const block = this.#getActiveBlock();
    if (!block) return;
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
