import { isAbsolute } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkspaceBoundary } from "./workspace-boundary.js";

export const TUTOR_LIST_MAX_ENTRIES = 100;
export const TUTOR_LIST_MAX_OFFSET = 10_000;
export const TUTOR_LIST_MAX_OUTPUT_CHARS = 12_000;
export const TUTOR_READ_MAX_BYTES = 32_000;
export const TUTOR_READ_MAX_OFFSET = 5_000_000;
export const TUTOR_READ_MAX_FILE_BYTES = 1_000_000;
export const TUTOR_PATH_MAX_LENGTH = 400;

const RESERVED_TOP_LEVEL_NAMES = new Set([".git", ".tutorial"]);

type SafeResult = { content: [{ type: "text"; text: string }]; details: Record<string, unknown> };
type EntryKind = "directory" | "file" | "symlink" | "other";

function textResult(text: string, details: Record<string, unknown>): SafeResult {
  return { content: [{ type: "text", text }], details };
}

function safeError(message: string, extra: Record<string, unknown> = {}): SafeResult {
  return textResult(`Rejected: ${message}`, { ok: false, error: message, ...extra });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(raw: unknown, { required }: { required: boolean }): { ok: true; path: string } | { ok: false; message: string } {
  if (raw === undefined && !required) return { ok: true, path: "." };
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, message: "A workspace-relative path is required." };
  if (raw.length > TUTOR_PATH_MAX_LENGTH) return { ok: false, message: `Path is too long; maximum is ${TUTOR_PATH_MAX_LENGTH} characters.` };
  if (raw.includes("\0")) return { ok: false, message: "Path contains an invalid character." };
  if (isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\")) return { ok: false, message: "Absolute paths are not allowed; use a workspace-relative path." };
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.includes("..")) return { ok: false, message: "Path is outside the active workspace." };
  if (parts[0] && RESERVED_TOP_LEVEL_NAMES.has(parts[0].toLowerCase())) return { ok: false, message: "Reserved session state paths are not available." };
  return { ok: true, path: parts.length === 0 ? "." : parts.join("/") };
}

function integerParam(raw: unknown, name: string, { defaultValue, min, max }: { defaultValue: number; min: number; max: number }): { ok: true; value: number } | { ok: false; message: string } {
  const value = raw === undefined ? defaultValue : raw;
  if (!Number.isInteger(value)) return { ok: false, message: `${name} must be an integer.` };
  const numeric = value as number;
  if (numeric < min || numeric > max) return { ok: false, message: `${name} must be between ${min} and ${max}.` };
  return { ok: true, value: numeric };
}

function codepointSort(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function childPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function quoteMetadata(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029) escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else escaped += character;
  }
  return `"${escaped}"`;
}

function visibleName(name: string): boolean {
  return !RESERVED_TOP_LEVEL_NAMES.has(name.toLowerCase());
}

function kindFor(info: Awaited<ReturnType<WorkspaceBoundary["stat"]>>): EntryKind {
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  if (info.isSymbolicLink()) return "symlink";
  return "other";
}

function formatEntry(entry: { name: string; kind: EntryKind; size?: number }): string {
  if (entry.kind === "directory") return `- ${quoteMetadata(`${entry.name}/`)} (directory)`;
  if (entry.kind === "file") return `- ${quoteMetadata(entry.name)} (file, ${entry.size ?? 0} bytes)`;
  return `- ${quoteMetadata(entry.name)} (${entry.kind})`;
}

function boundedListText(header: string, lines: string[], truncationLine: string | undefined): string {
  const output: string[] = [header];
  let length = header.length + 1;
  for (const line of lines) {
    const additional = line.length + 1;
    if (length + additional > TUTOR_LIST_MAX_OUTPUT_CHARS) {
      output.push("[TRUNCATED: output limit reached; call list_files with a later offset]");
      return output.join("\n");
    }
    output.push(line);
    length += additional;
  }
  if (truncationLine) output.push(truncationLine);
  return output.join("\n");
}

