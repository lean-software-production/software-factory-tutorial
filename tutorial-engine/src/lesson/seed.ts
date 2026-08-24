import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

/** Where the shipped Part 2 seed lives, relative to the tutorial workspace. */
export const PART_TWO_SEED = "docs/seeds/part-2";

/**
 * Copy what Part 1 would have left in `factory/`, for a learner who skips it.
 *
 * Lesson 005 opens by moving five files lessons 002 to 004 build. Without them
 * it fails on its first command, so skipping Part 1 means seeding its output
 * rather than only moving the outline's highlight.
 *
 * The seed's own README is documentation for whoever maintains the curriculum,
 * not something the learner should find in their factory, so it stays behind.
 */
export interface SeedPartTwoRoots { contentRoot: string; workspaceRoot: string; }

export async function seedPartTwo(workspace: string | SeedPartTwoRoots): Promise<string[]> {
  const contentRoot = typeof workspace === "string" ? workspace : workspace.contentRoot;
  const workspaceRoot = typeof workspace === "string" ? workspace : workspace.workspaceRoot;
  const from = resolve(contentRoot, PART_TWO_SEED);
  const factory = resolve(workspaceRoot, "factory");

  // Copied with its shape intact: the quality baseline belongs in .tmp/, where
  // lesson 005 expects to find it and where a run would have written it.
  const entries = await readdir(from, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== "README.md")
    .map((entry) => relative(from, resolve(entry.parentPath, entry.name)))
    .sort();

  for (const name of files) {
    const destination = resolve(factory, name);
    await mkdir(dirname(destination), { recursive: true });
    // copyFile preserves the executable bit, which do.sh and validate.sh need.
    await copyFile(resolve(from, name), destination);
  }
  return files;
}
