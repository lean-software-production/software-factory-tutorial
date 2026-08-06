import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LessonProgressStore } from "../src/lesson/progress-store.js";

const store = async () => new LessonProgressStore(await mkdtemp(join(tmpdir(), "progress-store-")));

describe("LessonProgressStore", () => {
  it("keeps progress in factory/, which is gitignored and reset with the transcript", async () => {
    const progress = await store();

    expect(progress.path.endsWith(join("factory", "tutorial-progress.json"))).toBe(true);
  });

  it("treats a learner who has not started as having finished nothing", async () => {
    expect([...(await (await store()).read()).completed]).toEqual([]);
  });

  it("round-trips finished lessons, creating factory/ if the learner has none yet", async () => {
    const progress = await store();

    await progress.add("001");
    await progress.add("002");

    expect([...(await progress.read()).completed]).toEqual(["001", "002"]);
    expect(JSON.parse(await readFile(progress.path, "utf8"))).toEqual({ completed: ["001", "002"], skipped: [] });
  });

  it("records a lesson once however often it is added", async () => {
    const progress = await store();

    await progress.add("001");
    await progress.add("001");

    expect([...(await progress.read()).completed]).toEqual(["001"]);
  });

  it("starts the learner over rather than refusing to open when the file is corrupt", async () => {
    // Losing the highlight's position costs a learner some clicking. Throwing
    // here would cost them the tutorial, since loadLesson runs before the
    // server starts.
    const progress = await store();
    await mkdir(join(progress.path, ".."), { recursive: true });
    await writeFile(progress.path, "{ not json", "utf8");

    expect([...(await progress.read()).completed]).toEqual([]);
  });

  it("ignores entries that are not lesson ids", async () => {
    const progress = await store();
    await mkdir(join(progress.path, ".."), { recursive: true });
    await writeFile(progress.path, JSON.stringify({ completed: ["001", 2, null, "003"] }), "utf8");

    expect([...(await progress.read()).completed]).toEqual(["001", "003"]);
  });
});
