import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
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

function editorTargetSegments(root: string, target: string): string[] {
  const rel = relative(root, target);
  if (rel === "") return [];
  return rel.split(sep);
}

async function assertExistingComponentsAreOrdinary(root: string, target: string): Promise<void> {
  let current = root;
  for (const segment of editorTargetSegments(root, target)) {
    current = resolve(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error("Editor target path may not contain symlinks.");
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function ensureSafeParentDirectories(root: string, target: string): Promise<void> {
  let current = root;
  for (const segment of editorTargetSegments(root, dirname(target))) {
    current = resolve(current, segment);
    for (;;) {
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) throw new Error("Editor target path may not contain symlinks.");
        if (!entry.isDirectory()) throw new Error("Editor target parent is not a directory.");
        break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        try { await mkdir(current); }
        catch (mkdirError: any) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
      }
    }
  }
}

async function writeEditorFileNoFollow(target: string, text: string): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  const handle = await open(target, flags, 0o666);
  try { await handle.writeFile(text, "utf8"); }
  finally { await handle.close(); }
}

export async function resolveEditorTarget(workspace: string, path: string): Promise<string> {
  assertSafeEditorTargetPath(path);
  const root = await realpath(resolve(workspace));
  const target = resolve(root, path);
  if (!isInside(root, target)) throw new Error("Editor target path is outside the lesson workspace.");
  await assertExistingComponentsAreOrdinary(root, target);
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
  const root = await realpath(resolve(options.workspace));
  if (!isInside(root, target)) throw new Error("Editor target path is outside the lesson workspace.");
  await ensureSafeParentDirectories(root, target);
  await assertExistingComponentsAreOrdinary(root, target);
  await writeEditorFileNoFollow(target, current.evidence.text);
  return { path: target };
}

export async function promoteAcceptedEditorAttempt(options: PromoteAcceptedEditorAttemptOptions): Promise<{ path: string } | undefined> {
  const attempt = await options.attempts.read(options.attemptId);
  if (!attempt || attempt.status !== "accepted") return undefined;
  return promoteCurrentEditorAttempt(options);
}
