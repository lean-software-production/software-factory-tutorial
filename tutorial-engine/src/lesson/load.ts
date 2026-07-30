import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createJiti } from "jiti";
import { isLessonDefinition, type LessonDefinition } from "./contract.js";

export interface LoadedLesson {
  definition: LessonDefinition;
  lessonFile: string;
  workspace: string;
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
  return { definition: { ...definition, workspace }, lessonFile, workspace };
}
