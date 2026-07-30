import { spawn } from "node:child_process";
import type { ValidationCommand } from "../lesson/contract.js";

const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;

export interface ValidationResult {
  command: string;
  output: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
}

export class ValidationRunner {
  readonly #commands: ReadonlyMap<string, ValidationCommand>;

  constructor(commands: ValidationCommand[], private readonly cwd: string) {
    const entries = commands.map((command) => [command.id, command] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error("Validation command IDs must be unique.");
    this.#commands = new Map(entries);
  }

  get commandIds(): readonly string[] {
    return [...this.#commands.keys()];
  }

  async run(commandId: string, onProgress?: (output: string) => void): Promise<ValidationResult> {
    const command = this.#commands.get(commandId);
    if (!command) throw new Error(`Validation command '${commandId}' is not allowed by this lesson.`);
    const startedAt = Date.now();
    const display = [command.command, ...(command.args ?? [])].join(" ");
    const timeoutMs = Math.min(Math.max(command.timeoutMs ?? 60_000, 1), MAX_TIMEOUT_MS);

    return new Promise<ValidationResult>((resolve, reject) => {
      const child = spawn(command.command, command.args ?? [], {
        cwd: this.cwd,
        shell: false,
        // Deliberately do not inherit provider credentials or arbitrary server secrets.
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      let timedOut = false;
      let settled = false;
      const append = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (Buffer.byteLength(output) < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(output);
          output += text.slice(0, remaining);
        }
        onProgress?.(text);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) output += `\nValidation timed out after ${timeoutMs}ms.`;
        if (Buffer.byteLength(output) >= MAX_OUTPUT_BYTES) output += "\n[output truncated by tutorial engine]";
        resolve({
          command: display,
          output,
          exitCode,
          passed: exitCode === 0 && !timedOut,
          durationMs: Date.now() - startedAt
        });
      });
    });
  }
}
