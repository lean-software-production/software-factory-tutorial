import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { readProgress, type ProgressItem } from "../lesson/load.js";
import { validateWorkbookLesson, type WorkbookLesson } from "./contract.js";

export interface WorkbookChapter { id: string; title: string; part?: string; state: "migrated" | "unavailable"; lesson?: WorkbookLesson; }
export interface LoadedWorkbook { workspace: string; outline: ProgressItem[]; chapters: WorkbookChapter[]; }

/** Workbook lesson prose is reviewable YAML beside the curriculum, not code compiled into the server. */
export async function loadWorkbookLesson(workspace: string, id: string): Promise<WorkbookLesson | undefined> {
  const path = resolve(workspace, "docs/workbook", `${id}.yaml`);
  try { return validateWorkbookLesson(parse(await readFile(path, "utf8"))); }
  catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Could not load workbook lesson ${id} from ${path}: ${error instanceof Error ? error.message : "invalid manifest"}`);
  }
}

export async function loadWorkbook(target: string): Promise<LoadedWorkbook> {
  const workspace = await realpath(resolve(target));
  const ledger = await readFile(resolve(workspace, "docs/specs/README.md"), "utf8");
  const outline = readProgress(ledger);
  const chapters = await Promise.all(outline.filter((item) => item.id !== "orientation").map(async (item) => {
    const lesson = await loadWorkbookLesson(workspace, item.id);
    return { id: item.id, title: item.label, part: item.part, state: lesson ? "migrated" as const : "unavailable" as const, lesson };
  }));
  return { workspace, outline, chapters };
}
