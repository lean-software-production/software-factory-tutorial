import { readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { LessonDefinition } from "./contract.js";
import { LessonProgressStore } from "./progress-store.js";

export type ProgressState = "done" | "current" | "upcoming";
export interface ProgressItem { id: string; label: string; state: ProgressState; part?: string; spec?: string; }

export interface LoadedLesson {
  definition: LessonDefinition;
  workspace: string;
  progress: ProgressItem[];
}

function titleFrom(readme: string, workspace: string): string {
  return readme.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(workspace);
}

/**
 * A row is a lesson when its first cell links to a specification, which no
 * header or separator row does. The ledger carries no status: how far one
 * learner has got is held in `factory/`, not in the curriculum.
 */
const LESSON_LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

export function ledgerPath(workspace: string): string {
  return resolve(workspace, "docs/specs/README.md");
}

function lessonRowCells(line: string): string[] | undefined {
  if (!line.trimStart().startsWith("|")) return undefined;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  return LESSON_LINK.test(cells[0] ?? "") ? cells : undefined;
}

/**
 * Turn the ledger's lesson rows into the outline, with `completed` deciding
 * which are done. The first lesson not in `completed` is the one the learner is
 * on, so a gap — lesson 004 finished but 003 somehow not — still leaves 003
 * current rather than skipping it.
 */
export function readProgress(ledger: string, completed: ReadonlySet<string> = new Set()): ProgressItem[] {
  const entries: Array<{ id: string; label: string; part?: string; spec?: string }> = [];
  let part: string | undefined;

  for (const line of ledger.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(Part\s.+?)\s*$/);
    if (heading) { part = heading[1]; continue; }
    const cells = lessonRowCells(line);
    if (!cells) continue;
    const link = cells[0]?.match(LESSON_LINK);
    const id = link?.[1] ?? "";
    if (!id) continue;
    entries.push({ id, label: cells[1] ?? "", part, spec: link?.[2] });
  }

  let foundCurrent = false;
  return [
    { id: "orientation", label: "Orientation", state: "done" as const },
    ...entries.map((entry) => {
      const item = { id: entry.id, label: entry.label, part: entry.part, spec: entry.spec };
      if (completed.has(entry.id)) return { ...item, state: "done" as const };
      if (!foundCurrent) { foundCurrent = true; return { ...item, state: "current" as const }; }
      return { ...item, state: "upcoming" as const };
    })
  ];
}

/** The lesson the learner is on, which is what the tutor is told to open. */
export function currentLesson(progress: readonly ProgressItem[]): ProgressItem | undefined {
  return progress.find((item) => item.state === "current");
}

/** Where the current lesson's specification lives, relative to the workspace. */
export function currentSpecPath(progress: readonly ProgressItem[]): string | undefined {
  const spec = currentLesson(progress)?.spec;
  return spec ? `docs/specs/${spec}` : undefined;
}

/** The outline as it stands on disk: curriculum from the ledger, state from `factory/`. */
export async function loadProgress(workspace: string): Promise<ProgressItem[]> {
  const ledger = await readFile(ledgerPath(workspace), "utf8");
  return readProgress(ledger, await new LessonProgressStore(workspace).read());
}

/** Infer one tutorial from its README and lesson ledger. */
export async function loadLesson(directory: string): Promise<LoadedLesson> {
  const workspace = await realpath(resolve(directory));
  const readme = await readFile(resolve(workspace, "README.md"), "utf8");
  const ledger = await readFile(ledgerPath(workspace), "utf8");
  const definition: LessonDefinition = {
    title: titleFrom(readme, workspace),
    workspace,
    validationCommands: [],
  };
  const completed = await new LessonProgressStore(workspace).read();
  return { definition, workspace, progress: readProgress(ledger, completed) };
}

/**
 * Record the lesson the learner is on as finished.
 *
 * Returns the progress after the write, or `undefined` when every lesson is
 * already finished and there is nothing left to advance.
 */
export async function markCurrentLessonDone(workspace: string): Promise<{ progress: ProgressItem[]; id: string } | undefined> {
  const store = new LessonProgressStore(workspace);
  const ledger = await readFile(ledgerPath(workspace), "utf8");
  const current = currentLesson(readProgress(ledger, await store.read()));
  if (!current) return undefined;
  const completed = await store.add(current.id);
  return { progress: readProgress(ledger, completed), id: current.id };
}
