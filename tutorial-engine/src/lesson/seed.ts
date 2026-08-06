import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";

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
export async function seedPartTwo(workspace: string): Promise<string[]> {
  const from = resolve(workspace, PART_TWO_SEED);
  const factory = resolve(workspace, "factory");
  await mkdir(factory, { recursive: true });

  const entries = await readdir(from, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name !== "README.md")
    .map((entry) => entry.name)
    .sort();

  // copyFile preserves the executable bit, which do.sh and validate.sh need.
  await Promise.all(files.map((name) => copyFile(resolve(from, name), resolve(factory, name))));
  return files;
}
