import type { Attempt } from "./attempts.js";
import type { WorkbookBlock, WorkbookLesson } from "./contract.js";
import type { BlockSummary, LessonSummary, TimelineMessage, WorkbookTimelineRecord } from "./timeline.js";

export type PiHistorySummary = {
  sourceEventId: string;
  scope: "lesson" | "block";
  lessonId: string;
  blockId?: string;
  text: string;
  coveredThroughId: string;
  timestamp: number;
};

export type PiHistoryTurn = {
  sourceEventId: string;
  role: "assistant" | "user";
  text: string;
  timestamp: number;
  blockInView?: string;
};

export type PiHistoryProjection = {
  summaries: PiHistorySummary[];
  turns: PiHistoryTurn[];
};

export const INTRODUCTION_LESSON_ID = "workbook:introduction";
export const INTRODUCTION_BLOCK_ID = "__introduction__";
export const PART_BLOCK_ID = "__part__";
export const LESSON_FRAME_BLOCK_ID = "__lesson_frame__";

export function partLessonId(partId: string): string { return `workbook:part:${partId}`; }

export type ActiveBlockContext = {
  lessonId: string;
  blockId: string;
  title: string;
  markdown: string;
  authorGuidance: string;
  attempts: Attempt[];
};

export type MainTutorHistoryProjection = PiHistoryProjection & {
  activeContext?: { name: "workbook-active-block"; text: string; sourceEventIds: string[] };
};

function timestampFor(record: WorkbookTimelineRecord): number {
  const timestamp = Date.parse(record.at);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid workbook history timestamp for event ${record.id}: ${record.at}`);
  return timestamp;
}

function summaryEventSequence(summary: PiHistorySummary, recordsById: ReadonlyMap<string, WorkbookTimelineRecord>): number {
  return recordsById.get(summary.sourceEventId)?.sequence ?? 0;
}

function mapSummary(record: BlockSummary | LessonSummary): PiHistorySummary {
  const base = {
    sourceEventId: record.id,
    lessonId: record.lessonId,
    text: record.text,
    coveredThroughId: record.coveredThroughId,
    timestamp: timestampFor(record)
  };
  return record.type === "lesson_summarized"
    ? { ...base, scope: "lesson" }
    : { ...base, scope: "block", blockId: record.blockId };
}

function mapTurn(record: TimelineMessage): PiHistoryTurn {
  return { sourceEventId: record.id, role: record.role, text: record.text, timestamp: timestampFor(record), blockInView: record.blockInView };
}

function isStructuralBlockMessage(record: TimelineMessage): boolean {
  return record.blockId === "workbook--introduction" || record.blockId.startsWith("part--") || /^lesson--[^-]+(?:-[^-]+)*$/.test(record.blockId);
}

/** Select the hierarchical teaching-boundary summaries and the exact conversation after their boundary. */
export function projectPiHistory(records: readonly WorkbookTimelineRecord[]): PiHistoryProjection {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  const recordsById = new Map(ordered.map((record) => [record.id, record]));
  const sequenceForId = new Map(ordered.map((record) => [record.id, record.sequence]));
  const lessonSummaries = new Map<string, LessonSummary>();
  const blockSummaries = new Map<string, BlockSummary>();

  for (const record of ordered) {
    if (record.type === "lesson_summarized") lessonSummaries.set(record.lessonId, record);
    if (record.type === "block_summarized") blockSummaries.set(`${record.lessonId}\u0000${record.blockId}`, record);
  }

  const selectedLessonSummaries = [...lessonSummaries.values()];
  const selectedBlockSummaries = [...blockSummaries.values()].filter((blockSummary) => {
    const lessonSummary = lessonSummaries.get(blockSummary.lessonId);
    return !lessonSummary || blockSummary.sequence > lessonSummary.sequence;
  });

  const summaries = [...selectedLessonSummaries, ...selectedBlockSummaries]
    .sort((left, right) => left.sequence - right.sequence)
    .map(mapSummary);
  const boundary = summaries.reduce((maximum, summary) => Math.max(maximum, sequenceForId.get(summary.coveredThroughId) ?? -1), 0);
  const turns = ordered
    .filter((record): record is TimelineMessage => record.type === "message" && (record.sequence > boundary || isStructuralBlockMessage(record)))
    .map(mapTurn);

  summaries.sort((left, right) => summaryEventSequence(left, recordsById) - summaryEventSequence(right, recordsById));
  return { summaries, turns };
}

export function projectMainTutorHistory(records: readonly WorkbookTimelineRecord[], activeContext?: ActiveBlockContext): MainTutorHistoryProjection {
  const projection = projectPiHistory(records);
  if (!activeContext) return projection;
  const turnIds = new Set(projection.turns.map((turn) => turn.sourceEventId));
  const sourceEventIds = [...records]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((record) => record.type === "message" && record.lessonId === activeContext.lessonId && record.blockId === activeContext.blockId && turnIds.has(record.id))
    .map((record) => record.id);
  return {
    ...projection,
    activeContext: { name: "workbook-active-block", text: JSON.stringify(activeContext, null, 2), sourceEventIds }
  };
}

/** The exact course text displayed at the top of a workbook block. */
export function authoredIntroductionText(workbook: { title: string }, introduction: string): string {
  return `# ${workbook.title}\n\n${introduction}`;
}

export function authoredPartText(part: { title: string; markdown?: string }): string {
  const body = part.markdown?.trim();
  return body ? `# ${part.title}\n\n${body}` : `# ${part.title}`;
}

export function authoredLessonFrameText(lesson: Pick<WorkbookLesson, "title" | "dek" | "introduction" | "outcomes">): string {
  return [
    `# ${lesson.title}`,
    lesson.dek,
    "## What you will learn",
    lesson.outcomes.map((outcome) => `- ${outcome}`).join("\n"),
    lesson.introduction.trim(),
  ].filter((section) => section.trim().length > 0).join("\n\n");
}

export function authoredBlockText(block: Pick<WorkbookBlock, "title" | "markdown">): string {
  return `## ${block.title}\n\n${block.markdown}`;
}
