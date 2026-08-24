import { resolve } from "node:path";

/** Legacy per-learner runtime state location for pre-session tutorial workspaces. */
export const TUTORIAL_STATE_DIRECTORY = ".tutorial/.tmp";

export function tutorialStatePath(workspace: string, ...segments: string[]): string {
  return resolve(workspace, TUTORIAL_STATE_DIRECTORY, ...segments);
}

/** Per-session runtime state lives directly under .tutorial/<session-id>. */
export function tutorialSessionStatePath(sessionRoot: string, ...segments: string[]): string {
  return resolve(sessionRoot, ...segments);
}
