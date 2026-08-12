import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readProgress, type ProgressItem } from "../lesson/load.js";
import { lesson001 } from "./lesson-001.js";

export interface WorkbookChapter { id: string; title: string; part?: string; state: "migrated" | "unavailable"; lesson?: typeof lesson001; }
export interface LoadedWorkbook { workspace: string; outline: ProgressItem[]; chapters: WorkbookChapter[]; }

export async function loadWorkbook(target: string): Promise<LoadedWorkbook> {
  const workspace = await realpath(resolve(target));
  const ledger = await readFile(resolve(workspace, "docs/specs/README.md"), "utf8");
  const outline = readProgress(ledger);
  const chapters = outline.filter((item) => item.id !== "orientation").map((item) => ({
    id: item.id,
    title: item.label,
    part: item.part,
    state: item.id === "001" ? "migrated" as const : "unavailable" as const,
    lesson: item.id === "001" ? lesson001 : undefined
  }));
  return { workspace, outline, chapters };
}
