import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { UnsupportedWorkbookSessionError, assertCurrentWorkbookSessionFormatRecord, normalizeWorkbookTimelineRecord, type WorkbookTimelineRecord } from "../../tutorial-engine/src/workbook/timeline.js";

const MAX_TIMELINE_BYTES = 4 * 1024 * 1024;
const MAX_TIMELINE_LINES = 20_000;
const MAX_TIMELINE_LINE_BYTES = 256 * 1024;

/**
 * Reads raw workbook timeline rows for private/deterministic gates only.
 * Do not feed these rows directly to judge prompts or public artifacts; project them first.
 */
export async function readAuthoredWorkbookTimeline(sessionRoot: string): Promise<WorkbookTimelineRecord[]> {
  const root = await realpath(resolve(sessionRoot));
  const eventPath = resolve(root, "workbook/events.jsonl");
  const parent = resolve(eventPath, "..");
  let parentMetadata;
  try { parentMetadata = await lstat(parent); }
  catch (error: any) {
    if (error?.code === "ENOENT") throw unsupportedAuthoredTimeline();
    throw new Error("Unable to read workbook timeline events.");
  }
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) throw new Error("Workbook timeline events parent is not an ordinary directory.");
  const realParent = await realpath(parent);
  if (realParent !== parent || !inside(root, realParent)) throw new Error("Workbook timeline events parent is an alias.");

  let metadata;
  try { metadata = await lstat(eventPath); }
  catch (error: any) { if (error?.code === "ENOENT") throw unsupportedAuthoredTimeline(); throw new Error("Unable to read workbook timeline events."); }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) throw new Error("Workbook timeline events are not a single ordinary file.");
  if (metadata.size > MAX_TIMELINE_BYTES) throw new Error("Workbook timeline events exceed the evaluator read limit.");

  const handle = await open(eventPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) throw new Error("Workbook timeline events changed before read.");
    const buffer = Buffer.alloc(opened.size);
    const read = await handle.read(buffer, 0, opened.size, 0);
    if (read.bytesRead !== opened.size) throw new Error("Workbook timeline events changed during read.");
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, opened.size)).bytesRead !== 0) throw new Error("Workbook timeline events changed during read.");
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) throw new Error("Workbook timeline events changed during read.");
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    while (lines.at(-1) === "") lines.pop();
    if (lines.length === 0) throw unsupportedAuthoredTimeline();
    if (lines.length > MAX_TIMELINE_LINES) throw new Error("Workbook timeline events exceed the evaluator line limit.");
    for (const [index, line] of lines.entries()) {
      if (Buffer.byteLength(line, "utf8") > MAX_TIMELINE_LINE_BYTES) throw new Error(`workbook/events.jsonl:${index + 1}: event line exceeds the evaluator read limit.`);
    }
    let header: unknown;
    try { header = JSON.parse(lines[0]!); }
    catch { throw unsupportedAuthoredTimeline(); }
    assertCurrentWorkbookSessionFormatRecord(header);

    const records: WorkbookTimelineRecord[] = [];
    for (const [index, line] of lines.slice(1).entries()) {
      const lineNumber = index + 2;
      if (line === "") continue;
      try { records.push(normalizeWorkbookTimelineRecord(JSON.parse(line), lineNumber)); }
      catch (error) {
        if (error instanceof UnsupportedWorkbookSessionError) throw error;
        throw new Error(`workbook/events.jsonl:${lineNumber}: invalid timeline event.`);
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

function unsupportedAuthoredTimeline(): UnsupportedWorkbookSessionError {
  try { assertCurrentWorkbookSessionFormatRecord(undefined); }
  catch (error) {
    if (error instanceof UnsupportedWorkbookSessionError) return error;
  }
  return new UnsupportedWorkbookSessionError("missing format version");
}
