import { stdout } from "node:process";

export interface TutorialLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * Writes concise lifecycle diagnostics to the terminal that launched the tutor.
 * Browser chat contents are intentionally never included in these logs.
 */
export function createTutorialLogger(options: LoggerOptions = {}): TutorialLogger {
  const write = options.write ?? ((line: string) => { stdout.write(line); });
  const now = options.now ?? (() => new Date());
  const line = (level: "INFO" | "ERROR", message: string): string =>
    `[tutorial ${now().toISOString()}] ${level} ${message}\n`;

  return {
    info(message) { write(line("INFO", message)); },
    error(message, error) {
      const detail = error instanceof Error ? error.stack ?? error.message : error === undefined ? "" : String(error);
      write(line("ERROR", detail ? `${message}: ${detail.replaceAll("\n", " | ")}` : message));
    }
  };
}
