import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  validateWorkbookLesson,
  validateWorkbookManifest,
  type WorkbookBlock,
  type WorkbookIdentity,
  type WorkbookLesson,
} from "./contract.js";

export interface WorkbookChapter { id: string; title: string; part: string; state: "migrated" | "unavailable"; lesson?: WorkbookLesson; }
export interface LoadedWorkbook { workspace: string; identity: WorkbookIdentity; introduction: string; chapters: WorkbookChapter[]; }

/** The authored curriculum lives at the repository root, beside the code, not compiled into it. */
const WORKBOOK_ROOT = "workbook";

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
interface LessonManifest { id?: string; status?: string; hero?: string; opening?: string; blocks?: LessonManifestEntry[]; }

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

/** Assemble one lesson from its `lesson.yaml` structure plus its authored Markdown sources. */
export async function loadWorkbookLesson(workspace: string, dir: string): Promise<WorkbookLesson> {
  const lessonDir = resolve(workspace, WORKBOOK_ROOT, dir);
  const manifest = parse(await readFile(resolve(lessonDir, "lesson.yaml"), "utf8")) as LessonManifest | null;
  if (!manifest || typeof manifest !== "object") throw new Error(`${dir}/lesson.yaml must be an object.`);
  if (!manifest.hero || !manifest.opening) throw new Error(`${dir}/lesson.yaml must reference hero and opening sources.`);
  const hero = await readMarkdown(resolve(lessonDir, manifest.hero));
  const opening = await readMarkdown(resolve(lessonDir, manifest.opening));
  const blocks = await Promise.all((manifest.blocks ?? []).map(async (entry, index) => {
    if (!entry.source) throw new Error(`${dir}/lesson.yaml blocks[${index}] needs a source file.`);
    const { data, body } = await readMarkdown(resolve(lessonDir, entry.source));
    return assembleBlock(entry, data, body);
  }));
  return validateWorkbookLesson({
    id: manifest.id,
    status: manifest.status,
    hero: { title: hero.data.title, dek: hero.data.dek, meta: hero.data.meta ?? [] },
    opening: { sectionLabel: opening.data.sectionLabel, heading: opening.data.heading, markdown: opening.body, outcomes: opening.data.outcomes ?? [] },
    blocks,
  });
}

export async function loadWorkbook(target: string): Promise<LoadedWorkbook> {
  const workspace = await realpath(resolve(target));
  const root = resolve(workspace, WORKBOOK_ROOT);
  const manifest = validateWorkbookManifest(parse(await readFile(resolve(root, "workbook.yaml"), "utf8")));
  const introduction = (await readFile(resolve(root, manifest.introduction), "utf8")).trim();
  const identity: WorkbookIdentity = { title: manifest.title, brand: manifest.brand, tocTitle: manifest.tocTitle, draftNotice: manifest.draftNotice };
  const chapters = await Promise.all(manifest.parts.flatMap((part) => part.lessons.map(async (railLesson): Promise<WorkbookChapter> => {
    if (!railLesson.dir) return { id: railLesson.id, title: railLesson.title, part: part.name, state: "unavailable" };
    try {
      const lesson = await loadWorkbookLesson(workspace, railLesson.dir);
      return { id: railLesson.id, title: railLesson.title, part: part.name, state: "migrated", lesson };
    } catch (error) {
      throw new Error(`Could not load migrated workbook lesson ${railLesson.id} from ${railLesson.dir}: ${error instanceof Error ? error.message : "invalid lesson"}`);
    }
  })));
  return { workspace, identity, introduction, chapters };
}
