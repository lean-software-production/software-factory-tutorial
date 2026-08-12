import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** This curriculum's learner work lives in factory/ and may be reset by its legacy flow. */
export async function resetFactoryArtifacts(workspace: string): Promise<void> {
  const factory = resolve(workspace, "factory");
  const entries = await readdir(factory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name !== ".gitkeep")
    .map((entry) => rm(resolve(factory, entry.name), { recursive: entry.isDirectory(), force: true })));
}
