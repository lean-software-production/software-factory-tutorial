import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tutorialSessionStatePath, tutorialStatePath } from "./tutorial-state.js";
import type { AttemptKind } from "./attempts.js";

export type TimelineMetadata = { id: string; sequence: number; at: string };

export const CURRENT_WORKBOOK_SESSION_FORMAT_VERSION = 1;
export const WORKBOOK_SESSION_FORMAT_RECORD_TYPE = "workbook-session-format";
export type WorkbookSessionFormatRecord = { type: typeof WORKBOOK_SESSION_FORMAT_RECORD_TYPE; version: typeof CURRENT_WORKBOOK_SESSION_FORMAT_VERSION };

export function workbookSessionFormatRecord(): WorkbookSessionFormatRecord {
  return { type: WORKBOOK_SESSION_FORMAT_RECORD_TYPE, version: CURRENT_WORKBOOK_SESSION_FORMAT_VERSION };
}

export class UnsupportedWorkbookSessionError extends Error {
  constructor(detail: string) {
    super(`Unsupported workbook session format: ${detail}. Please start fresh with a new workbook session.`);
    this.name = "UnsupportedWorkbookSessionError";
  }
}

/**
 * The durable terminal lifecycle. Commands, evidence references, and review requests/failures stay
 * private. A bounded, sanitized terminal transcript is the sole browser-safe terminal payload: it is
 * written only when an attempt is accepted and is projected as historical output for that authored
 * block.
 */
export type TerminalReviewRequestMode = "automatic" | "manual";

export type TerminalLifecycleInput =
  | { type: "terminal-command-submitted"; attemptId: string; lessonId: string; blockId: string; command: string; terminalSessionId: string }
  | { type: "terminal-command-finished"; attemptId: string; exitStatus: number; evidenceRef: string }
  | { type: "terminal-review-requested"; attemptId: string; lessonId: string; blockId: string; evidenceRef: string; requestId: string; mode: TerminalReviewRequestMode; callNumber: number }
  | { type: "terminal-review-failed"; attemptId: string; lessonId: string; blockId: string; evidenceRef: string; requestId: string; failureId: string; publicMessage: string }
  | { type: "terminal-transcript-snapshotted"; attemptId: string; lessonId: string; blockId: string; transcript: string }
  | { type: "terminal-feedback-recorded"; attemptId: string; text: string };

export type TerminalLifecycleEvent = TerminalLifecycleInput & TimelineMetadata;

export type WorkbookWorkflowInput =
  | { type: "session_started" }
  | { type: "lesson_jump_started"; lessonId: string }
  | { type: "workbook_introduction_completed" }
  | { type: "attempt_accepted"; lessonId: string; blockId: string; attemptId: string; version: number; kind: AttemptKind; summary: string }
  | { type: "work_accepted"; blockId: string }
  | { type: "block_completed"; blockId: string; lessonId?: string }
  | { type: "reflection_submitted"; lessonId: string; blockId: string; response: string }
  | { type: "reflection_follow_up_submitted"; lessonId: string; blockId: string; response: string }
  | { type: "reflection_reply_recorded"; lessonId: string; blockId: string; response: string };

export type WorkbookWorkflowEvent = WorkbookWorkflowInput & TimelineMetadata;

export type TimelineMessageSource = "authored" | "learner" | "main_tutor";
export type MainTutorSource = Extract<TimelineMessageSource, "main_tutor">;
export type TimelinePresentation = "course" | "chat" | "review";
export type TutorPresentation = Extract<TimelinePresentation, "chat" | "review">;

export type TimelineMessage = TimelineMetadata & {
  type: "message";
  lessonId: string;
  blockId: string;
  role: "assistant" | "user";
  source: TimelineMessageSource;
  presentation: TimelinePresentation;
  text: string;
  inReplyTo?: string;
  /** Canonical block visible at the reading line when the learner sent this message. */
  blockInView?: string;
};

