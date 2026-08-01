import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdout } from "node:process";

export interface TutorialLogger {
  /** The local diagnostic file, when one was configured. */
  readonly filePath?: string;
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => Date;
  /** Append each log line here as well as writing it to stdout. */
  filePath?: string;
}

/** A per-run local log outside the repository, so source control stays clean. */
export function defaultTutorialLogPath(now = new Date(), pid = process.pid): string {
  const directory = process.platform === "darwin"
    ? join(homedir(), "Library", "Logs", "SoftwareFactoryTutorial")
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "software-factory-tutorial");
  const stamp = now.toISOString().replaceAll(":", "-");
  return join(directory, `tutorial-${stamp}-${pid}.log`);
}

/**
 * Writes concise lifecycle diagnostics to the terminal that launched the tutor.
 * Browser chat contents are intentionally never included in these logs.
 */
export function createTutorialLogger(options: LoggerOptions = {}): TutorialLogger {
  const stdoutWrite = options.write ?? ((line: string) => { stdout.write(line); });
  const now = options.now ?? (() => new Date());
  const write = (output: string) => {
    stdoutWrite(output);
    if (!options.filePath) return;
    try {
      mkdirSync(dirname(options.filePath), { recursive: true });
      appendFileSync(options.filePath, output, "utf8");
    } catch {
      // Diagnostics must never prevent the tutorial from starting or running.
    }
  };
  const line = (level: "INFO" | "ERROR", message: string): string =>
    `[tutorial ${now().toISOString()}] ${level} ${message}\n`;

  return {
    filePath: options.filePath,
    info(message) { write(line("INFO", message)); },
    error(message, error) {
      const detail = error instanceof Error ? error.stack ?? error.message : error === undefined ? "" : String(error);
      write(line("ERROR", detail ? `${message}: ${detail.replaceAll("\n", " | ")}` : message));
    }
  };
}
