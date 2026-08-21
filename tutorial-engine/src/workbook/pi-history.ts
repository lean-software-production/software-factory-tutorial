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

/** The exact course text displayed at the top of a workbook block. */
export function authoredBlockText(block: Pick<WorkbookBlock, "title" | "markdown">): string {
  return `## ${block.title}\n\n${block.markdown}`;
}