async function listFiles(boundary: WorkspaceBoundary, params: unknown): Promise<SafeResult> {
  if (!isRecord(params)) return safeError("Parameters must be an object.");
  const path = normalizePath(params.path, { required: false });
  if (!path.ok) return safeError(path.message);
  const offset = integerParam(params.offset, "offset", { defaultValue: 0, min: 0, max: TUTOR_LIST_MAX_OFFSET });
  if (!offset.ok) return safeError(offset.message);
  const limit = integerParam(params.limit, "limit", { defaultValue: TUTOR_LIST_MAX_ENTRIES, min: 1, max: TUTOR_LIST_MAX_ENTRIES });
  if (!limit.ok) return safeError(limit.message);

  try {
    const directoryInfo = await boundary.stat(path.path);
    if (!directoryInfo.isDirectory()) return safeError("Path is not a directory.", { path: quoteMetadata(path.path) });
    const names = (await boundary.readdir(path.path)).filter(visibleName).sort(codepointSort);
    const selectedNames = names.slice(offset.value, offset.value + limit.value);
    const entries = [] as Array<{ name: string; kind: EntryKind; size?: number }>;
    for (const name of selectedNames) {
      const childInfo = await boundary.stat(childPath(path.path, name));
      const kind = kindFor(childInfo);
      entries.push({ name, kind, ...(kind === "file" ? { size: childInfo.size } : {}) });
    }
    const nextOffset = offset.value + entries.length;
    const truncated = nextOffset < names.length;
    const remaining = Math.max(0, names.length - nextOffset);
    const shownRange = entries.length === 0 ? "0-0" : `${offset.value + 1}-${nextOffset}`;
    const header = `Listing ${quoteMetadata(path.path)} (showing ${shownRange} of ${names.length} entries):`;
    const truncationLine = truncated ? `[TRUNCATED: ${remaining} more entries; call list_files with offset ${nextOffset}]` : undefined;
    return textResult(boundedListText(header, entries.map(formatEntry), truncationLine), {
      ok: true,
      path: quoteMetadata(path.path),
      offset: offset.value,
      limit: limit.value,
      totalEntries: names.length,
      entries: entries.map((entry) => ({ name: quoteMetadata(entry.kind === "directory" ? `${entry.name}/` : entry.name), kind: entry.kind, ...(entry.kind === "file" ? { size: entry.size } : {}) })),
      truncated,
      ...(truncated ? { nextOffset } : {})
    });
  } catch {
    return safeError("Path is outside the active workspace or is not readable.");
  }
}

async function readWorkspaceFile(boundary: WorkspaceBoundary, params: unknown): Promise<SafeResult> {
  if (!isRecord(params)) return safeError("Parameters must be an object.");
  const path = normalizePath(params.path, { required: true });
  if (!path.ok) return safeError(path.message);
  const offset = integerParam(params.offset, "offset", { defaultValue: 0, min: 0, max: TUTOR_READ_MAX_OFFSET });
  if (!offset.ok) return safeError(offset.message);
  const limit = integerParam(params.limit, "limit", { defaultValue: TUTOR_READ_MAX_BYTES, min: 1, max: TUTOR_READ_MAX_BYTES });
  if (!limit.ok) return safeError(limit.message);

  try {
    const info = await boundary.stat(path.path);
    if (!info.isFile()) return safeError("Path is not a regular file.", { path: quoteMetadata(path.path) });
    if (info.size > TUTOR_READ_MAX_FILE_BYTES) return safeError(`File is too large to read safely; maximum is ${TUTOR_READ_MAX_FILE_BYTES} bytes.`, { path: quoteMetadata(path.path), size: info.size });
    const buffer = await boundary.readFile(path.path);
    const start = Math.min(offset.value, buffer.length);
    const end = Math.min(buffer.length, start + limit.value);
    const chunk = buffer.subarray(start, end).toString("utf8");
    const truncated = end < buffer.length;
    const remaining = Math.max(0, buffer.length - end);
    const body = [`File ${quoteMetadata(path.path)} (bytes ${start}-${end} of ${buffer.length}):`, chunk];
    if (truncated) body.push(`[TRUNCATED: ${remaining} bytes remain; call read_file with offset ${end}]`);
    return textResult(body.join("\n"), {
      ok: true,
      path: quoteMetadata(path.path),
      offset: start,
      limit: limit.value,
      size: buffer.length,
      bytesRead: end - start,
      truncated,
      ...(truncated ? { nextOffset: end } : {})
    });
  } catch {
    return safeError("Path is outside the active workspace or is not readable.");
  }
}

export async function createTutorWorkspaceTools(workspaceRoot: string): Promise<ToolDefinition<any, any, any>[]> {
  const boundary = await WorkspaceBoundary.create(workspaceRoot);
  const list = defineTool({
    name: "list_files",
    label: "List workspace files",
    description: "List files in the active live lesson workspace. Read-only, workspace-relative paths only. Results are sorted and bounded.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ minLength: 1, maxLength: TUTOR_PATH_MAX_LENGTH, description: "Workspace-relative directory path. Defaults to the workspace root." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: TUTOR_LIST_MAX_OFFSET, description: "Zero-based listing offset. Defaults to 0." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TUTOR_LIST_MAX_ENTRIES, description: `Maximum entries to return. Defaults to ${TUTOR_LIST_MAX_ENTRIES}.` }))
    }, { additionalProperties: false }),
    async execute(_id, params) { return listFiles(boundary, params); }
  });
  const read = defineTool({
    name: "read_file",
    label: "Read workspace file",
    description: "Read a bounded byte range from one file in the active live lesson workspace. Read-only, workspace-relative paths only.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: TUTOR_PATH_MAX_LENGTH, description: "Workspace-relative file path." }),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: TUTOR_READ_MAX_OFFSET, description: "Zero-based byte offset. Defaults to 0." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TUTOR_READ_MAX_BYTES, description: `Maximum bytes to return. Defaults to ${TUTOR_READ_MAX_BYTES}.` }))
    }, { additionalProperties: false }),
    async execute(_id, params) { return readWorkspaceFile(boundary, params); }
  });
  return [list, read];
}
