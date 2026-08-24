import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbook } from "../src/workbook/load.js";
import { startWorkbookServer } from "../src/workbook/server.js";
import { buildWorkbookBlockStream } from "../src/workbook/workbook-blocks.js";

let dirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-block-progression-")); dirs.push(dir);
  await mkdir(resolve(dir, "parts"), { recursive: true });
  await mkdir(resolve(dir, "lessons/001-first/blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), ["---", "parts:", "  - id: validation-loop", "    lessons:", "      - 001-first", "---", "# Demo workbook", "", "Welcome."].join("\n"));
  await writeFile(resolve(dir, "parts/validation-loop.md"), ["---", "---", "# Validation loop", "", "Part preamble."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/lesson.md"), ["---", "durationMinutes: 5", "outcomes:", "  - Know the flow.", "blocks:", "  - orientation", "  - finish", "---", "# Run an agent headlessly", "", "Lesson preamble."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/orientation.md"), ["---", "type: narrative", "---", "## Orientation", "", "Read this."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/finish.md"), ["---", "type: lesson-transition", "---", "## Finish", "", "Done."].join("\n"));
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
}

afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook block progression", () => {
  it("builds structural and declared blocks with canonical anchors in one stream", async () => {
    const loaded = await loadWorkbook(await fixture());
    expect(buildWorkbookBlockStream(loaded).map((block) => [block.origin, block.kind, block.id, block.anchorId])).toEqual([
      ["structural", "workbook-introduction", "workbook--introduction", "workbook--introduction"],
      ["structural", "part-preamble", "part--validation-loop", "part--validation-loop"],
      ["structural", "lesson-preamble", "lesson--001-first", "lesson--001-first"],
      ["declared", "narrative", "lesson--001-first--orientation", "lesson--001-first--orientation"],
      ["declared", "lesson-transition", "lesson--001-first--finish", "lesson--001-first--finish"],
    ]);
  });

  it("completes exact current blocks idempotently and rejects skipping unrevealed blocks", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(), blockTutor: fakeBlockTutor() });
    try {
      const initial = await fetch(`${server.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(initial.progress.activeBlockId).toBe("workbook--introduction");
      expect(initial.progress.canComplete).toMatchObject({ blockId: "workbook--introduction", eligible: true });

      const skipped = await complete(server.url, "lesson--001-first--orientation");
      expect(skipped).toMatchObject({ outcome: "rejected", reason: "unrevealed" });
      expect(skipped.state.progress.activeBlockId).toBe("workbook--introduction");

      const intro = await complete(server.url, "workbook--introduction");
      expect(intro).toMatchObject({ outcome: "completed", navigationTarget: "part--validation-loop" });
      expect(intro.state.progress.completedBlocks).toContain("workbook--introduction");
      expect(intro.state.progress.activeBlockId).toBe("part--validation-loop");

      const duplicate = await complete(server.url, "workbook--introduction");
      expect(duplicate).toMatchObject({ outcome: "already-completed" });
      expect(duplicate.state.progress.activeBlockId).toBe("part--validation-loop");
    } finally { await server.close(); }
  });
});

async function complete(serverUrl: string, blockId: string) {
  const response = await fetch(`${serverUrl}/api/workbook/complete-block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId }) });
  expect(response.status).toBe(202);
  return response.json() as Promise<any>;
}

function fakeTutor(): any {
  return { restore: async () => undefined, reply: async () => "Tutor reply.", prepareBlockBriefing: async () => "Briefing.", review: async () => ({ outcome: "working" }), summarizeBlock: async () => "Block summary.", summarizeLesson: async () => "Lesson summary.", dispose() {} };
}

function fakeBlockTutor(): any {
  return { hint: async () => "Hint.", assess: async () => ({ readiness: "still_working", text: "Still working." }) };
}
