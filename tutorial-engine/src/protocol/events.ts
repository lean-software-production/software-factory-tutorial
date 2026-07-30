import type { InitialPresentation } from "../lesson/contract.js";
import type { ProgressItem } from "../lesson/load.js";

export type RunState = "idle" | "working" | "awaiting-choice" | "failed";

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  label: string;
}

export type TutorialEvent =
  | { type: "snapshot"; title: string; runState: RunState; events: TutorialEvent[]; validationCommands: Array<{ id: string; label: string }>; progress: ProgressItem[] }
  | { type: "run-state"; state: RunState }
  | { type: "assistant-delta"; messageId: string; delta: string }
  | { type: "assistant-message"; messageId: string; markdown: string }
  | { type: "user-message"; markdown: string }
  | { type: "tool-start"; tool: ToolEvent }
  | { type: "tool-progress"; toolId: string; text: string }
  | { type: "tool-complete"; toolId: string; summary: string }
  | { type: "tool-error"; toolId?: string; message: string; retryable: boolean }
  | { type: "validation"; id: string; label: string; command: string; output: string; exitCode: number | null; passed: boolean; durationMs: number }
  | { type: "presentation"; presentation: InitialPresentation }
  | { type: "file-excerpt"; title: string; path: string; startLine: number; content: string; truncated: boolean }
  | { type: "choice"; id: string; question: string; options: ChoiceOption[] }
  | { type: "choice-resolved"; id: string; optionId: string }
  | { type: "error"; message: string; retryable: boolean };

export type BrowserMessage =
  | { type: "chat"; text: string; delivery?: "steer" | "followUp" }
  | { type: "choose"; choiceId: string; optionId: string }
  | { type: "abort" }
  | { type: "run-validation"; commandId: string };

export function isBrowserMessage(value: unknown): value is BrowserMessage {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "abort") return true;
  if (message.type === "chat") return typeof message.text === "string" && message.text.length <= 12_000;
  if (message.type === "choose") return typeof message.choiceId === "string" && typeof message.optionId === "string";
  return message.type === "run-validation" && typeof message.commandId === "string";
}