export type BlockSummary = TimelineMetadata & {
  type: "block_summarized";
  lessonId: string;
  blockId: string;
  text: string;
  coveredThroughId: string;
};

export type LessonSummary = TimelineMetadata & {
  type: "lesson_summarized";
  lessonId: string;
  text: string;
  coveredThroughId: string;
};

export type TutorFailure = TimelineMetadata & {
  type: "tutor_failed";
  lessonId: string;
  blockId: string;
  requestId: string;
  operation: "reply" | "review" | "restore" | "block_summary" | "lesson_summary" | "completion_summary";
  publicMessage: string;
};

export type WorkbookCompletionSummary = TimelineMetadata & {
  type: "workbook_completion_summary";
  text: string;
};

export type WorkbookTimelineRecord = WorkbookWorkflowEvent | TerminalLifecycleEvent | TimelineMessage | BlockSummary | LessonSummary | TutorFailure | WorkbookCompletionSummary;
export type TimelineAppendInput =
  | WorkbookWorkflowInput
  | TerminalLifecycleInput
  | Omit<TimelineMessage, keyof TimelineMetadata>
  | Omit<BlockSummary, keyof TimelineMetadata>
  | Omit<LessonSummary, keyof TimelineMetadata>
  | Omit<TutorFailure, keyof TimelineMetadata>
  | Omit<WorkbookCompletionSummary, keyof TimelineMetadata>;

const CURRENT_RECORD_TYPES = new Set<string>([
  "session_started",
  "lesson_jump_started",
  "workbook_introduction_completed",
  "attempt_accepted",
  "work_accepted",
  "block_completed",
  "reflection_submitted",
  "reflection_follow_up_submitted",
  "reflection_reply_recorded",
  "terminal-command-submitted",
  "terminal-command-finished",
  "terminal-review-requested",
  "terminal-review-failed",
  "terminal-transcript-snapshotted",
  "terminal-feedback-recorded",
  "message",
  "block_summarized",
  "lesson_summarized",
  "tutor_failed",
  "workbook_completion_summary",
]);

