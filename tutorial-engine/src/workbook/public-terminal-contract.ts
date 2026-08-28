/**
 * Browser-safe JSON contract for the workbook terminal WebSocket. Like public-contract.ts this
 * module has no Node imports, so the server that sends a frame and the browser that narrows one
 * read the same declaration instead of agreeing by hand.
 */
export type PublicTerminalFrame =
  | { type: "output"; data: string }
  | { type: "terminal-error"; message: string }
  | { type: "busy"; message: string }
  | { type: "exit"; exitCode: number; signal?: number };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function text(value: unknown): value is string { return typeof value === "string"; }

/**
 * Narrows one transport frame. Lifecycle state travels over the public workbook state/SSE contract,
 * not the terminal socket, so a late socket frame cannot alter learner feedback or completion.
 */
export function parsePublicTerminalMessage(data: unknown): PublicTerminalFrame | undefined {
  if (!text(data)) throw new Error("The workbook terminal socket sent a frame that is not text.");
  const frame: unknown = JSON.parse(data);
  if (!record(frame)) return undefined;
  const message = text(frame.message) ? frame.message : undefined;
  switch (frame.type) {
    case "output": return text(frame.data) ? { type: "output", data: frame.data } : undefined;
    case "terminal-error": return message !== undefined ? { type: "terminal-error", message } : undefined;
    case "busy": return message !== undefined ? { type: "busy", message } : undefined;
    case "exit": return typeof frame.exitCode === "number" ? { type: "exit", exitCode: frame.exitCode, signal: typeof frame.signal === "number" ? frame.signal : undefined } : undefined;
    default: return undefined;
  }
}

/** Serialises one frame; the argument type is what keeps the server's sends and this union in step. */
export function publicTerminalFrame(frame: PublicTerminalFrame): string { return JSON.stringify(frame); }
