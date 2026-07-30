import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createJiti } from "jiti";
import { isLessonDefinition, type LessonDefinition } from "./contract.js";

export type ProgressState = "done" | "current" | "upcoming";
export interface ProgressItem { id: string; label: string; state: ProgressState; }

export interface LoadedLesson {
  definition: LessonDefinition;
  lessonFile: string;
  workspace: string;
  progress: ProgressItem[];
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

/** Load a kata's tutorial.ts without making the engine depend on its build setup. */
export async function loadLesson(pathOrDirectory: string): Promise<LoadedLesson> {
  const candidate = resolve(pathOrDirectory);
  const lessonFile = candidate.endsWith(".ts") || candidate.endsWith(".js")
    ? candidate
    : resolve(candidate, "tutorial.ts");
  await access(lessonFile);

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const module = await jiti.import<Record<string, unknown>>(lessonFile);
  const definition = module.default ?? module.lesson ?? module;
  if (!isLessonDefinition(definition)) {
    throw new Error(`${lessonFile} does not export a valid LessonDefinition (default export is recommended).`);
  }

  const lessonDirectory = dirname(lessonFile);
  const configuredWorkspace = isAbsolute(definition.workspace)
    ? definition.workspace
    : resolve(lessonDirectory, definition.workspace);
  const workspace = await realpath(configuredWorkspace);
  const specsDirectory = resolve(workspace, definition.specsDirectory ?? "docs/specs");
  const progress = readProgress(await readFile(resolve(specsDirectory, "README.md"), "utf8"));
  return { definition: { ...definition, workspace }, lessonFile, workspace, progress };
}
