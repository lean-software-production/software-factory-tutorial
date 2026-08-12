import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { WorkbookLesson } from "./contract.js";

export type WorkbookEvent =
  | { type: "session_started"; at: string }
  | { type: "observation_acknowledged"; at: string; lessonId: string; blockId: string }
  | { type: "unexpected_output_submitted"; at: string; lessonId: string; blockId: string; evidence: string }
  | { type: "reflection_submitted"; at: string; lessonId: string; blockId: string; response: string }
  | { type: "help_requested"; at: string; lessonId: string; blockId: string; request: string }
  | { type: "lesson_transitioned"; at: string; lessonId: string; blockId: string };

export interface BlockProgress { id: string; type: string; ready: boolean; active: boolean; completed: boolean; }
export interface WorkbookProjection { activeLessonId: string; activeBlockId: string; completedLessons: string[]; blocks: BlockProgress[]; unexpected: Record<string, string[]>; reflections: Record<string, string>; }

const completionEvents = new Set<WorkbookEvent["type"]>(["observation_acknowledged", "reflection_submitted", "lesson_transitioned"]);

export function project(events: readonly WorkbookEvent[], lesson: WorkbookLesson): WorkbookProjection {
  const completed = new Set<string>();
  const unexpected: Record<string, string[]> = {};
  const reflections: Record<string, string> = {};
  for (const event of events) {
    if (event.type === "unexpected_output_submitted") (unexpected[event.blockId] ??= []).push(event.evidence);
    if (event.type === "reflection_submitted") reflections[event.blockId] = event.response;
    if ("blockId" in event && event.lessonId === lesson.id && completionEvents.has(event.type)) completed.add(event.blockId);
  }
  const required = lesson.blocks.filter((block) => block.required);
  const active = required.find((block) => !completed.has(block.id)) ?? required.at(-1) ?? lesson.blocks[0]!;
  const activeIndex = lesson.blocks.findIndex((block) => block.id === active.id);
  const blocks = lesson.blocks.map((block, index) => ({
    id: block.id,
    type: block.type,
    completed: completed.has(block.id),
    ready: !block.required || index <= activeIndex || completed.has(block.id),
    active: block.id === active.id && !completed.has(block.id)
  }));
  const lessonComplete = required.length > 0 && required.every((block) => completed.has(block.id));
  return { activeLessonId: lesson.id, activeBlockId: active.id, completedLessons: lessonComplete ? [lesson.id] : [], blocks, unexpected, reflections };
}

export class WorkbookEventStore {
  readonly eventPath: string;
  readonly projectionPath: string;
  constructor(readonly workspace: string) {
    const root = resolve(workspace, "factory/.tmp/workbook");
    this.eventPath = resolve(root, "events.jsonl");
    this.projectionPath = resolve(root, "projection.json");
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
