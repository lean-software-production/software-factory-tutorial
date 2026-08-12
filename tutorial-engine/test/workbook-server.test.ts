import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startWorkbookServer } from "../src/workbook/server.js";

let dirs: string[] = [];

// The fixture uses a lesson whose id is not "001", proving no lesson ID is
// hard-coded into the runtime; the active lesson is the first migrated chapter
// the authored workbook declares. It also omits docs/specs entirely, proving
// the rail is derived from workbook.yaml alone.
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-server-")); dirs.push(dir);
  const partDir = resolve(dir, "lessons/01-loop");
  const lessonDir = resolve(partDir, "01-first");
  await mkdir(resolve(lessonDir, "blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), [
    "---", "title: Fixture workbook", "---",
    "Welcome to the fixture workbook."
  ].join("\n"));
  await writeFile(resolve(partDir, "part.md"), "# Part 1 — Loop\n");
  await mkdir(resolve(partDir, "02-second"), { recursive: true });
  await writeFile(resolve(partDir, "02-second/hero.md"), "# Second lesson\n");
  await writeFile(resolve(lessonDir, "lesson.yaml"), [
    "hero: hero.md", "opening: opening.md", "blocks:",
    "  - id: run-supplied-command", "    type: terminal-practice", "    required: true", "    source: blocks/run-supplied-command.md",
    "  - id: change-job", "    type: terminal-practice", "    required: true", "    source: blocks/change-job.md",
    "  - id: reflection", "    type: reflection", "    required: true", "    source: blocks/reflection.md",
    "  - id: transition", "    type: lesson-transition", "    required: true", "    source: blocks/transition.md",
  ].join("\n"));
  await writeFile(resolve(lessonDir, "hero.md"), ["---", "title: First lesson hero", "dek: A hero summary line.", "meta:", "  - Your terminal", "---"].join("\n"));
  await writeFile(resolve(lessonDir, "opening.md"), ["---", "sectionLabel: What you will learn", "heading: An opening heading.", "outcomes:", "  - Do the thing.", "---", "The **payoff** sentence."].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/run-supplied-command.md"), ["---", "title: Run", "command: echo hello", "context: Root", "expectedObservation: Done", "---"].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/change-job.md"), ["---", "title: Change", "command: echo again", "context: Root", "expectedObservation: Done", "---"].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/reflection.md"), ["---", "title: Reflect", "prompt: Why?", "---"].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/transition.md"), ["---", "title: Finish", "label: Finish", "---", "Done."].join("\n"));
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
}
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook browser API", () => {
  it("rejects an action for a required block that is not active", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0 });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      for (const body of [
        { blockId: "change-job", action: "acknowledge" },
        { blockId: "transition", action: "transition" }
      ]) {
        const response = await fetch(`${server.url}/api/workbook/events`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        expect(response.status).toBe(409);
        expect((await response.json() as { error: string }).error).toMatch(/not active/i);
      }
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      expect(state.progress.activeBlockId).toBe("run-supplied-command");
      expect(state.progress.blocks.filter((block: any) => block.completed)).toEqual([]);
    } finally { await server.close(); }
  });

  it("serves the first migrated lesson from the authored rail and leaves later chapters as stubs", async () => {
    const dir = await fixture(); const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), port: 0 });
    try {
      const state = await fetch(`${server.url}/api/workbook/state`).then((r) => r.json() as any);
      // Identity and introduction come from the authored workbook, not the engine.
      expect(state.workbook).toMatchObject({ title: "Fixture workbook" });
      expect(state.introduction).toContain("Welcome to the fixture workbook.");
      expect(state.chapters.map((chapter: any) => [chapter.id, chapter.state, chapter.partNumber, chapter.lessonNumber])).toEqual([["01-loop/01-first", "unavailable", 1, 1], ["01-loop/02-second", "unavailable", 1, 2]]);
      expect(state.introductionComplete).toBe(false);
      expect(state.chapters[0].lesson).toBeUndefined();
      const blocked = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "acknowledge" }) });
      expect(blocked.status).toBe(409);
      const introduced = await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" }).then((response) => response.json() as any);
      expect(introduced.introductionComplete).toBe(true);
      expect(introduced.chapters.map((chapter: any) => [chapter.id, chapter.state, chapter.partNumber, chapter.lessonNumber])).toEqual([["01-loop/01-first", "migrated", 1, 1], ["01-loop/02-second", "unavailable", 1, 2]]);
      expect(introduced.progress.activeLessonId).toBe("01-loop/01-first");
      // Hero and opening are Markdown-derived authored content.
      expect(introduced.chapters[0].lesson.hero).toMatchObject({ title: "First lesson hero", dek: "A hero summary line.", meta: ["Your terminal"] });
      expect(introduced.chapters[0].lesson.opening).toMatchObject({ sectionLabel: "What you will learn", heading: "An opening heading.", outcomes: ["Do the thing."] });
      expect(introduced.chapters[0].lesson.opening.markdown).toContain("**payoff**");
      // Only emerged block content is serialized: the ahead command and prompt are absent.
      expect(introduced.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["run-supplied-command"]);
      expect(JSON.stringify(introduced)).not.toContain("echo again");
      expect(JSON.stringify(introduced)).not.toContain("Why?");
      const different = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "unexpected", evidence: "command failed" }) }).then((r) => r.json() as any);
      expect(different.progress.activeBlockId).toBe("run-supplied-command");
      const ack = await fetch(`${server.url}/api/workbook/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "run-supplied-command", action: "acknowledge" }) }).then((r) => r.json() as any);
      expect(ack.progress.activeBlockId).toBe("change-job");
      expect(ack.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["run-supplied-command", "change-job"]);
    } finally { await server.close(); }
  });
});
