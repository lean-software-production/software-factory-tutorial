import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWorkbookServer } from "../src/workbook/server.js";

let dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-server-")); dirs.push(dir);
  await mkdir(resolve(dir, "docs/specs"), { recursive: true });
  await writeFile(resolve(dir, "README.md"), "# Fixture\n");
  await writeFile(resolve(dir, "docs/specs/README.md"), "# Lessons\n\n## Part 1 — The validation loop\n\n| Lesson | Goal |\n| --- | --- |\n| [001](001.md) | Run an agent headlessly |\n| [002](002.md) | Build a doer |\n");
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
}
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook browser API", () => {
  it("serves lesson 001 and leaves unavailable chapters as stubs", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0 });
    try {
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      expect(state.chapters.map((chapter: any) => [chapter.id, chapter.state])).toEqual([["001", "migrated"], ["002", "unavailable"]]);
      expect(JSON.stringify(state)).not.toContain("global chat");
      const different = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "unexpected", evidence: "command failed" }) }).then((r) => r.json() as any);
      expect(different.progress.activeBlockId).toBe("run-supplied-command");
      const ack = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "acknowledge" }) }).then((r) => r.json() as any);
      expect(ack.progress.activeBlockId).toBe("change-job");
    } finally { await server.close(); }
  });
});
