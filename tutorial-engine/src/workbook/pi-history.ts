import type { Attempt } from "./attempts.js";
import type { WorkbookBlock } from "./contract.js";
import type { BlockSummary, LessonSummary, WorkbookTimelineRecord } from "./timeline.js";

export type PiHistoryTurn = {
  sourceEventId: string;
  role: "assistant" | "user";
  text: string;
};

export type PiHistoryProjection = {
  summary?: { sourceEventId: string; text: string; coveredThroughId: string };
  turns: PiHistoryTurn[];
};

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

function isSummary(record: WorkbookTimelineRecord): record is BlockSummary | LessonSummary {
  return record.type === "block_summarized" || record.type === "lesson_summarized";
}

/** Select the newest teaching-boundary summary and the exact conversation after its boundary. */
export function projectPiHistory(records: readonly WorkbookTimelineRecord[]): PiHistoryProjection {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  const sequenceForId = new Map(ordered.map((record) => [record.id, record.sequence]));
  const summaries = ordered.filter(isSummary).map((record) => ({ record, coveredSequence: sequenceForId.get(record.coveredThroughId) ?? -1 }));
  const selected = summaries.sort((left, right) => left.coveredSequence - right.coveredSequence || left.record.sequence - right.record.sequence).at(-1);
  const boundary = selected?.coveredSequence ?? 0;
  const turns = ordered
    .filter((record): record is Extract<WorkbookTimelineRecord, { type: "message" }> => record.type === "message" && record.sequence > boundary)
    .map((record) => ({ sourceEventId: record.id, role: record.role, text: record.text }));
  return selected
    ? { summary: { sourceEventId: selected.record.id, text: selected.record.text, coveredThroughId: selected.record.coveredThroughId }, turns }
    : { turns };
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
export function authoredBlockText(block: Pick<WorkbookBlock, "title" | "markdown">): string {
  return `## ${block.title}\n\n${block.markdown}`;
}
