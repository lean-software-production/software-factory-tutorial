import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import {
  validateBlockFrontMatter,
  validateLessonFrontMatter,
  validatePartManifest,
  validateWorkbookLesson,
  validateWorkbookManifest,
  WORKBOOK_ID_PATTERN,
  type WorkbookBlock,
  type EditorPracticeBlock,
  type ReflectionBlock,
  type TerminalPracticeBlock,
  type WorkbookIdentity,
  type WorkbookLesson,
  type WorkbookManifest,
  type WorkbookPartManifest,
} from "./contract.js";
import {
  buildLessonCatalog,
  resolveLessonReferences,
  type LessonReferenceTarget,
  type ReferenceContext,
} from "./lesson-links.js";

export interface WorkbookChapter {
  id: string;
  title: string;
  partId?: string;
  part?: string;
  partMarkdown?: string;
  partNumber?: number;
  lessonNumber: number;
  lesson: WorkbookLesson;
}
export interface LoadedWorkbook { workspace: string; identity: WorkbookIdentity; introduction: string; chapters: WorkbookChapter[]; }

/** The workbook document and lesson directories are authored relative to a workbook target. */
const WORKBOOK_DOCUMENT = "workbook.md";
const LESSONS_ROOT = "lessons";
const PARTS_ROOT = "parts";
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
  if (body.slice(0, start).trim()) throw new Error(`${location} has content before the ${label} title heading.`);
  const end = start + match[0].length;
  return { title, body: body.slice(end).trim() };
}

/** The first paragraph after a lesson's H1 is its compact dek; any remaining Markdown is its full introduction. */
function extractLessonBody(body: string, location: string): { dek: string; introduction: string } {
  const trimmed = body.trim();
  if (!trimmed) throw new Error(`${location} needs a dek: one paragraph of prose after its title heading.`);
  const match = /^([\s\S]+?)(?:\r?\n[ \t]*\r?\n|$)/.exec(trimmed)!;
  const dek = match[1]!.trim();
  const introduction = trimmed.slice(match[0].length).trim();
  return { dek, introduction };
}

async function readTitledDocument(path: string, level: 1 | 2): Promise<{ data: Record<string, unknown>; title: string; body: string }> {
  const { data, body } = await readMarkdown(path);
  const { title, body: rest } = extractHeading(body, level, path);
  return { data, title, body: rest };
}

interface LoadedPart { id: string; title: string; markdown: string; path: string; }
interface FlatLessonDirectory { id: string; path: string; }

function compareWorkbookIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

async function directoryEntries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
}

async function hasFile(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

function assertWorkbookId(id: string, location: string): void {
  if (!WORKBOOK_ID_PATTERN.test(id)) throw new Error(`${location}: malformed id "${id}"; use lowercase hyphenated ids.`);
}

async function flatLessonDirectories(workspace: string): Promise<FlatLessonDirectory[]> {
  const root = resolve(workspace, LESSONS_ROOT);
  const entries = await directoryEntries(root);
  const directories: FlatLessonDirectory[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => compareWorkbookIds(a.name, b.name))) {
    const lessonDir = resolve(root, entry.name);
    if (!(await hasFile(resolve(lessonDir, LESSON_DOCUMENT)))) continue;
    assertWorkbookId(entry.name, resolve(root, entry.name));
    directories.push({ id: entry.name, path: lessonDir });
  }
  return directories;
}

async function readPartDocument(workspace: string, partId: string): Promise<LoadedPart> {
  assertWorkbookId(partId, resolve(workspace, PARTS_ROOT, `${partId}.md`));
  const partPath = resolve(workspace, PARTS_ROOT, `${partId}.md`);
  const { data, title, body } = await readTitledDocument(partPath, 1);
  validatePartManifest(data, partPath);
  return { id: partId, title, markdown: body, path: partPath };
}

