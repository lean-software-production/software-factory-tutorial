import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tutorialStatePath } from "./tutorial-state.js";
import type { WorkbookLesson } from "./contract.js";
import type { AttemptKind } from "./attempts.js";
import type { WorkbookTimelineRecord } from "./timeline.js";

export type WorkbookEvent =
  | { type: "session_started"; at: string }
  | { type: "workbook_introduction_completed"; at: string }
  | { type: "observation_acknowledged"; at: string; lessonId: string; blockId: string }
  | { type: "observation_verified"; at: string; lessonId: string; blockId: string; source: "terminal_observer"; summary: string; terminalHtml: string }
  | { type: "attempt_accepted"; at: string; lessonId: string; blockId: string; attemptId: string; version: number; kind: AttemptKind; summary: string }
  | { type: "work_accepted"; at: string; blockId: string }
  | { type: "block_completed"; at: string; blockId: string; lessonId?: string }
  | { type: "block_continued"; at: string; lessonId: string; blockId: string }
  | { type: "reflection_submitted"; at: string; lessonId: string; blockId: string; response: string }
  | { type: "reflection_follow_up_submitted"; at: string; lessonId: string; blockId: string; response: string }
  | { type: "reflection_reply_recorded"; at: string; lessonId: string; blockId: string; response: string }
  | { type: "reflection_completed"; at: string; lessonId: string; blockId: string }
  | { type: "editor_practice_unlocked"; at: string; lessonId: string; blockId: string; revisionId: number; path: string }
  | { type: "lesson_transitioned"; at: string; lessonId: string; blockId: string };

export interface BlockProgress { id: string; type: string; emerged: boolean; ready: boolean; active: boolean; completed: boolean; verified: boolean; checkpoint?: { status: "accepted"; summary: string; kind: AttemptKind }; feedback?: string; terminalHtml?: string; revision?: number; editorStatus?: "editing" | "reviewing" | "feedback" | "unlocked"; }
export type ReflectionTurn = { role: "learner" | "tutor"; text: string };
export interface WorkbookProjection { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: BlockProgress[]; reflections: Record<string, string>; reflectionConversations: Record<string, ReflectionTurn[]>; }


type ProjectedRecord = WorkbookEvent | WorkbookTimelineRecord;

function isWorkflowEvent(record: ProjectedRecord): record is WorkbookEvent {
  return record.type !== "message" && record.type !== "block_summarized" && record.type !== "lesson_summarized" && record.type !== "block_tutor_briefed" && record.type !== "block_tutor_readiness" && record.type !== "tutor_failed";
}

export function introductionCompleted(events: readonly ProjectedRecord[]): boolean {
  return events.some((event) => event.type === "workbook_introduction_completed");
}

