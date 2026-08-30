import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { tutorialSessionStatePath, tutorialStatePath } from "./tutorial-state.js";
import type { AttemptKind } from "./attempts.js";

export type TimelineMetadata = { id: string; sequence: number; at: string };

/** Historical terminal-coach handoff outcomes still parsed for old private session logs. */
export type LegacyTerminalHandoffOutcome = "ready" | "interesting";

/**
 * The durable terminal lifecycle. Commands, evidence references, review requests/failures, and
 * legacy terminal-coach handoffs stay private. A bounded, sanitized terminal transcript is the sole
 * browser-safe terminal payload: it is written only when an attempt is accepted and is projected as
 * historical output for that authored block.
 */
export type TerminalReviewRequestMode = "automatic" | "manual";

export type TerminalLifecycleInput =
  | { type: "terminal-command-submitted"; attemptId: string; lessonId: string; blockId: string; command: string; terminalSessionId: string }
  | { type: "terminal-command-finished"; attemptId: string; exitStatus: number; evidenceRef: string }
  | { type: "terminal-review-requested"; attemptId: string; lessonId: string; blockId: string; evidenceRef: string; requestId: string; mode: TerminalReviewRequestMode; callNumber: number }
  | { type: "terminal-review-failed"; attemptId: string; lessonId: string; blockId: string; evidenceRef: string; requestId: string; failureId: string; publicMessage: string }
  | { type: "terminal-transcript-snapshotted"; attemptId: string; lessonId: string; blockId: string; transcript: string }
  | { type: "terminal-feedback-recorded"; attemptId: string; text: string };

export type LegacyTerminalHandoffEvent = { type: "terminal-coach-handoff-recorded"; attemptId: string; outcome: LegacyTerminalHandoffOutcome; text: string } & TimelineMetadata;
export type TerminalLifecycleEvent = (TerminalLifecycleInput & TimelineMetadata) | LegacyTerminalHandoffEvent;

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

/** Historical rows read from pre-stream sessions; new rows must not use these payloads. */
export type LegacyWorkbookWorkflowInput =
  | { type: "observation_acknowledged"; lessonId: string; blockId: string }
  | { type: "observation_verified"; lessonId: string; blockId: string; source: "terminal_observer"; summary: string; terminalHtml: string }
  | { type: "block_continued"; lessonId: string; blockId: string }
  | { type: "reflection_completed"; lessonId: string; blockId: string }
  | { type: "editor_practice_unlocked"; lessonId: string; blockId: string; revisionId: number; path: string }
  | { type: "lesson_transitioned"; lessonId: string; blockId: string };

export type WorkbookWorkflowEvent = (WorkbookWorkflowInput | LegacyWorkbookWorkflowInput) & TimelineMetadata;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWorkbookTimelineRecord(value: unknown, line: number): WorkbookTimelineRecord {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error(`Invalid workbook timeline record at line ${line}.`);
  const id = typeof value.id === "string" ? value.id : `legacy:${line}`;
  const sequence = Number.isInteger(value.sequence) && (value.sequence as number) > 0 ? value.sequence as number : line;
  const at = typeof value.at === "string" ? value.at : new Date(0).toISOString();
  const record: Record<string, unknown> & TimelineMetadata = { ...value, id, sequence, at };
  if (record.type === "message" && record.source === "tutor") return { ...record, source: "main_tutor" } as WorkbookTimelineRecord;
  return record as WorkbookTimelineRecord;
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

  async read(): Promise<WorkbookTimelineRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.eventPath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return contents.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return normalizeWorkbookTimelineRecord(JSON.parse(line), index + 1);
      } catch (error) {
        throw new Error(`${this.eventPath}:${index + 1}: ${error instanceof Error ? error.message : "invalid JSONL event"}`);
      }
    });
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
    const existing = await this.read();
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
