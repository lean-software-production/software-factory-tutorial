import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tutorialStatePath } from "../tutorial-state.js";
import type { WorkbookLesson } from "./contract.js";

export type WorkbookEvent =
  | { type: "session_started"; at: string }
  | { type: "workbook_introduction_completed"; at: string }
  | { type: "observation_acknowledged"; at: string; lessonId: string; blockId: string }
  | { type: "observation_verified"; at: string; lessonId: string; blockId: string; source: "terminal_observer"; summary: string; terminalHtml: string }
  | { type: "block_completed"; at: string; lessonId: string; blockId: string }
  | { type: "block_continued"; at: string; lessonId: string; blockId: string }
  | { type: "unexpected_output_submitted"; at: string; lessonId: string; blockId: string; evidence: string }
  | { type: "reflection_submitted"; at: string; lessonId: string; blockId: string; response: string }
  | { type: "reflection_follow_up_submitted"; at: string; lessonId: string; blockId: string; response: string }
  | { type: "reflection_reply_recorded"; at: string; lessonId: string; blockId: string; response: string }
  | { type: "reflection_completed"; at: string; lessonId: string; blockId: string }
  | { type: "help_requested"; at: string; lessonId: string; blockId: string; request: string }
  | { type: "lesson_transitioned"; at: string; lessonId: string; blockId: string };

export interface BlockProgress { id: string; type: string; emerged: boolean; ready: boolean; active: boolean; completed: boolean; verified: boolean; feedback?: string; terminalHtml?: string; }
export type ReflectionTurn = { role: "learner" | "tutor"; text: string };
export interface WorkbookProjection { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: BlockProgress[]; unexpected: Record<string, string[]>; reflections: Record<string, string>; reflectionConversations: Record<string, ReflectionTurn[]>; }


export function introductionCompleted(events: readonly WorkbookEvent[]): boolean {
  return events.some((event) => event.type === "workbook_introduction_completed");
}

export function project(events: readonly WorkbookEvent[], lesson: WorkbookLesson): WorkbookProjection {
  const continued = new Set<string>();
  const terminalCompletions = new Set<string>();
  const reflectionCompletions = new Set<string>();
  const unexpected: Record<string, string[]> = {};
  const reflections: Record<string, string> = {};
  const reflectionConversations: Record<string, ReflectionTurn[]> = {};
  const verified = new Map<string, { summary: string; terminalHtml: string }>();
  for (const event of events) {
    if (!("lessonId" in event) || event.lessonId !== lesson.id) continue;
    if (event.type === "unexpected_output_submitted") (unexpected[event.blockId] ??= []).push(event.evidence);
    if (event.type === "reflection_submitted") { reflections[event.blockId] = event.response; (reflectionConversations[event.blockId] ??= []).push({ role: "learner", text: event.response }); }
    if (event.type === "reflection_follow_up_submitted") (reflectionConversations[event.blockId] ??= []).push({ role: "learner", text: event.response });
    if (event.type === "reflection_reply_recorded") (reflectionConversations[event.blockId] ??= []).push({ role: "tutor", text: event.response });
    if (event.type === "observation_verified") verified.set(event.blockId, { summary: event.summary, terminalHtml: event.terminalHtml });
    if (event.type === "block_continued" || event.type === "lesson_transitioned") continued.add(event.blockId);
    if (event.type === "block_completed") terminalCompletions.add(event.blockId);
    if (event.type === "reflection_completed") reflectionCompletions.add(event.blockId);
  }

  const completed = new Set<string>();
  for (const block of lesson.blocks) {
    if ((block.type === "narrative" || block.type === "lesson-transition") && continued.has(block.id)) completed.add(block.id);
    if (block.type === "terminal-practice" && verified.has(block.id) && terminalCompletions.has(block.id)) completed.add(block.id);
    if (block.type === "reflection" && reflectionCompletions.has(block.id)) completed.add(block.id);
  }
  const next = lesson.blocks.find((block) => !completed.has(block.id));
  const active = next ?? lesson.blocks.at(-1) ?? lesson.blocks[0]!;
  const activeIndex = Math.max(0, lesson.blocks.findIndex((block) => block.id === active.id));
  const blocks = lesson.blocks.map((block, index) => ({
    id: block.id,
    type: block.type,
    completed: completed.has(block.id),
    verified: verified.has(block.id),
    feedback: verified.get(block.id)?.summary,
    terminalHtml: verified.get(block.id)?.terminalHtml,
    emerged: index <= activeIndex,
    ready: index <= activeIndex,
    active: next !== undefined && block.id === active.id
  }));
  const lessonComplete = lesson.blocks.length > 0 && lesson.blocks.every((block) => completed.has(block.id));
  return { activeLessonId: lesson.id, activeBlockId: active.id, completedLessons: lessonComplete ? [lesson.id] : [], blocks, unexpected, reflections, reflectionConversations };
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

export const nowEvent = <T extends Omit<WorkbookEvent, "at">>(event: T): T & { at: string } => ({ ...event, at: new Date().toISOString() });
