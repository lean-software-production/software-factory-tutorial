import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tutorialStatePath } from "../tutorial-state.js";
import type { AttemptKind } from "./attempts.js";

export type TimelineMetadata = { id: string; sequence: number; at: string };

export type WorkflowPayload =
  | { type: "session_started" }
  | { type: "workbook_introduction_completed" }
  | { type: "observation_acknowledged"; lessonId: string; blockId: string }
  | { type: "observation_verified"; lessonId: string; blockId: string; source: "terminal_observer"; summary: string; terminalHtml: string }
  | { type: "attempt_accepted"; lessonId: string; blockId: string; attemptId: string; version: number; kind: AttemptKind; summary: string }
  | { type: "block_completed"; lessonId: string; blockId: string }
  | { type: "block_continued"; lessonId: string; blockId: string }
  | { type: "unexpected_output_submitted"; lessonId: string; blockId: string; evidence: string }
  | { type: "reflection_submitted"; lessonId: string; blockId: string; response: string }
  | { type: "reflection_follow_up_submitted"; lessonId: string; blockId: string; response: string }
  | { type: "reflection_reply_recorded"; lessonId: string; blockId: string; response: string }
  | { type: "reflection_completed"; lessonId: string; blockId: string }
  | { type: "editor_practice_unlocked"; lessonId: string; blockId: string; revisionId: number; path: string }
  | { type: "help_requested"; lessonId: string; blockId: string; request: string }
  | { type: "lesson_transitioned"; lessonId: string; blockId: string };

export type WorkbookWorkflowEvent = WorkflowPayload & TimelineMetadata;

export type TimelineMessage = TimelineMetadata & {
  type: "message";
  lessonId: string;
  blockId: string;
  role: "assistant" | "user";
  source: "authored" | "learner" | "tutor";
  presentation: "course" | "chat" | "review";
  text: string;
  inReplyTo?: string;
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
  operation: "reply" | "review" | "restore" | "block_summary" | "lesson_summary";
  publicMessage: string;
};

export type WorkbookTimelineRecord = WorkbookWorkflowEvent | TimelineMessage | BlockSummary | LessonSummary | TutorFailure;
export type TimelineAppendInput =
  | WorkflowPayload
  | Omit<TimelineMessage, keyof TimelineMetadata>
  | Omit<BlockSummary, keyof TimelineMetadata>
  | Omit<LessonSummary, keyof TimelineMetadata>
  | Omit<TutorFailure, keyof TimelineMetadata>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function legacyRecord(value: unknown, line: number): WorkbookTimelineRecord {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error(`Invalid workbook timeline record at line ${line}.`);
  const id = typeof value.id === "string" ? value.id : `legacy:${line}`;
  const sequence = Number.isInteger(value.sequence) && (value.sequence as number) > 0 ? value.sequence as number : line;
  const at = typeof value.at === "string" ? value.at : new Date(0).toISOString();
  return { ...value, id, sequence, at } as WorkbookTimelineRecord;
}

/**
 * The workbook's durable session record. A successful append is written before listeners can expose it
 * to the browser or use it to rebuild tutor context.
 */
export class WorkbookTimeline {
  readonly eventPath: string;
  #tail: Promise<unknown> = Promise.resolve();
  #listeners = new Set<(record: WorkbookTimelineRecord) => void>();

  constructor(workspace: string) {
    this.eventPath = tutorialStatePath(workspace, "workbook", "events.jsonl");
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
        return legacyRecord(JSON.parse(line), index + 1);
      } catch (error) {
        throw new Error(`${this.eventPath}:${index + 1}: ${error instanceof Error ? error.message : "invalid JSONL event"}`);
      }
    });
  }

  append(input: TimelineAppendInput): Promise<WorkbookTimelineRecord> {
    return this.run(() => this.appendWithinRun(input));
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