export function project(events: readonly ProjectedRecord[], lesson: WorkbookLesson): WorkbookProjection {
  const reflections: Record<string, string> = {};
  const reflectionConversations: Record<string, ReflectionTurn[]> = {};
  const verified = new Map<string, { summary: string; terminalHtml: string }>();
  const editorUnlocks = new Map<string, { revision: number; path: string }>();
  const acceptedCheckpoints = new Map<string, { summary: string; kind: AttemptKind }>();
  const completed = new Set<string>();
  const workAccepted = new Set<string>();
  const activeBlock = () => lesson.blocks.find((block) => !completed.has(block.id));

  for (const record of events) {
    if (record.type === "message" && record.lessonId === lesson.id && lesson.blocks.some((block) => block.id === record.blockId && block.type === "reflection")) {
      if (record.source === "learner") (reflectionConversations[record.blockId] ??= []).push({ role: "learner", text: record.text });
      if (record.source === "main_tutor" && record.presentation === "review") (reflectionConversations[record.blockId] ??= []).push({ role: "tutor", text: record.text });
    }
    if (!isWorkflowEvent(record)) continue;
    const event = record;
    if (event.type === "work_accepted") {
      const acceptedId = event.blockId.includes("--") ? event.blockId.split("--").at(-1)! : event.blockId;
      if (lesson.blocks.some((block) => block.id === acceptedId)) workAccepted.add(acceptedId);
      continue;
    }
    if (!("lessonId" in event) || event.lessonId !== lesson.id) continue;
    if (event.type === "reflection_submitted") { reflections[event.blockId] = event.response; (reflectionConversations[event.blockId] ??= []).push({ role: "learner", text: event.response }); }
    if (event.type === "reflection_follow_up_submitted") (reflectionConversations[event.blockId] ??= []).push({ role: "learner", text: event.response });
    if (event.type === "reflection_reply_recorded") (reflectionConversations[event.blockId] ??= []).push({ role: "tutor", text: event.response });
    if (event.type === "observation_verified") verified.set(event.blockId, { summary: event.summary, terminalHtml: event.terminalHtml });

    const active = activeBlock();
    if (!active || active.id !== event.blockId) continue;
    if (event.type === "attempt_accepted" && (active.type === "editor-practice" || active.type === "terminal-practice" || active.type === "reflection")) acceptedCheckpoints.set(active.id, { summary: event.summary, kind: event.kind });
    if (event.type === "block_continued" && (active.type === "narrative" || acceptedCheckpoints.has(active.id))) completed.add(active.id);
    if (event.type === "block_completed" && active.type === "terminal-practice" && verified.has(active.id)) completed.add(active.id);
    if (event.type === "reflection_completed" && active.type === "reflection") completed.add(active.id);
    if (event.type === "editor_practice_unlocked" && active.type === "editor-practice" && Number.isInteger(event.revisionId) && event.revisionId > 0 && event.path === active.path) {
      editorUnlocks.set(active.id, { revision: event.revisionId, path: event.path });
      completed.add(active.id);
    }
  }

  const next = lesson.blocks.find((block) => !completed.has(block.id));
  const active = next ?? lesson.blocks.at(-1) ?? lesson.blocks[0]!;
  const activeIndex = Math.max(0, lesson.blocks.findIndex((block) => block.id === active.id));
  const readyIndex = next && workAccepted.has(next.id) ? activeIndex + 1 : -1;
  const blocks = lesson.blocks.map((block, index) => {
    const unlock = editorUnlocks.get(block.id);
    const terminalFeedback = verified.get(block.id);
    const checkpoint = acceptedCheckpoints.get(block.id);
    const isActive = next !== undefined && block.id === active.id;
    return {
      id: block.id,
      type: block.type,
      completed: completed.has(block.id),
      verified: verified.has(block.id),
      checkpoint: checkpoint ? { status: "accepted" as const, summary: checkpoint.summary, kind: checkpoint.kind } : undefined,
      feedback: terminalFeedback?.summary,
      terminalHtml: terminalFeedback?.terminalHtml,
      revision: unlock?.revision,
      editorStatus: unlock ? "unlocked" as const : (block.type === "editor-practice" && isActive ? "editing" as const : undefined),
      emerged: index <= activeIndex || index === readyIndex,
      ready: index === readyIndex,
      active: isActive
    };
  });
  const lessonComplete = lesson.blocks.length > 0 && lesson.blocks.every((block) => completed.has(block.id));
  return { activeLessonId: lesson.id, activeBlockId: active.id, completedLessons: lessonComplete ? [lesson.id] : [], blocks, reflections, reflectionConversations };
}

export class WorkbookEventStore {
  readonly eventPath: string;
  readonly projectionPath: string;
  constructor(readonly workspace: string) {
    this.eventPath = tutorialStatePath(workspace, "workbook", "events.jsonl");
    this.projectionPath = tutorialStatePath(workspace, "workbook", "projection.json");
  }
  async read(): Promise<WorkbookEvent[]> {
    try {
      const text = await readFile(this.eventPath, "utf8");
      return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line) as WorkbookEvent; }
        catch (error) { throw new Error(`${this.eventPath}:${index + 1}: invalid JSONL event`); }
      });
    } catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  }
  async append(event: WorkbookEvent): Promise<void> {
    await mkdir(dirname(this.eventPath), { recursive: true });
    await writeFile(this.eventPath, `${JSON.stringify(event)}\n`, { flag: "a" });
  }
  async writeProjection(projection: WorkbookProjection): Promise<void> {
    await mkdir(dirname(this.projectionPath), { recursive: true });
    await writeFile(this.projectionPath, JSON.stringify(projection, null, 2));
  }
}

/**
 * Omit does not distribute over a union: Omit<WorkbookEvent, "at"> collapses to the keys every
 * member shares, so the constraint could not guide inference and per-variant fields widened —
 * `kind: "editor"` became `kind: string`, which no member accepts. Distribute it explicitly.
 */
type WorkbookEventDraft = WorkbookEvent extends infer Member ? (Member extends WorkbookEvent ? Omit<Member, "at"> : never) : never;

export const nowEvent = <T extends WorkbookEventDraft>(event: T): T & { at: string } => ({ ...event, at: new Date().toISOString() });
