import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import {
  validateBlockFrontMatter,
  validateLessonFrontMatter,
  validatePartManifest,
  validateWorkbookLesson,
  validateWorkbookManifest,
  type WorkbookBlock,
  type WorkbookIdentity,
  type WorkbookLesson,
} from "./contract.js";

export interface WorkbookChapter {
  id: string;
  title: string;
  part: string;
  partMarkdown: string;
  partNumber: number;
  lessonNumber: number;
  lesson: WorkbookLesson;
}
export interface LoadedWorkbook { workspace: string; identity: WorkbookIdentity; introduction: string; chapters: WorkbookChapter[]; }

/** The workbook document and lesson directories are authored at the repository root. */
const WORKBOOK_DOCUMENT = "workbook.md";
const LESSONS_ROOT = "lessons";
const PART_DOCUMENT = "part.md";
const LESSON_DOCUMENT = "lesson.md";
const BLOCKS_DIR = "blocks";

/**
 * Split a Markdown file into its YAML front matter and prose body. Every
 * authored document requires a front-matter block, delimited by `---` lines;
 * an empty map is valid when the document has no structured fields.
 */
export function parseFrontMatter(text: string, location = "document"): { data: Record<string, unknown>; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error(`${location} needs YAML front matter delimited by --- lines, even if empty (---\\n---).`);
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex === -1) throw new Error(`${location} front matter is missing its closing --- line.`);
  const data = parse(lines.slice(1, closingIndex).join("\n")) as Record<string, unknown> | null;
  if (data !== null && typeof data !== "object") throw new Error(`${location}: front matter must be a YAML mapping.`);
  return { data: data ?? {}, body: lines.slice(closingIndex + 1).join("\n").trim() };
}

async function readMarkdown(path: string): Promise<{ data: Record<string, unknown>; body: string }> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`${path} is missing.`);
    throw error;
  }
  return parseFrontMatter(text, path);
}

/**
 * Extract the document's single title heading at the given level (1 for H1,
 * 2 for H2) and return the remaining body with that heading line removed.
 * Absent, duplicate, or wrong-level headings are location-specific errors.
 */
function extractHeading(body: string, level: 1 | 2, location: string): { title: string; body: string } {
  const marker = "#".repeat(level);
  const label = level === 1 ? "H1" : "H2";
  const pattern = new RegExp(`^${marker}(?!#)[ \\t]+(.+?)[ \\t]*$`, "gm");
  const matches = [...body.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`${location} must have exactly one ${label} title heading ("${marker} Title").`);
  if (matches.length > 1) throw new Error(`${location} must have exactly one ${label} title heading; found ${matches.length}.`);
  const match = matches[0]!;
  const title = match[1]!.trim();
  if (!title) throw new Error(`${location} has an empty ${label} title heading.`);
  const start = match.index ?? 0;
  const end = start + match[0].length;
  return { title, body: (body.slice(0, start) + body.slice(end)).trim() };
}

/** The first paragraph after a lesson's H1 is its dek; a lesson has no other authored content. */
function extractDek(body: string, location: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error(`${location} needs a dek: one paragraph of prose after its title heading.`);
  const match = /^([\s\S]+?)(?:\r?\n[ \t]*\r?\n|$)/.exec(trimmed)!;
  const dek = match[1]!.trim();
  const rest = trimmed.slice(match[0].length).trim();
  if (rest) throw new Error(`${location} may only contain a title heading and a dek paragraph; found extra content after the dek.`);
  return dek;
}

async function readTitledDocument(path: string, level: 1 | 2): Promise<{ data: Record<string, unknown>; title: string; body: string }> {
  const { data, body } = await readMarkdown(path);
  const { title, body: rest } = extractHeading(body, level, path);
  return { data, title, body: rest };
}

interface PartDirectory { id: string; title: string; markdown: string; path: string; }

