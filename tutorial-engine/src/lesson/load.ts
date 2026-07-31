import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { LessonDefinition } from "./contract.js";

export type ProgressState = "done" | "current" | "upcoming";
export interface ProgressItem { id: string; label: string; state: ProgressState; }

export interface LoadedLesson {
  definition: LessonDefinition;
  workspace: string;
  progress: ProgressItem[];
}

function titleFrom(readme: string, workspace: string): string {
  return readme.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(workspace);
}

function readProgress(ledger: string): ProgressItem[] {
  const entries = ledger.split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3 && !cells[0]?.startsWith("---") && cells[0] !== "Iteration")
    .map((cells) => {
      const match = cells[0]?.match(/\[([^\]]+)\]/);
      return { id: match?.[1] ?? cells[0] ?? "", label: cells[1] ?? "", status: cells[2] ?? "Todo" };
    })
    .filter((entry) => entry.id);

  let foundCurrent = false;
  return [
    { id: "orientation", label: "Orientation", state: "done" as const },
    ...entries.map((entry) => {
      if (entry.status === "Done") return { id: entry.id, label: entry.label, state: "done" as const };
      if (!foundCurrent) {
        foundCurrent = true;
        return { id: entry.id, label: entry.label, state: "current" as const };
      }
      return { id: entry.id, label: entry.label, state: "upcoming" as const };
    })
  ];
}

/** Infer one tutorial from its README and iteration ledger. */
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
