import type { InitialPresentation } from "../lesson/contract.js";
import type { ProgressItem } from "../lesson/load.js";

export type RunState = "idle" | "working" | "awaiting-choice" | "failed";

export const choiceIconCategories = ["do", "show", "confirm", "automate", "pause", "restart"] as const;
export type ChoiceIconCategory = (typeof choiceIconCategories)[number];

export interface ChoiceOption {
  id: string;
  label: string;
  icon: ChoiceIconCategory;
  description?: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  label: string;
}

/** A path-safe record of a tutor filesystem operation. */
export interface AuditEvent {
  type: "audit";
  id: string;
  tool: string;
  paths: string[];
  mutation: boolean;
  outcome: "ok" | "rejected" | "error";
  message?: string;
}

export interface SessionBootstrap {
  state: "select" | "starting" | "active";
  hasSavedSession: boolean;
}

export type TutorialEvent =
  | { type: "snapshot"; title: string; runState: RunState; activity: string; events: TutorialEvent[]; validationCommands: Array<{ id: string; label: string }>; progress: ProgressItem[]; session: SessionBootstrap }
  | { type: "session-state"; session: SessionBootstrap }
  /** The lesson outline after a lesson was finished. Status, not transcript. */
  | { type: "progress"; progress: ProgressItem[] }
  | { type: "run-state"; state: RunState }
  /** What the tutor is doing right now, for the spinner. Status, not transcript: see `TRANSIENT_EVENTS`. */
  | { type: "activity"; text: string }
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
  | { type: "choice"; id: string; question: string; options: ChoiceOption[]; historical?: boolean }
  | { type: "choice-resolved"; id: string; optionId: string }
  | AuditEvent
  | { type: "error"; message: string; retryable: boolean };

/**
 * Events that describe the moment rather than the transcript. They are never
 * kept in the bus history and never written to the session log, so a resumed
 * session cannot replay a stale "reading README.md" as though it just happened.
 */
const TRANSIENT_EVENTS = new Set<TutorialEvent["type"]>(["snapshot", "session-state", "activity", "progress"]);

export function isTranscriptEvent(event: TutorialEvent): boolean {
  return !TRANSIENT_EVENTS.has(event.type);
}

/**
 * An activity is phrased to suit the engine's log, where the heartbeat repeats
 * it as "Tutor is still working: running read README.md (30 seconds)". Under
 * the browser's spinner it is a caption of its own, so it starts a sentence and
 * trails off while the work continues — unless it already trails off partway,
 * as "waiting for Pi… read README.md" does, where a second ellipsis would only
 * clutter the line.
 */
export function activityCaption(activity: string): string {
  const trimmed = activity.trim();
  if (!trimmed) return "Thinking…";
  const sentence = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return sentence.includes("…") ? sentence : `${sentence}…`;
}

export type BrowserMessage =
  /** `part-2` clears factory/, seeds Part 1's output, and opens the first Part 2 lesson. */
  | { type: "start-session"; mode: "resume" | "fresh" | "part-2" }
  | { type: "chat"; text: string; delivery?: "steer" | "followUp" }
  | { type: "choose"; choiceId: string; optionId: string }
  | { type: "abort" }
  | { type: "run-validation"; commandId: string };

export function isBrowserMessage(value: unknown): value is BrowserMessage {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "abort") return true;
  if (message.type === "start-session") return message.mode === "resume" || message.mode === "fresh" || message.mode === "part-2";
  if (message.type === "chat") return typeof message.text === "string" && message.text.length <= 12_000 && (message.delivery === undefined || message.delivery === "steer" || message.delivery === "followUp");
  if (message.type === "choose") return typeof message.choiceId === "string" && typeof message.optionId === "string";
  return message.type === "run-validation" && typeof message.commandId === "string";
}

/** Keep wire serialization shared by the browser, server, and eval driver. */
export function serializeBrowserMessage(message: BrowserMessage): string {
  return JSON.stringify(message);
}

export function parseTutorialEvent(value: string): TutorialEvent {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") throw new Error("Invalid tutorial event.");
  return parsed as TutorialEvent;
}
