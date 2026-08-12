import { readdir, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  validateWorkbookLesson,
  validateWorkbookManifest,
  type WorkbookBlock,
  type WorkbookIdentity,
  type WorkbookLesson,
} from "./contract.js";

export interface WorkbookChapter { id: string; title: string; part: string; partMarkdown: string; partNumber: number; lessonNumber: number; state: "migrated" | "unavailable"; lesson?: WorkbookLesson; }
export interface LoadedWorkbook { workspace: string; identity: WorkbookIdentity; introduction: string; chapters: WorkbookChapter[]; }

/** The workbook document and lesson directories are authored at the repository root. */
const WORKBOOK_DOCUMENT = "workbook.md";
const LESSONS_ROOT = "lessons";

/**
 * Split a Markdown file into its YAML front matter and prose body. Front matter
 * carries only the machine fields the generic renderer needs; the body is prose.
 */
export function parseFrontMatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  const data = parse(match[1]!) as Record<string, unknown> | null;
  return { data: data ?? {}, body: (match[2] ?? "").trim() };
}

async function readMarkdown(path: string): Promise<{ data: Record<string, unknown>; body: string }> {
  return parseFrontMatter(await readFile(path, "utf8"));
}

interface LessonManifestEntry { id?: string; type?: string; required?: boolean; source?: string; }
interface LessonManifest { hero?: string; opening?: string; blocks?: LessonManifestEntry[]; }
interface PartDirectory { id: string; title: string; markdown: string; path: string; }

function assembleBlock(entry: LessonManifestEntry, data: Record<string, unknown>, body: string): WorkbookBlock {
  const base = { id: entry.id ?? "", type: entry.type as WorkbookBlock["type"], title: (data.title as string) ?? "", required: entry.required };
  if (entry.type === "narrative") return { ...base, type: "narrative", markdown: body };
  if (entry.type === "terminal-practice") return {
    ...base, type: "terminal-practice",
    command: (data.command as string) ?? "",
    context: (data.context as string) ?? "",
    expectedObservation: (data.expectedObservation as string) ?? "",
    help: (data.help as Record<string, string>) ?? {},
  };
  if (entry.type === "reflection") return { ...base, type: "reflection", prompt: (data.prompt as string) ?? "" };
  return { ...base, type: "lesson-transition", label: (data.label as string) ?? "", markdown: body };
}

function slugWithoutPrefix(name: string): string { return name.replace(/^\d+-/, ""); }

function titleFromMarkdown(path: string, document: { data: Record<string, unknown>; body: string }): string {
  if (typeof document.data.title === "string" && document.data.title.trim()) return document.data.title;
  const heading = /^#\s+(.+)$/m.exec(document.body)?.[1]?.trim();
  if (heading) return heading;
  throw new Error(`${path} needs a title front-matter field or level-one heading.`);
}

function bodyWithoutTitle(document: { body: string }): string {
  return document.body.replace(/^#\s+.+\r?\n?/, "").trim();
}

async function partDirectories(workspace: string): Promise<PartDirectory[]> {
  const root = resolve(workspace, LESSONS_ROOT);
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(async (entry) => {
    const path = resolve(root, entry.name);
    const partPath = resolve(path, "part.md");
    const document = await readMarkdown(partPath);
    return { id: entry.name, title: titleFromMarkdown(partPath, document), markdown: bodyWithoutTitle(document), path };
  }));
}

async function lessonDirectories(part: PartDirectory): Promise<string[]> {
  const entries = await readdir(part.path, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function lessonTitle(lessonDir: string): Promise<string> {
  const heroPath = resolve(lessonDir, "hero.md");
  return titleFromMarkdown(heroPath, await readMarkdown(heroPath));
}

/** Assemble one lesson from its conventional directory plus its authored Markdown sources. */
export async function loadWorkbookLesson(lessonDir: string, id: string): Promise<WorkbookLesson> {
  const manifest = parse(await readFile(resolve(lessonDir, "lesson.yaml"), "utf8")) as LessonManifest | null;
  if (!manifest || typeof manifest !== "object") throw new Error(`${lessonDir}/lesson.yaml must be an object.`);
  if (!manifest.hero || !manifest.opening) throw new Error(`${lessonDir}/lesson.yaml must reference hero and opening sources.`);
  const hero = await readMarkdown(resolve(lessonDir, manifest.hero));
  const opening = await readMarkdown(resolve(lessonDir, manifest.opening));
  const blocks = await Promise.all((manifest.blocks ?? []).map(async (entry, index) => {
    if (!entry.source) throw new Error(`${lessonDir}/lesson.yaml blocks[${index}] needs a source file.`);
    const { data, body } = await readMarkdown(resolve(lessonDir, entry.source));
    return assembleBlock(entry, data, body);
  }));
  return validateWorkbookLesson({
    id,
    hero: { title: hero.data.title, dek: hero.data.dek, meta: hero.data.meta ?? [] },
    opening: { sectionLabel: opening.data.sectionLabel, heading: opening.data.heading, markdown: opening.body, outcomes: opening.data.outcomes ?? [] },
    blocks,
  });
}

export async function loadWorkbook(target: string): Promise<LoadedWorkbook> {
  const workspace = await realpath(resolve(target));
  const document = await readMarkdown(resolve(workspace, WORKBOOK_DOCUMENT));
  const manifest = validateWorkbookManifest(document.data);
  const introduction = document.body;
  const identity: WorkbookIdentity = { title: manifest.title };
  const parts = await partDirectories(workspace);
  const chapterGroups = await Promise.all(parts.map(async (part, partIndex) => {
    const lessons = await lessonDirectories(part);
    return Promise.all(lessons.map(async (directory, lessonIndex): Promise<WorkbookChapter> => {
      const lessonDir = resolve(part.path, directory);
      const id = `${part.id}/${directory}`;
      const title = await lessonTitle(lessonDir);
      try {
        const lesson = await loadWorkbookLesson(lessonDir, id);
        return { id, title, part: part.title, partMarkdown: part.markdown, partNumber: partIndex + 1, lessonNumber: lessonIndex + 1, state: "migrated", lesson };
      } catch (error: any) {
        if (error?.code === "ENOENT" && error?.path?.endsWith("lesson.yaml")) return { id, title, part: part.title, partMarkdown: part.markdown, partNumber: partIndex + 1, lessonNumber: lessonIndex + 1, state: "unavailable" };
        throw new Error(`Could not load workbook lesson ${id}: ${error instanceof Error ? error.message : "invalid lesson"}`);
      }
    }));
  }));
  return { workspace, identity, introduction, chapters: chapterGroups.flat() };
}
