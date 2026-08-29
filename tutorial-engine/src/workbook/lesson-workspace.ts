import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LESSON_WORKSPACE_PATTERN } from "./contract.js";

export type LessonWorkspaceId = string;

export function isLessonWorkspaceDeclaration(value: unknown): value is LessonWorkspaceId {
  return typeof value === "string" && LESSON_WORKSPACE_PATTERN.test(value);
}

export function assertLessonWorkspaceDeclaration(value: string, location: string): LessonWorkspaceId {
  if (!isLessonWorkspaceDeclaration(value)) {
    throw new Error(`${location}: workspace must be a lowercase-hyphenated workspace id`);
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function requireLiveLessonWorkspaceRoot(workspaceRoot: string, containingRoot: string, workspaceId: string): Promise<string> {
  assertLessonWorkspaceDeclaration(workspaceId, "lesson workspace");
  const root = await realpath(resolve(containingRoot));
  const target = resolve(workspaceRoot);
  const realTarget = await realpath(target);
  if (!isInside(root, realTarget)) throw new Error("Lesson workspace must stay inside the session workspaces directory.");
  const info = await lstat(realTarget);
  if (!info.isDirectory()) throw new Error("Lesson workspace must be a directory.");
  return realTarget;
}
