/**
 * Browser-safe JSON contract for the workbook terminal WebSocket. Like public-contract.ts this
 * module has no Node imports, so the server that sends a frame and the browser that narrows one
 * read the same declaration instead of agreeing by hand.
 */
export type PublicTerminalAttemptStatus = "running" | "checking" | "submitted";

/** Every frame src/workbook/terminal.ts and the socket handler in src/workbook/server.ts send. */
export type PublicTerminalFrame =
  | { type: "output"; data: string }
  | { type: "attempt-status"; blockId?: string; status: PublicTerminalAttemptStatus }
  | { type: "attempt-error"; blockId: string; message: string }
  | { type: "terminal-error"; message: string }
  | { type: "busy"; message: string }
  | { type: "exit"; exitCode: number; signal?: number };

/**
 * Frames the terminal observer sent before attempts took over evaluation in f55dcf1. No server
 * code emits them now, so they are named apart from the live union: the browser still narrows them
 * because it still has a branch for each, and `state` stays `unknown` so that branch has to run
 * parsePublicWorkbookState over it rather than trust the frame.
 */
export type PublicTerminalLegacyFrame =
  | { type: "advice"; blockId: string; message: string }
  | { type: "verified-complete"; blockId: string; state: unknown };

export type PublicTerminalMessage = PublicTerminalFrame | PublicTerminalLegacyFrame;

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function text(value: unknown): value is string { return typeof value === "string"; }
function attemptStatus(value: unknown): value is PublicTerminalAttemptStatus { return value === "running" || value === "checking" || value === "submitted"; }

/**
 * Narrows one socket frame. Throws when the frame is not readable JSON, which the caller reports;
 * returns undefined for well-formed JSON this build has no branch for, so an unknown frame type is
 * skipped rather than allowed to end the browser's reading of the socket.
 */
export function parsePublicTerminalMessage(data: unknown): PublicTerminalMessage | undefined {
  if (!text(data)) throw new Error("The workbook terminal socket sent a frame that is not text.");
  const frame: unknown = JSON.parse(data);
  if (!record(frame)) return undefined;
  const blockId = text(frame.blockId) ? frame.blockId : undefined;
  const message = text(frame.message) ? frame.message : undefined;
  switch (frame.type) {
    case "output": return text(frame.data) ? { type: "output", data: frame.data } : undefined;
    case "attempt-status": return attemptStatus(frame.status) ? { type: "attempt-status", blockId, status: frame.status } : undefined;
    case "attempt-error": return blockId !== undefined && message !== undefined ? { type: "attempt-error", blockId, message } : undefined;
    case "terminal-error": return message !== undefined ? { type: "terminal-error", message } : undefined;
    case "busy": return message !== undefined ? { type: "busy", message } : undefined;
    case "exit": return typeof frame.exitCode === "number" ? { type: "exit", exitCode: frame.exitCode, signal: typeof frame.signal === "number" ? frame.signal : undefined } : undefined;
    case "advice": return blockId !== undefined && message !== undefined ? { type: "advice", blockId, message } : undefined;
    case "verified-complete": return blockId !== undefined && "state" in frame ? { type: "verified-complete", blockId, state: frame.state } : undefined;
    default: return undefined;
  }
}

/** Serialises one frame; the argument type is what keeps the server's sends and this union in step. */
export function publicTerminalFrame(frame: PublicTerminalFrame): string { return JSON.stringify(frame); }
