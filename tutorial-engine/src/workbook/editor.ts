import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AttemptStore } from "./attempts.js";
import type { EditorPracticeBlock } from "./contract.js";

const DENIED_TARGET_SEGMENTS = new Set([".git", ".tutorial", ".tmp"]);

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertSafeEditorTargetPath(path: string): void {
  if (typeof path !== "string" || !path.trim()) throw new Error("Editor target path is required.");
  if (isAbsolute(path)) throw new Error("Editor target path must be workspace-relative, not absolute.");
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === "." || segment === "..") throw new Error("Editor target path contains an unsafe segment.");
    if (DENIED_TARGET_SEGMENTS.has(segment)) throw new Error(`Editor target path uses reserved workspace segment '${segment}'.`);
  }
}

async function nearestExisting(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try { await lstat(current); return current; }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("Editor target path is outside the workspace.");
      current = parent;
    }
  }
}

export async function resolveEditorTarget(workspace: string, path: string): Promise<string> {
  assertSafeEditorTargetPath(path);
  const root = await realpath(resolve(workspace));
  const target = resolve(root, path);
  if (!isInside(root, target)) throw new Error("Editor target path is outside the workspace.");
  const existing = await nearestExisting(target);
  const realExisting = await realpath(existing);
  if (!isInside(root, realExisting)) throw new Error("Editor target path is outside the workspace.");
  return target;
}

export interface PromoteAcceptedEditorAttemptOptions {
  workspace: string;
  attempts: Pick<AttemptStore, "read" | "current">;
  lessonId: string;
  block: EditorPracticeBlock;
  attemptId: string;
}

export async function promoteCurrentEditorAttempt(options: PromoteAcceptedEditorAttemptOptions): Promise<{ path: string } | undefined> {
  const attempt = await options.attempts.read(options.attemptId);
  if (!attempt || attempt.lessonId !== options.lessonId || attempt.blockId !== options.block.id || attempt.evidence.kind !== "editor") return undefined;
  const current = await options.attempts.current(options.lessonId, options.block.id);
  if (!current || current.id !== attempt.id || (current.status !== "reviewing" && current.status !== "accepted") || current.evidence.kind !== "editor") return undefined;
  const target = await resolveEditorTarget(options.workspace, options.block.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, current.evidence.text, "utf8");
  return { path: target };
}

export async function promoteAcceptedEditorAttempt(options: PromoteAcceptedEditorAttemptOptions): Promise<{ path: string } | undefined> {
  const attempt = await options.attempts.read(options.attemptId);
  if (!attempt || attempt.status !== "accepted") return undefined;
  return promoteCurrentEditorAttempt(options);
}
