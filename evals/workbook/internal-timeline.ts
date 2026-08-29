import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeWorkbookTimelineRecord, type WorkbookTimelineRecord } from "../../tutorial-engine/src/workbook/timeline.js";

const MAX_TIMELINE_BYTES = 4 * 1024 * 1024;
const MAX_TIMELINE_LINES = 20_000;
const MAX_TIMELINE_LINE_BYTES = 256 * 1024;

/**
 * Reads raw workbook timeline rows for private/deterministic gates only.
 * Do not feed these rows directly to judge prompts or public artifacts; project them first.
 */
export async function readAuthoredWorkbookTimeline(sessionRoot: string): Promise<WorkbookTimelineRecord[]> {
  const eventPath = resolve(sessionRoot, "workbook/events.jsonl");
  let metadata;
  try { metadata = await lstat(eventPath); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw new Error("Unable to read workbook timeline events."); }
  if (!metadata.isFile()) throw new Error("Workbook timeline events are not an ordinary file.");
  if (metadata.size > MAX_TIMELINE_BYTES) throw new Error("Workbook timeline events exceed the evaluator read limit.");
  let text: string;
  try { text = await readFile(eventPath, "utf8"); }
  catch { throw new Error("Unable to read workbook timeline events."); }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length > MAX_TIMELINE_LINES) throw new Error("Workbook timeline events exceed the evaluator line limit.");
  return lines.map((line, index) => {
    if (Buffer.byteLength(line, "utf8") > MAX_TIMELINE_LINE_BYTES) throw new Error(`workbook/events.jsonl:${index + 1}: event line exceeds the evaluator read limit.`);
    try { return normalizeWorkbookTimelineRecord(JSON.parse(line), index + 1); }
    catch { throw new Error(`workbook/events.jsonl:${index + 1}: invalid timeline event.`); }
  });
}