function validateFlatParts(manifestParts: readonly WorkbookPartManifest[], lessonsOnDisk: readonly FlatLessonDirectory[], workbookPath: string): void {
  const diskIds = new Set(lessonsOnDisk.map((lesson) => lesson.id));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknown = new Set<string>();
  for (const part of manifestParts) {
    for (const lessonId of part.lessons) {
      if (seen.has(lessonId)) duplicates.add(lessonId);
      seen.add(lessonId);
      if (!diskIds.has(lessonId)) unknown.add(lessonId);
    }
  }
  const omitted = [...diskIds].filter((lessonId) => !seen.has(lessonId)).sort(compareWorkbookIds);
  const errors: string[] = [];
  if (unknown.size) errors.push(`${workbookPath}: parts lists unknown lesson id(s): ${[...unknown].sort(compareWorkbookIds).join(", ")}`);
  if (duplicates.size) errors.push(`${workbookPath}: parts duplicates lesson id(s): ${[...duplicates].sort(compareWorkbookIds).join(", ")}`);
  if (omitted.length) errors.push(`${workbookPath}: parts omits lesson id(s) present on disk: ${omitted.join(", ")}`);
  if (errors.length) throw new Error(errors.join("\n"));
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
  if (front.type === "terminal-practice") return { ...base, type: "terminal-practice", outcome: front.outcome!, tutor: front.tutor! };
  if (front.type === "editor-practice") return { ...base, type: "editor-practice", outcome: front.outcome!, path: front.path!, tutor: front.tutor! };
  if (front.type === "reflection") return { ...base, type: "reflection", outcome: front.outcome!, tutor: front.tutor! };
  return { ...base, type: "narrative" };
}

/** Interactive blocks deliver a learning outcome; the lesson's outcomes are their ordered list. */
function isInteractiveBlock(block: WorkbookBlock): block is TerminalPracticeBlock | EditorPracticeBlock | ReflectionBlock {
  return block.type !== "narrative";
}

/** Assemble one lesson from its conventional directory and its lesson.md manifest. */
export async function loadWorkbookLesson(lessonDir: string, id: string): Promise<WorkbookLesson> {
  const lessonPath = resolve(lessonDir, LESSON_DOCUMENT);
  const { data, body } = await readMarkdown(lessonPath);
  const front = validateLessonFrontMatter(data, lessonPath);
  const { title, body: afterTitle } = extractHeading(body, 1, lessonPath);
  const { dek, introduction } = extractLessonBody(afterTitle, lessonPath);

  const blocksDir = resolve(lessonDir, BLOCKS_DIR);
  let blockFiles: string[] = [];
  try { blockFiles = (await readdir(blocksDir)).filter((name) => name.endsWith(".md")); }
  catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const idsOnDisk = new Set(blockFiles.map((name) => basename(name, ".md")));
  const listed = new Set(front.blocks);
  const unlisted = [...idsOnDisk].filter((blockId) => !listed.has(blockId)).sort();
  if (unlisted.length) throw new Error(`${lessonPath}: blocks/ contains file(s) not listed in front matter blocks: ${unlisted.join(", ")}.`);

  const blocks = await Promise.all(front.blocks.map((blockId) => loadWorkbookBlock(lessonDir, blockId, lessonPath)));
  const outcomes = blocks.filter(isInteractiveBlock).map((block) => block.outcome);
  return validateWorkbookLesson({ id, title, dek, introduction, durationMinutes: front.durationMinutes, outcomes, blocks }, lessonPath);
}

interface ChapterDraft extends Omit<WorkbookChapter, "lessonNumber"> {
  partIndex?: number;
  lessonDir: string;
  lessonPath: string;
}

async function draftForLesson(id: string, lessonDir: string, part: LoadedPart | undefined, partIndex: number | undefined): Promise<ChapterDraft> {
  const lesson = await loadWorkbookLesson(lessonDir, id);
  return {
    id,
    title: lesson.title,
    partId: part?.id,
    part: part?.title,
    partMarkdown: part?.markdown,
    partNumber: partIndex === undefined ? undefined : partIndex + 1,
    lesson,
    partIndex,
    lessonDir,
    lessonPath: resolve(lessonDir, LESSON_DOCUMENT),
  };
}

