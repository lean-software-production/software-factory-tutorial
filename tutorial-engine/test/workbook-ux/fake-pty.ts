import type { TerminalPty, TerminalPtyOptions } from "../../src/workbook/terminal.js";

export interface FakePtyCommand {
  readonly command: string;
  readonly exitStatus: number;
  readonly output: string;
  readonly at: string;
}

export interface ProtocolAwareFakePtyOptions {
  readonly prompt?: string;
  readonly exitStatusForCommand?: (command: string) => number;
  readonly outputForCommand?: (command: string, index: number) => string;
}

const DEFAULT_PROMPT = "$ ";

export function workbookCommandMarker(command: string): string {
  return `\x1b]633;workbook-command;${Buffer.from(command, "utf8").toString("base64")}\x07`;
}

export function workbookFinishedMarker(exitStatus = 0): string {
  return `\x1b]633;workbook-finished;${exitStatus}\x07`;
}

/**
 * A browser-facing PTY double for recorded UX journeys.
 *
 * It accepts the same character stream xterm sends to the server, echoes printable input back to
 * the terminal, and frames Enter with the authoritative OSC-633 workbook command/finished markers
 * that the workflow consumes. It never executes a shell command.
 */
export class ProtocolAwareFakePty implements TerminalPty {
  readonly cwd: string;
  readonly commands: FakePtyCommand[] = [];
  readonly writes: string[] = [];
  killed = false;
  #buffer = "";
  #dataCallbacks: Array<(data: string) => void> = [];
  #exitCallbacks: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  readonly #prompt: string;
  readonly #exitStatusForCommand: (command: string) => number;
  readonly #outputForCommand: (command: string, index: number) => string;

  constructor(options: TerminalPtyOptions, fakeOptions: ProtocolAwareFakePtyOptions = {}) {
    this.cwd = options.cwd;
    this.#prompt = fakeOptions.prompt ?? DEFAULT_PROMPT;
    this.#exitStatusForCommand = fakeOptions.exitStatusForCommand ?? (() => 0);
    this.#outputForCommand = fakeOptions.outputForCommand ?? ((command, index) => `fake-workbook-output[${index}]: ${command}\r\n`);
  }

  open(): void {
    this.#emit(this.#prompt);
  }

  write(data: string): void {
    if (this.killed) return;
    this.writes.push(data);
    for (const char of data) this.#acceptChar(char);
  }

  resize(): void {}

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    for (const callback of this.#exitCallbacks) callback({ exitCode: 0 });
  }

  onData(callback: (data: string) => void): void { this.#dataCallbacks.push(callback); }
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void { this.#exitCallbacks.push(callback); }

  #acceptChar(char: string): void {
    if (char === "\r" || char === "\n") {
      this.#finishCommand();
      return;
    }
    if (char === "\u007f" || char === "\b") {
      if (this.#buffer.length > 0) {
        this.#buffer = this.#buffer.slice(0, -1);
        this.#emit("\b \b");
      }
      return;
    }
    // Ignore non-printing control sequences in this fake shell. The recorder types plain command
    // characters and Enter, so this keeps the fake intentionally narrow.
    if (char < " " && char !== "\t") return;
    this.#buffer += char;
    this.#emit(char);
  }

  #finishCommand(): void {
    const command = this.#buffer;
    this.#buffer = "";
    this.#emit("\r\n");
    if (!command.trim()) {
      this.#emit(this.#prompt);
      return;
    }
    const index = this.commands.length + 1;
    const exitStatus = this.#exitStatusForCommand(command);
    const output = this.#outputForCommand(command, index);
    this.commands.push({ command, exitStatus, output, at: new Date().toISOString() });
    this.#emit(`${workbookCommandMarker(command)}${output}${workbookFinishedMarker(exitStatus)}${this.#prompt}`);
  }

  #emit(data: string): void {
    for (const callback of this.#dataCallbacks) callback(data);
  }
}

export function createProtocolAwareFakePty(fakeOptions: ProtocolAwareFakePtyOptions = {}) {
  const instances: ProtocolAwareFakePty[] = [];
  return {
    instances,
    create: (options: TerminalPtyOptions): TerminalPty => {
      const instance = new ProtocolAwareFakePty(options, fakeOptions);
      instances.push(instance);
      return instance;
    },
    get commandCount(): number {
      return instances.reduce((total, instance) => total + instance.commands.length, 0);
    },
    get commands(): FakePtyCommand[] {
      return instances.flatMap((instance) => instance.commands);
    },
  };
}
