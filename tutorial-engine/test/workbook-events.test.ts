import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LessonProgressStore } from "../src/lesson/progress-store.js";
import { WorkbookEventStore, nowEvent, project } from "../src/workbook/events.js";
import { fileURLToPath } from "node:url";
import { loadWorkbookLesson } from "../src/workbook/load.js";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const lesson001 = await loadWorkbookLesson(resolve(workspaceRoot, "lessons/01-the-validation-loop/01-run-an-agent-headlessly"), "01-the-validation-loop/01-run-an-agent-headlessly");
if (!lesson001) throw new Error("Missing workbook lesson 001 fixture.");

let dirs: string[] = [];
async function workspace() { const dir = await mkdtemp(resolve(tmpdir(), "workbook-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook event projection", () => {
  it("keeps unexpected output as evidence without completing the active block", () => {
    const events = [nowEvent({ type: "unexpected_output_submitted", lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "run-supplied-command", evidence: "pi not found" })];
    const state = project(events, lesson001);
    expect(state.activeBlockId).toBe("run-supplied-command");
    expect(state.blocks.find((block) => block.id === "run-supplied-command")?.completed).toBe(false);
    expect(state.unexpected["run-supplied-command"]).toEqual(["pi not found"]);
  });

  it("emerges blocks through the active activity and advances through completion", () => {
    expect(project([], lesson001).blocks.map((block) => [block.id, block.emerged])).toEqual([
      ["orientation", true], ["run-supplied-command", true], ["change-job", false], ["reflection", false], ["transition", false]
    ]);
    const events = [
      nowEvent({ type: "observation_acknowledged", lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "run-supplied-command" }),
      nowEvent({ type: "observation_acknowledged", lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "change-job" }),
      nowEvent({ type: "reflection_submitted", lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "reflection", response: "probably wrong is still participation" }),
    ];
    expect(project(events, lesson001).activeBlockId).toBe("transition");
    expect(project(events, lesson001).blocks.map((block) => block.emerged)).toEqual([true, true, true, true, true]);
    expect(project([...events, nowEvent({ type: "lesson_transitioned", lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "transition" })], lesson001).completedLessons).toEqual(["01-the-validation-loop/01-run-an-agent-headlessly"]);
  });

  it("rebuilds resume state from JSONL events, not projection cache or scroll position", async () => {
    const dir = await workspace(); const store = new WorkbookEventStore(dir);
    await store.append(nowEvent({ type: "observation_acknowledged", lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "run-supplied-command" }));
    await store.writeProjection({ activeLessonId: "01-the-validation-loop/01-run-an-agent-headlessly", activeBlockId: "wrong", completedLessons: [], blocks: [], unexpected: {}, reflections: {} });
    expect(project(await store.read(), lesson001).activeBlockId).toBe("change-job");
  });

  it("writes only under factory/.tmp/workbook and stays separate from legacy progress", async () => {
    const dir = await workspace(); const store = new WorkbookEventStore(dir);
    await store.append(nowEvent({ type: "observation_acknowledged", lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "run-supplied-command" }));
    await new LessonProgressStore(dir).write({ completed: ["01-the-validation-loop/01-run-an-agent-headlessly"], skipped: [] });
    expect(store.eventPath).toContain("factory/.tmp/workbook/events.jsonl");
    expect(await readFile(store.eventPath, "utf8")).toContain("observation_acknowledged");
    expect(await readFile(resolve(dir, "factory/.tmp/tutorial-progress.json"), "utf8")).toContain("completed");
  });

  it("has no event that lets unrelated file changes complete terminal practice", () => {
    expect(project([{ type: "file_change_observed", at: new Date().toISOString(), lessonId: "01-the-validation-loop/01-run-an-agent-headlessly", blockId: "run-supplied-command" } as any], lesson001).activeBlockId).toBe("run-supplied-command");
  });
});
