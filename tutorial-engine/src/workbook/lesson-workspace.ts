import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { LESSON_WORKSPACE_PATTERN } from "./contract.js";

export function isLessonWorkspaceDeclaration(value: unknown): value is string {
  return typeof value === "string" && LESSON_WORKSPACE_PATTERN.test(value);
}

export function assertLessonWorkspaceDeclaration(value: string, location: string): string {
  if (!isLessonWorkspaceDeclaration(value)) {
    throw new Error(`${location}: workspace must be workspaces/<lowercase-hyphenated-slug>`);
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveLessonWorkspaceRoot(workspaceRoot: string, lessonWorkspace?: string): Promise<string> {
  const root = await realpath(resolve(workspaceRoot));
  if (!lessonWorkspace) return root;
  assertLessonWorkspaceDeclaration(lessonWorkspace, "lesson workspace");
  const target = resolve(root, lessonWorkspace);
  const realTarget = await realpath(target);
  if (!isInside(root, realTarget)) throw new Error("Lesson workspace must stay inside the session workspace.");
  const info = await lstat(realTarget);
  if (!info.isDirectory()) throw new Error("Lesson workspace must be a directory.");
  return realTarget;
}

export function lessonWorkspaceContainerPath(lessonWorkspace?: string): string {
  if (!lessonWorkspace) return "/workspace";
  assertLessonWorkspaceDeclaration(lessonWorkspace, "lesson workspace");
  return `/workspace/${lessonWorkspace}`;
}
