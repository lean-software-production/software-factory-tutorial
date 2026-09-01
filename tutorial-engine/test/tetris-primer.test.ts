/**
 * Authored curriculum tests for the Tetris primer redesign.
 *
 * Verifies:
 * - Workspace ID renamed from your-first-factory to tetris
 * - Fresh workspace fixture contains the exact authored spec.md, prompt.md, and ralph.sh seeds
 * - spec.md matches the exact shared Tetris specification verbatim
 * - editor-practice block type for spec.md
 * - Doer-prompt block describes the plan.md mechanism and bounded safety rules correctly
 * - ralph.sh block specifies exactly five passes using pi -p (no --no-session)
 * - terminal-practice block accepts completion once all five passes returned
 * - Primer prose intentionally teaches the word agent, not worker
 * - Part 2 refactor-line workspace and calculator are untouched
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkbook } from "../src/workbook/load.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const TUTORIAL_ROOT = resolve(REPO_ROOT, "tutorial");

const EXACT_SPEC = [
  "# Tetris",
  "",
  "Build a game of Tetris that runs in the terminal.",
  "",
  "Start it with:",
  "",
  "    npm start",
  "",
  "Keep the complete game display within 24 terminal rows, including the board, score, controls, borders, and game-over messages.",
  "",
  "You may install packages if they help you render or control the terminal display.",
].join("\n") + "\n";

const EXACT_PROMPT = [
  "you will implement the project specified in spec.md",
  "",
  "first, make sure you have a plan. if plan.md does not exist yet, study ",
  "spec.md and create the plan, breaking down the work into four even-sized tasks.",
  "",
  "otherwise, if plan.md does exist:",
  "- pick the first incomplete task and implement only that task",
  "- don't start the game or do any other long-running or interactive commands",
  "- update the plan to mark the task as done",
  "- exit",
].join("\n") + "\n";

const EXACT_RALPH = [
  "#!/bin/bash",
  "",
  "for pass in 1 2 3 4 5; do",
  "\techo \"Pass $pass/5: starting\"",
  "\t# fix this line:",
  "\t# pi -p < prompt.md",
  "\techo \"Pass $pass/5: done\"",
  "done",
].join("\n");

const EXPECTED_TETRIS_BLOCKS = [
  "read-the-spec",
  "write-doer-prompt",
  "write-the-loop",
  "run-the-factory",
  "play-your-game",
];

const EXPECTED_LOOP_SAMPLE = [
  "#!/usr/bin/env bash",
  "",
  "for pass in 1 2 3 4 5; do",
  "  echo \"Pass $pass/5: starting\"",
  "  pi -p < prompt.md",
  "  echo \"Pass $pass/5: done\"",
  "done",
].join("\n");

describe("tetris primer workspace", () => {
  it("renames workspace ID from your-first-factory to tetris", async () => {
    const loaded = await loadWorkbook(TUTORIAL_ROOT);
    const workspaceIds = loaded.chapters.map((ch) => ch.lesson.workspace).filter(Boolean);
    expect(workspaceIds).toContain("tetris");
    expect(workspaceIds).not.toContain("your-first-factory");
  });

  it("provides exactly the shared Tetris spec.md in the fixture", async () => {
    const specPath = resolve(TUTORIAL_ROOT, "workspaces/tetris/spec.md");
    const content = await readFile(specPath, "utf8");
    expect(content).toBe(EXACT_SPEC);
  });

  it("provides the authored doer prompt seed in the fixture", async () => {
    const promptPath = resolve(TUTORIAL_ROOT, "workspaces/tetris/prompt.md");
    const content = await readFile(promptPath, "utf8");
    expect(content).toBe(EXACT_PROMPT);
    assertSeedPromptContract(content);
  });

  it("provides the authored Ralph loop skeleton in the fixture", async () => {
    const ralphPath = resolve(TUTORIAL_ROOT, "workspaces/tetris/ralph.sh");
    const content = await readFile(ralphPath, "utf8");
    expect(content).toBe(EXACT_RALPH);
    expect(content).toContain("for pass in 1 2 3 4 5; do");
    expect(commandOccurrences(content)).toBe(1);
  });

  it("has a clean fixture with the three current authored seed files", async () => {
    const fixturePath = resolve(TUTORIAL_ROOT, "workspaces/tetris");
    await expect(relativeFixtureEntries(fixturePath)).resolves.toEqual(["prompt.md", "ralph.sh", "spec.md"]);
  });

  it("removes the your-first-factory workspace directory", async () => {
    await expect(stat(resolve(TUTORIAL_ROOT, "workspaces/your-first-factory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the your-first-factory lesson directory", async () => {
    await expect(stat(resolve(TUTORIAL_ROOT, "lessons/your-first-factory"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("tetris primer lesson blocks", () => {
  it("has an editor-practice block for spec.md", async () => {
    const lessonDir = resolve(TUTORIAL_ROOT, "lessons/tetris");
    const blockFiles = await readdir(resolve(lessonDir, "blocks"));
    const specBlock = await findSpecEditorBlock(lessonDir, blockFiles);
    expect(specBlock).not.toBeNull();
    expect(specBlock!.type).toBe("editor-practice");
    expect(specBlock!.path).toBe("spec.md");

    const blockContent = await readFile(resolve(lessonDir, "blocks/read-the-spec.md"), "utf8");
    expect(blockContent).toContain("## Read your seed");
    expect(blockContent).toContain("product specification seed that the loops will use as their initial guidance");
    expect(blockContent).toContain("accept the seeded spec without changes");
  });

  it("renames the prompt editor block to write-doer-prompt and protects the current plan.md branches", async () => {
    await expect(stat(resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-worker-prompt.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-doer-prompt.md"),
      "utf8"
    );
    const frontMatter = parseFrontMatter(blockContent)!;
    const sections = splitBlockContent(blockContent);
    expect(frontMatter.type).toBe("editor-practice");
    expect(frontMatter.path).toBe("prompt.md");
    expect(frontMatter.outcome).toBe("Write a Pi prompt that drives the factory one bounded task at a time.");
    expect(blockContent).not.toContain("calculator");
    expect(blockContent).not.toContain("two plus two");
    assertDoerPromptTutorContract(sections.tutor);
    assertDoerPromptPublicFlow(sections.publicBody);
  });

  it("has a loop block requiring the exact five-pass default Pi invocation", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-the-loop.md"),
      "utf8"
    );
    const frontMatter = parseFrontMatter(blockContent)!;
    const sections = splitBlockContent(blockContent);
    expect(frontMatter.type).toBe("editor-practice");
    expect(frontMatter.path).toBe("ralph.sh");
    expect(frontMatter.outcome).toBe("Write a bounded loop script that runs exactly five Pi passes.");
    assertLoopTutorContract(sections.tutor);
    assertLoopPublicScript(sections.publicBody);
    // The public sample script should use one loop body invocation rather than five copied commands.
    expect(commandOccurrences(sections.publicBody)).toBe(1);
    expect(commandOccurrences(sections.tutor)).toBe(2);
    expect(blockContent).not.toMatch(/exactly two/i);
  });

  it("has a terminal-practice block that accepts bounded completion, not a playable game", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/run-the-factory.md"),
      "utf8"
    );
    expect(blockContent).toContain("type: terminal-practice");
    expect(blockContent).toContain("bash ralph.sh");
    for (const marker of expectedPassMarkers()) expect(blockContent).toContain(marker);
    expect(blockContent).toMatch(/returned to the prompt/i);
    expect(blockContent).toMatch(/agent works silently/i);
    expect(blockContent).toMatch(/The terminal\s+acceptance criterion is only that all five passes completed and the script returned/i);
    // Must not require a playable or perfect Tetris implementation at this stage.
    expect(blockContent).not.toMatch(/playable|perfect/i);
    expect(blockContent).not.toMatch(/complete.*tetris|tetris.*complete/i);
  });

  it("adds a play-your-game block for manual validation after the bounded factory run", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/play-your-game.md"),
      "utf8"
    );
    const frontMatter = parseFrontMatter(blockContent)!;
    expect(frontMatter.type).toBe("terminal-practice");
    expect(frontMatter.outcome).toBe("Perform manual validation of the work the factory produced");
    expect(blockContent).toContain("## Play your game");
    expect(blockContent).toContain("npm start");
    expect(blockContent).toMatch(/played around with\s+it for a while/i);
    expect(blockContent).toMatch(/Give them space to play without accepting the block/i);
    expect(blockContent).toMatch(/Once they say they're done in the chat/i);
  });

  it("uses the deliberately taught agent wording while avoiding old worker vocabulary", async () => {
    const lessonDir = resolve(TUTORIAL_ROOT, "lessons/tetris");
    const files = [
      resolve(lessonDir, "lesson.md"),
      ...(await readdir(resolve(lessonDir, "blocks"))).map((file) => resolve(lessonDir, "blocks", file)),
    ];
    const content = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(content).toMatch(/let an agent run in a loop/i);
    expect(content).toMatch(/agent works silently/i);
    expect(content).not.toMatch(/\bworker(?: agent)?\b/i);
    expect(content).not.toContain("write-worker-prompt");
  });
});

describe("tetris lesson lesson.md", () => {
  it("declares workspace tetris and names the five blocks in order", async () => {
    const loaded = await loadWorkbook(TUTORIAL_ROOT);
    const chapter = loaded.chapters.find((candidate) => candidate.id === "tetris");
    expect(chapter).toBeDefined();
    expect(chapter!.lesson.workspace).toBe("tetris");
    expect(chapter!.lesson.blocks.map((block) => block.id)).toEqual(EXPECTED_TETRIS_BLOCKS);
    expect(chapter!.lesson.blocks.map((block) => block.type)).toEqual([
      "editor-practice",
      "editor-practice",
      "editor-practice",
      "terminal-practice",
      "terminal-practice",
    ]);

    const content = await readFile(resolve(TUTORIAL_ROOT, "lessons/tetris/lesson.md"), "utf8");
    expect(content).toContain("workspace: tetris");
    for (const blockId of EXPECTED_TETRIS_BLOCKS) expect(content).toContain(`  - ${blockId}`);
    expect(content).not.toContain("your-first-factory");
    expect(content).not.toContain("write-worker-prompt");
    expect(content).not.toContain("calculator");
  });

  it("opens with the current Your first factory framing", async () => {
    const content = await readFile(resolve(TUTORIAL_ROOT, "lessons/tetris/lesson.md"), "utf8");
    const normal = compact(content);
    expect(content).toMatch(/^# Your first factory$/m);
    expect(content).not.toMatch(/^# Your first Tetris factory$/m);
    expect(content).toContain("durationMinutes: 30");
    expect(normal).toContain("We'll build a tiny throwaway factory that uses a [Ralph loop](https://ghuntley.com/loop/) to build a game.");
    expect(normal).toContain("We're supplying a lot of the code");
    expect(normal).toContain("happens when you let an agent run in a loop.");
  });
});

describe("workbook.md references", () => {
  it("lists tetris and not your-first-factory in the part front matter", async () => {
    const content = await readFile(resolve(TUTORIAL_ROOT, "workbook.md"), "utf8");
    expect(content).toContain("tetris");
    expect(content).not.toContain("your-first-factory");
  });
});

describe("Part 2 calculator preservation", () => {
  it("keeps the refactor-line workspace intact", async () => {
    const calculatorPath = resolve(TUTORIAL_ROOT, "workspaces/refactor-line/calculator/package.json");
    await expect(stat(calculatorPath)).resolves.toBeDefined();
  });

  it("keeps all thirteen numbered lessons intact", async () => {
    const loaded = await loadWorkbook(TUTORIAL_ROOT);
    const numberedLessons = loaded.chapters.filter((ch) => /^\d{3}-/.test(ch.id));
    expect(numberedLessons.length).toBe(13);
  });

  it("does not touch tutorial/docs/seeds/part-2", async () => {
    const refactorSeed = resolve(TUTORIAL_ROOT, "docs/seeds/part-2/refactor.md");
    await expect(stat(refactorSeed)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BlockFrontMatter = { type: string; path?: string; outcome?: string };

function splitBlockContent(text: string): { tutor: string; publicBody: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const closing = lines.indexOf("---", 1);
  if (lines[0] !== "---" || closing < 0) throw new Error("test fixture expected front matter");

  const frontMatter = lines.slice(1, closing).join("\n");
  const tutorMatch = /(?:^|\n)tutor: \|-\n(?<tutor>(?:  .*\n|\n)*)/.exec(`${frontMatter}\n`);
  return {
    tutor: tutorMatch?.groups?.tutor?.replace(/^  /gm, "") ?? "",
    publicBody: lines.slice(closing + 1).join("\n"),
  };
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function assertSeedPromptContract(text: string): void {
  const normal = compact(text);
  expect(normal).toMatch(/implement the project specified in spec\.md/i);
  expect(normal).toMatch(/if plan\.md does not exist yet, study spec\.md and create the plan, breaking down the work into four even-sized tasks\./i);
  expect(normal).toMatch(/otherwise, if plan\.md does exist:/i);
  expect(normal).toMatch(/pick the first incomplete task and implement only that task/i);
  expect(normal).toMatch(/don't start the game or do any other long-running or interactive commands/i);
  expect(normal).toMatch(/update the plan to mark the task as done/i);
  expect(normal).toMatch(/exit$/i);
}

function assertDoerPromptTutorContract(text: string): void {
  const normal = compact(text);
  expect(normal).toMatch(/Accept when `prompt\.md` gives the following instructions:/i);
  expect(normal).toMatch(/When there is no plan\.md:/i);
  expect(normal).toMatch(/read spec\.md;/i);
  expect(normal).toMatch(/create plan\.md with exactly four similarly sized tasks;/i);
  expect(normal).toMatch(/When plan\.md exists:/i);
  expect(normal).toMatch(/find the first incomplete task;/i);
  expect(normal).toMatch(/do exactly that task and nothing more;/i);
  expect(normal).toMatch(/do not start the game or run commands that might wait for input or keep running;/i);
  expect(normal).toMatch(/mark the task done in plan\.md/i);
  expect(normal).toMatch(/must not ask Pi to start the loop script, run forever, or complete all tasks in a single pass\./i);
}

function assertDoerPromptPublicFlow(text: string): void {
  expect(text).toContain("## Review the prompt");
  expect(text).toContain("Review `prompt.md`, the instruction each Pi pass will follow.");
  expect(text).toContain("flowchart TD");
  expect(text).toContain("Start([One Pi pass]) --> PlanExists{Does plan.md exist?}");
  expect(text).toContain("PlanExists -- No --> ReadSpec[Read spec.md]");
  expect(text).toContain("ReadSpec --> CreatePlan[Create plan.md\\nwith exactly four similar tasks]");
  expect(text).toContain("CreatePlan -->|implement nothing| Stop([Stop])");
  expect(text).toContain("PlanExists -- Yes --> FindTask{Is there an incomplete task?}");
  expect(text).toContain("FindTask -->|No: no work left| Stop");
  expect(text).toContain("FindTask -- Yes --> ImplementTask[Implement first incomplete task]");
  expect(text).toContain("ImplementTask --> UpdatePlan[Mark the task done in plan.md]");
  expect(text).toContain("UpdatePlan -->|do not start another task| Stop");
}

function assertLoopTutorContract(text: string): void {
  const normal = compact(text);
  expect(normal).toMatch(/runs exactly five Pi passes over `prompt\.md`/i);
  expect(normal).toMatch(/prints explicit Pass N\/5 start and completion boundaries/i);
  expect(normal).toMatch(/The script must run the exact `pi -p < prompt\.md>` unconfigured\/default command/i);
  expect(normal).toMatch(/once in each of exactly five passes/i);
  expect(normal).toContain("for pass in 1 2 3 4 5; do");
  expect(normal).toContain('echo "Pass $pass/5: starting"');
  expect(normal).toContain("pi -p < prompt.md");
  expect(normal).toContain('echo "Pass $pass/5: done"');
  expect(normal).toContain("Pass 1/5: starting, Pass 1/5: done, Pass 2/5: starting, Pass 2/5: done, Pass 3/5: starting, Pass 3/5: done, Pass 4/5: starting, Pass 4/5: done, Pass 5/5: starting, and Pass 5/5: done.");
  expect(normal).toMatch(/Reject `--no-session`, provider\/model options, other Pi flags/i);
  expect(normal).toMatch(/hard-coded provider\/model/i);
  expect(normal).toMatch(/unbounded loops such as `while :`/i);
  expect(normal).toMatch(/loops without a fixed upper bound/i);
  expect(normal).toMatch(/fewer or more than five Pi passes/i);
  expect(normal).toMatch(/fewer or more than five Pi invocations/i);
}

function assertLoopPublicScript(text: string): void {
  expect(text).toContain("## Write the loop");
  expect(text).toContain("Write `ralph.sh`, the script that drives the factory.");
  expect(text).toContain("The loop feeds the same prompt to Pi each time. Here we run exactly five passes, then\nstop, just for safety.");
  expect(text).toContain(EXPECTED_LOOP_SAMPLE);
  expect(text).not.toMatch(/--no-session|while :|provider\/model/i);
}

function commandOccurrences(text: string): number {
  return text.match(/pi -p < prompt\.md/g)?.length ?? 0;
}

async function findSpecEditorBlock(
  lessonDir: string,
  blockFiles: string[]
): Promise<BlockFrontMatter | null> {
  for (const file of blockFiles) {
    const content = await readFile(resolve(lessonDir, "blocks", file), "utf8");
    const frontMatter = parseFrontMatter(content);
    if (frontMatter?.type === "editor-practice" && frontMatter?.path === "spec.md") {
      return frontMatter;
    }
  }
  return null;
}

function parseFrontMatter(text: string): BlockFrontMatter | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close < 0) return null;
  const fmLines = lines.slice(1, close);
  const result: Record<string, string> = {};
  for (const line of fmLines) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) result[m[1]!] = m[2]!.trim();
  }
  return result as BlockFrontMatter;
}

async function relativeFixtureEntries(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = `${prefix}${entry.name}`;
      found.push(entry.isDirectory() ? `${relativePath}/` : relativePath);
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), `${relativePath}/`);
    }
  }
  await visit(root);
  return found.sort();
}

function expectedPassMarkers(): string[] {
  return [1, 2, 3, 4, 5].flatMap((pass) => [
    `Pass ${pass}/5: starting`,
    `Pass ${pass}/5: done`,
  ]);
}