const LEGACY_RECORD_TYPES = new Set<string>([
  "terminal-coach-handoff-recorded",
  "observation_acknowledged",
  "observation_verified",
  "block_continued",
  "reflection_completed",
  "editor_practice_unlocked",
  "lesson_transitioned",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedVersionDetail(version: unknown): string {
  return typeof version === "number"
    ? `format version ${version} is not supported by current version ${CURRENT_WORKBOOK_SESSION_FORMAT_VERSION}`
    : `missing format version; current version is ${CURRENT_WORKBOOK_SESSION_FORMAT_VERSION}`;
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  try { return JSON.parse(line); }
  catch { throw new Error(`Invalid workbook timeline record at line ${lineNumber}: invalid JSONL event`); }
}

function requireFormatRecord(value: unknown): void {
  if (!isRecord(value) || value.type !== WORKBOOK_SESSION_FORMAT_RECORD_TYPE) throw new UnsupportedWorkbookSessionError(unsupportedVersionDetail(undefined));
  if (value.version !== CURRENT_WORKBOOK_SESSION_FORMAT_VERSION) throw new UnsupportedWorkbookSessionError(unsupportedVersionDetail(value.version));
}

export function normalizeWorkbookTimelineRecord(value: unknown, line: number): WorkbookTimelineRecord {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error(`Invalid workbook timeline record at line ${line}.`);
  if (LEGACY_RECORD_TYPES.has(value.type)) throw new UnsupportedWorkbookSessionError(`record '${value.type}' belongs to an older workbook session format`);
  if (!CURRENT_RECORD_TYPES.has(value.type)) throw new Error(`Invalid workbook timeline record at line ${line}: unknown record type '${value.type}'.`);
  if (typeof value.id !== "string" || !value.id) throw new Error(`Invalid workbook timeline record at line ${line}: id is required.`);
  if (!Number.isInteger(value.sequence) || (value.sequence as number) <= 0) throw new Error(`Invalid workbook timeline record at line ${line}: sequence is required.`);
  if (typeof value.at !== "string" || !value.at) throw new Error(`Invalid workbook timeline record at line ${line}: at is required.`);
  if (value.type === "message") {
    if (value.source !== "authored" && value.source !== "learner" && value.source !== "main_tutor") throw new Error(`Invalid workbook timeline record at line ${line}: message source is invalid.`);
  }
  return value as WorkbookTimelineRecord;
}

/**
 * The workbook's durable session record. A successful append is written before listeners can expose it
 * to the browser or use it to rebuild tutor context.
 */
export interface WorkbookTimelineRoots { stateRoot: string; }

export class WorkbookTimeline {
  readonly eventPath: string;
  #tail: Promise<unknown> = Promise.resolve();
  #listeners = new Set<(record: WorkbookTimelineRecord) => void>();

  constructor(workspace: string);
  constructor(roots: WorkbookTimelineRoots);
  constructor(input: string | WorkbookTimelineRoots) {
    const stateRoot = typeof input === "string" ? tutorialStatePath(input) : input.stateRoot;
    this.eventPath = tutorialSessionStatePath(stateRoot, "workbook", "events.jsonl");
  }

  read(): Promise<WorkbookTimelineRecord[]> {
    return this.run(() => this.readWithinRun());
  }

  /** Read and, for a brand-new absent log only, initialize as one step of an operation already serialized through run(). */
  async readWithinRun(): Promise<WorkbookTimelineRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.eventPath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        await this.initializeWithinRun();
        return [];
      }
      throw error;
    }
    const rawLines = contents.split(/\r?\n/);
    while (rawLines.at(-1) === "") rawLines.pop();
    if (rawLines.length === 0) throw new UnsupportedWorkbookSessionError(unsupportedVersionDetail(undefined));
    let first: unknown;
    try { first = parseJsonLine(rawLines[0]!, 1); }
    catch { throw new UnsupportedWorkbookSessionError(unsupportedVersionDetail(undefined)); }
    requireFormatRecord(first);
    return rawLines.slice(1).filter(Boolean).map((line, index) => {
      const lineNumber = index + 2;
      try {
        return normalizeWorkbookTimelineRecord(parseJsonLine(line, lineNumber), lineNumber);
      } catch (error) {
        if (error instanceof UnsupportedWorkbookSessionError) throw error;
        const message = error instanceof Error ? error.message : "invalid JSONL event";
        throw new Error(`${this.eventPath}:${lineNumber}: ${message.includes("invalid JSONL event") ? "invalid JSONL event" : message}`);
      }
    });
  }

  initialize(): Promise<void> {
    return this.run(() => this.initializeWithinRun());
  }

  async initializeWithinRun(): Promise<void> {
    await mkdir(dirname(this.eventPath), { recursive: true });
    try {
      await writeFile(this.eventPath, `${JSON.stringify(workbookSessionFormatRecord())}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  append(input: TimelineAppendInput): Promise<WorkbookTimelineRecord> {
    return this.run(() => this.appendWithinRun(input));
  }

  reset(): Promise<void> {
    return this.run(() => this.resetWithinRun());
  }

  /** Clear the presentation timeline as one step of an operation already serialized through run(). */
  async resetWithinRun(): Promise<void> {
    await rm(this.eventPath, { force: true });
  }

  /** Append as one step of an operation already serialized through run(). */
  async appendWithinRun(input: TimelineAppendInput): Promise<WorkbookTimelineRecord> {
    const existing = await this.readWithinRun();
    const record = { ...input, id: randomUUID(), sequence: (existing.at(-1)?.sequence ?? 0) + 1, at: new Date().toISOString() } as WorkbookTimelineRecord;
    await mkdir(dirname(this.eventPath), { recursive: true });
    await appendFile(this.eventPath, `${JSON.stringify(record)}\n`, "utf8");
    for (const listener of this.#listeners) listener(record);
    return record;
  }

  subscribe(listener: (record: WorkbookTimelineRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.catch(() => undefined).then(operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