async function flatChapterGroups(workspace: string, manifest: WorkbookManifest, workbookPath: string): Promise<{ parts: LoadedPart[]; groups: ChapterDraft[][] }> {
  const lessons = await flatLessonDirectories(workspace);
  if (!manifest.parts) {
    return { parts: [], groups: lessons.length > 0 ? [await Promise.all(lessons.map((lesson) => draftForLesson(lesson.id, lesson.path, undefined, undefined)))] : [] };
  }

  validateFlatParts(manifest.parts, lessons, workbookPath);
  const lessonById = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const parts = await Promise.all(manifest.parts.map((part) => readPartDocument(workspace, part.id)));
  const groups = await Promise.all(manifest.parts.map(async (part, partIndex) => {
    const loadedPart = parts[partIndex]!;
    return Promise.all(part.lessons.map((lessonId) => {
      const lesson = lessonById.get(lessonId)!;
      return draftForLesson(lesson.id, lesson.path, loadedPart, partIndex);
    }));
  }));
  return { parts, groups };
}

/**
 * Load every authored document, then resolve every canonical `[[lesson:...]]`
 * reference in workbook, part, lesson, and block prose to standard Markdown.
 * References are only resolvable once every chapter has been discovered and
 * globally numbered, so `loadWorkbookLesson()`
 * stays raw and standalone: resolution happens here, and only here, against a
 * catalog built from the final chapter order.
 */
export async function loadWorkbook(target: string): Promise<LoadedWorkbook> {
  const workspace = await realpath(resolve(target));
  const workbookPath = resolve(workspace, WORKBOOK_DOCUMENT);
  const { data, title, body } = await readTitledDocument(workbookPath, 1);
  const manifest = validateWorkbookManifest(data, workbookPath);
  const identity: WorkbookIdentity = { title };
  const { parts, groups: chapterGroups } = await flatChapterGroups(workspace, manifest, workbookPath);
  // Lesson numbers are a single global sequence across parts, in directory order,
  // rather than resetting at each part boundary.
  const drafts = chapterGroups.flat().map((chapter, index) => ({ ...chapter, lessonNumber: index + 1 }));

  const catalogEntries: LessonReferenceTarget[] = drafts.map((chapter) => ({
    id: chapter.id,
    lessonNumber: chapter.lessonNumber,
    title: chapter.title,
  }));
  const catalog = buildLessonCatalog(catalogEntries);

  // workbook.md may not reference any lesson.
  const introduction = resolveLessonReferences(body, catalog, { kind: "workbook", path: workbookPath });

  // A part's earlier-reference boundary is the global number of its own first lesson.
  let nextLessonNumber = 1;
  const partFirstLessonNumbers = chapterGroups.map((group) => {
    const first = nextLessonNumber;
    nextLessonNumber += group.length;
    return first;
  });
  const resolvedPartMarkdown = parts.map((part, index) => resolveLessonReferences(
    part.markdown,
    catalog,
    { kind: "part", path: part.path, firstLessonNumber: partFirstLessonNumbers[index]! },
  ));

  const chapters: WorkbookChapter[] = drafts.map((chapter) => {
    const context: ReferenceContext = { kind: "lesson", path: chapter.lessonPath, lessonId: chapter.id, lessonNumber: chapter.lessonNumber };
    const dek = resolveLessonReferences(chapter.lesson.dek, catalog, context);
    const introduction = resolveLessonReferences(chapter.lesson.introduction, catalog, context);
    const blocks = chapter.lesson.blocks.map((block) => {
      const blockPath = resolve(chapter.lessonDir, BLOCKS_DIR, `${block.id}.md`);
      return { ...block, markdown: resolveLessonReferences(block.markdown, catalog, { ...context, path: blockPath }) };
    });
    const lesson = validateWorkbookLesson({ ...chapter.lesson, dek, introduction, blocks }, chapter.lessonPath);
    return {
      id: chapter.id,
      title: chapter.title,
      partId: chapter.partId,
      part: chapter.part,
      partMarkdown: chapter.partIndex === undefined ? undefined : resolvedPartMarkdown[chapter.partIndex]!,
      partNumber: chapter.partNumber,
      lessonNumber: chapter.lessonNumber,
      lesson,
    };
  });

  return { workspace, identity, introduction, chapters };
}
