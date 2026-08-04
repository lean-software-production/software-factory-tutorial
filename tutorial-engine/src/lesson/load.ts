import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { LessonDefinition } from "./contract.js";

export type ProgressState = "done" | "current" | "upcoming";
export interface ProgressItem { id: string; label: string; state: ProgressState; part?: string; }

export interface LoadedLesson {
  definition: LessonDefinition;
  workspace: string;
  progress: ProgressItem[];
}

function titleFrom(readme: string, workspace: string): string {
  return readme.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(workspace);
}

/** A row is a lesson when its status cell holds a status, which no header row does. */
const LEDGER_STATUSES = new Set(["Todo", "Done"]);

function readProgress(ledger: string): ProgressItem[] {
  const entries: Array<{ id: string; label: string; status: string; part?: string }> = [];
  let part: string | undefined;

  for (const line of ledger.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(Part\s.+?)\s*$/);
    if (heading) { part = heading[1]; continue; }
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3 || !LEDGER_STATUSES.has(cells[2] ?? "")) continue;
    const id = cells[0]?.match(/\[([^\]]+)\]/)?.[1] ?? cells[0] ?? "";
    if (!id) continue;
    entries.push({ id, label: cells[1] ?? "", status: cells[2] ?? "Todo", part });
  }

  let foundCurrent = false;
  return [
    { id: "orientation", label: "Orientation", state: "done" as const },
    ...entries.map((entry) => {
      const item = { id: entry.id, label: entry.label, part: entry.part };
      if (entry.status === "Done") return { ...item, state: "done" as const };
      if (!foundCurrent) { foundCurrent = true; return { ...item, state: "current" as const }; }
      return { ...item, state: "upcoming" as const };
    })
  ];
}

/** Infer one tutorial from its README and lesson ledger. */
export async function loadLesson(directory: string): Promise<LoadedLesson> {
  const workspace = await realpath(resolve(directory));
  const readme = await readFile(resolve(workspace, "README.md"), "utf8");
  const ledger = await readFile(resolve(workspace, "docs/specs/README.md"), "utf8");
  const definition: LessonDefinition = {
    title: titleFrom(readme, workspace),
    workspace,
    validationCommands: [],
  };
  return { definition, workspace, progress: readProgress(ledger) };
}
