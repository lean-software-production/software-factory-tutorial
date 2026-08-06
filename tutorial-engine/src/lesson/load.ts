import { readFile, realpath, writeFile } from "node:fs/promises";
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

export function ledgerPath(workspace: string): string {
  return resolve(workspace, "docs/specs/README.md");
}

/** A ledger row's status lives in its third cell; `isLessonRow` finds the rows that have one. */
function lessonRowStatus(line: string): string | undefined {
  if (!line.trimStart().startsWith("|")) return undefined;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 3 || !LEDGER_STATUSES.has(cells[2] ?? "")) return undefined;
  return cells[2];
}

export function readProgress(ledger: string): ProgressItem[] {
  const entries: Array<{ id: string; label: string; status: string; part?: string }> = [];
  let part: string | undefined;

  for (const line of ledger.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(Part\s.+?)\s*$/);
    if (heading) { part = heading[1]; continue; }
    const status = lessonRowStatus(line);
    if (status === undefined) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const id = cells[0]?.match(/\[([^\]]+)\]/)?.[1] ?? cells[0] ?? "";
    if (!id) continue;
    entries.push({ id, label: cells[1] ?? "", status, part });
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

/**
 * Mark the lesson the learner is on as finished, which is the first row still
 * `Todo` — the same row `readProgress` calls `current`. Only that cell changes,
 * so a hand-edited ledger keeps its wording, spacing, and link text.
 *
 * Returns the progress after the write, or `undefined` when every lesson is
 * already `Done` and there is nothing left to advance.
 */
export function completeCurrentLesson(ledger: string): { ledger: string; progress: ProgressItem[]; id: string } | undefined {
  const lines = ledger.split(/\r?\n/);
  const index = lines.findIndex((line) => lessonRowStatus(line) === "Todo");
  if (index < 0) return undefined;

  const line = lines[index] ?? "";
  const cells = line.split("|");
  const id = cells[1]?.trim().match(/\[([^\]]+)\]/)?.[1] ?? cells[1]?.trim() ?? "";
  // slice(1, -1) drops the delimiters either side of the row, so the status
  // cell that `lessonRowStatus` reads at index 2 is `cells[3]` here.
  cells[3] = (cells[3] ?? "").replace("Todo", "Done");
  lines[index] = cells.join("|");

  const updated = lines.join("\n");
  return { ledger: updated, progress: readProgress(updated), id };
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

/** Record the current lesson as finished in the workspace's ledger on disk. */
export async function markCurrentLessonDone(workspace: string): Promise<{ progress: ProgressItem[]; id: string } | undefined> {
  const path = ledgerPath(workspace);
  const completed = completeCurrentLesson(await readFile(path, "utf8"));
  if (!completed) return undefined;
  await writeFile(path, completed.ledger, "utf8");
  return { progress: completed.progress, id: completed.id };
}
