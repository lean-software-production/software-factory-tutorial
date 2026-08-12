import { resolve } from "node:path";

/** Per-learner runtime state, independent of any curriculum's working files. */
export const TUTORIAL_STATE_DIRECTORY = ".tutorial/.tmp";

export function tutorialStatePath(workspace: string, ...segments: string[]): string {
  return resolve(workspace, TUTORIAL_STATE_DIRECTORY, ...segments);
}
