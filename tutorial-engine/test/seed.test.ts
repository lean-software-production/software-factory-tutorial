import { access, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lessonsBeforePartTwo, readProgress, skipToPartTwo } from "../src/lesson/load.js";
import { PART_TWO_SEED, seedPartTwo } from "../src/lesson/seed.js";

const tutorialRoot = fileURLToPath(new URL("../../", import.meta.url));
const seedDirectory = join(tutorialRoot, PART_TWO_SEED);

describe("the Part 2 seed", () => {
  it("supplies every file lesson 005 moves, which is what makes skipping Part 1 work", async () => {
    // Lesson 005 opens by moving Part 1's output into factory/refactor/. Read
    // its mv commands rather than restating them: a rename in the lesson should
    // fail here, not at a learner's first command.
    const lesson = await readFile(join(tutorialRoot, "docs/specs/005-join-them-into-an-assembly-line.md"), "utf8");
    const moved = [...lesson.matchAll(/^\s*mv\s+factory\/(\S+)\s+/gm)].map((match) => match[1]!);

    expect(moved.length).toBeGreaterThan(0);
    for (const file of moved) {
      await expect(access(join(seedDirectory, file)), `lesson 005 moves factory/${file}, so the seed must supply it`).resolves.toBeUndefined();
    }
  });

  it("keeps the scripts executable, since the learner runs them directly", async () => {
    for (const script of ["refactor-do.sh", "refactor-validate.sh"]) {
      const mode = (await stat(join(seedDirectory, script))).mode;
      expect(mode & 0o111, `${script} should be executable`).toBeGreaterThan(0);
    }
  });

  it("copies the seed into factory/ and leaves its README behind", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "seed-"));
    await mkdir(join(workspace, PART_TWO_SEED), { recursive: true });
    await writeFile(join(workspace, PART_TWO_SEED, "refactor-do.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(workspace, PART_TWO_SEED, "README.md"), "not for the learner\n", "utf8");

    const seeded = await seedPartTwo(workspace);

    expect(seeded).toEqual(["refactor-do.sh"]);
    expect(await readdir(join(workspace, "factory"))).toEqual(["refactor-do.sh"]);
    expect((await stat(join(workspace, "factory/refactor-do.sh"))).mode & 0o111).toBeGreaterThan(0);
  });
});

const ledger = [
  "# Lessons",
  "",
  "## Part 1 — The validation loop",
  "",
  "| Lesson | Goal |",
  "| --- | --- |",
  "| [001](001-first.md) | First |",
  "| [002](002-second.md) | Second |",
  "",
  "## Part 2 — Build the factory",
  "",
  "| Lesson | Goal |",
  "| --- | --- |",
  "| [003](003-third.md) | Third |",
  ""
].join("\n");

describe("lessonsBeforePartTwo", () => {
  it("takes the boundary from the part headings rather than a hardcoded number", () => {
    expect(lessonsBeforePartTwo(ledger)).toEqual(["001", "002"]);
  });

  it("skips nothing when the curriculum has only one part", () => {
    const onePart = ledger.split("## Part 2")[0]!;
    expect(lessonsBeforePartTwo(onePart)).toEqual([]);
  });

  it("finds the real curriculum's boundary at the end of Part 1", async () => {
    const real = await readFile(join(tutorialRoot, "docs/specs/README.md"), "utf8");
    expect(lessonsBeforePartTwo(real)).toEqual(["001", "002", "003", "004"]);
  });
});

describe("skipToPartTwo", () => {
  it("marks Part 1 skipped rather than done, and opens Part 2's first lesson", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "skip-"));
    await mkdir(join(workspace, "docs/specs"), { recursive: true });
    await mkdir(join(workspace, PART_TWO_SEED), { recursive: true });
    await writeFile(join(workspace, "docs/specs/README.md"), ledger, "utf8");
    await writeFile(join(workspace, PART_TWO_SEED, "refactor-do.sh"), "#!/bin/sh\n", { mode: 0o755 });

    const result = await skipToPartTwo(workspace);

    expect(result.skipped).toEqual(["001", "002"]);
    expect(result.seeded).toEqual(["refactor-do.sh"]);
    expect(result.progress.slice(1).map((item) => [item.id, item.state]))
      .toEqual([["001", "skipped"], ["002", "skipped"], ["003", "current"]]);

    // Skipped is recorded apart from completed, so nothing later can mistake a
    // jumped lesson for one the learner did.
    expect(JSON.parse(await readFile(join(workspace, ".tutorial/.tmp/tutorial-progress.json"), "utf8")))
      .toEqual({ completed: [], skipped: ["001", "002"] });
  });

  it("leaves a skipped lesson skipped in the outline, not merely unfinished", () => {
    const progress = readProgress(ledger, { skipped: new Set(["001"]) });
    expect(progress.slice(1).map((item) => item.state)).toEqual(["skipped", "current", "upcoming"]);
  });
});