async function partDirectories(workspace: string): Promise<PartDirectory[]> {
  const root = resolve(workspace, LESSONS_ROOT);
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return Promise.all(dirs.map(async (entry) => {
    const path = resolve(root, entry.name);
    const partPath = resolve(path, PART_DOCUMENT);
    const { data, title, body } = await readTitledDocument(partPath, 1);
    validatePartManifest(data, partPath);
    return { id: entry.name, title, markdown: body, path };
  }));
}

async function lessonDirectories(part: PartDirectory): Promise<string[]> {
  const entries = await readdir(part.path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** A block id resolves to blocks/<id>.md by convention; the filename supplies its id. */
async function loadWorkbookBlock(lessonDir: string, blockId: string, lessonPath: string): Promise<WorkbookBlock> {
  const path = resolve(lessonDir, BLOCKS_DIR, `${blockId}.md`);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`${lessonPath} lists block "${blockId}", but ${path} is missing.`);
    throw error;
  }
  const { data, body } = parseFrontMatter(text, path);
  const front = validateBlockFrontMatter(data, path);
  const { title, body: markdown } = extractHeading(body, 2, path);
  const base = { id: blockId, title, markdown };
  if (front.type === "terminal-practice") return { ...base, type: "terminal-practice", tutor: front.tutor! };
  if (front.type === "reflection") return { ...base, type: "reflection", tutor: front.tutor! };
  if (front.type === "narrative") return { ...base, type: "narrative" };
  return { ...base, type: "lesson-transition" };
}

/** Assemble one lesson from its conventional directory and its lesson.md manifest. */
export async function loadWorkbookLesson(lessonDir: string, id: string): Promise<WorkbookLesson> {
  const lessonPath = resolve(lessonDir, LESSON_DOCUMENT);
  const { data, body } = await readMarkdown(lessonPath);
  const front = validateLessonFrontMatter(data, lessonPath);
  const { title, body: afterTitle } = extractHeading(body, 1, lessonPath);
  const dek = extractDek(afterTitle, lessonPath);

  const blocksDir = resolve(lessonDir, BLOCKS_DIR);
  let blockFiles: string[] = [];
  try { blockFiles = (await readdir(blocksDir)).filter((name) => name.endsWith(".md")); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const idsOnDisk = new Set(blockFiles.map((name) => basename(name, ".md")));
  const listed = new Set(front.blocks);
  const unlisted = [...idsOnDisk].filter((blockId) => !listed.has(blockId)).sort();
  if (unlisted.length) throw new Error(`${lessonPath}: blocks/ contains file(s) not listed in front matter blocks: ${unlisted.join(", ")}.`);

  const blocks = await Promise.all(front.blocks.map((blockId) => loadWorkbookBlock(lessonDir, blockId, lessonPath)));
  return validateWorkbookLesson({ id, title, dek, durationMinutes: front.durationMinutes, outcomes: front.outcomes, blocks }, lessonPath);
}

export async function loadWorkbook(target: string): Promise<LoadedWorkbook> {
  const workspace = await realpath(resolve(target));
  const workbookPath = resolve(workspace, WORKBOOK_DOCUMENT);
  const { data, title, body } = await readTitledDocument(workbookPath, 1);
  validateWorkbookManifest(data, workbookPath);
  const identity: WorkbookIdentity = { title };
  const introduction = body;
  const parts = await partDirectories(workspace);
  const chapterGroups = await Promise.all(parts.map(async (part, partIndex) => {
    const lessons = await lessonDirectories(part);
    return Promise.all(lessons.map(async (directory, lessonIndex): Promise<WorkbookChapter> => {
      const lessonDir = resolve(part.path, directory);
      const id = `${part.id}/${directory}`;
      const lesson = await loadWorkbookLesson(lessonDir, id);
      return { id, title: lesson.title, part: part.title, partMarkdown: part.markdown, partNumber: partIndex + 1, lessonNumber: lessonIndex + 1, lesson };
    }));
  }));
  return { workspace, identity, introduction, chapters: chapterGroups.flat() };
}
