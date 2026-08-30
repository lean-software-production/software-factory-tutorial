/**
 * Authored curriculum tests for the Tetris primer redesign.
 *
 * Verifies:
 * - Workspace ID renamed from your-first-factory to tetris
 * - Fresh workspace fixture contains only spec.md (no other authored files)
 * - spec.md matches the exact shared Tetris specification verbatim
 * - editor-practice block type for spec.md
 * - Worker-prompt block describes the plan.md mechanism correctly
 * - ralph.sh block specifies exactly five passes using pi -p (no --no-session)
 * - terminal-practice block accepts completion once all five passes returned
 * - Part 2 refactor-line workspace and calculator are untouched
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkbook } from "../src/workbook/load.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const TUTORIAL_ROOT = resolve(REPO_ROOT, "tutorial");

const EXACT_SPEC = `# Tetris

Build a game of Tetris that runs in the terminal.

Start it with:

    npm start

Keep the complete game display within 24 terminal rows, including the board, score, controls,
borders, and game-over messages.

You may install packages if they help you render or control the terminal display.
`;

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

  it("has a clean fixture with only spec.md (no hidden files or nested directories)", async () => {
    const fixturePath = resolve(TUTORIAL_ROOT, "workspaces/tetris");
    await expect(relativeFixtureEntries(fixturePath)).resolves.toEqual(["spec.md"]);
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
  });

  it("has a prompt editor-practice block protecting every plan.md branch clause", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-worker-prompt.md"),
      "utf8"
    );
    const sections = splitBlockContent(blockContent);
    expect(blockContent).toContain("type: editor-practice");
    expect(blockContent).not.toContain("calculator");
    expect(blockContent).not.toContain("two plus two");
    assertPromptMechanism(sections.tutor);
    assertPromptMechanism(sections.publicBody);
  });

  it("has a loop block requiring the exact five-pass default Pi invocation", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-the-loop.md"),
      "utf8"
    );
    const sections = splitBlockContent(blockContent);
    expect(blockContent).toContain("type: editor-practice");
    assertLoopContract(sections.tutor);
    assertLoopContract(sections.publicBody);
    // The sample script should use one loop body invocation rather than five copied commands.
    expect(commandOccurrences(sections.publicBody)).toBe(2);
    expect(blockContent).not.toMatch(/exactly two/i);
  });

  it("has a terminal-practice block that accepts bounded completion, not a playable game", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/run-the-factory.md"),
      "utf8"
    );
    expect(blockContent).toContain("type: terminal-practice");
    for (const marker of expectedPassMarkers()) expect(blockContent).toContain(marker);
    expect(blockContent).toMatch(/returned to the prompt/i);
    // Must not require a playable or perfect Tetris implementation.
    expect(blockContent).not.toMatch(/playable|perfect/i);
    expect(blockContent).not.toMatch(/complete.*tetris|tetris.*complete/i);
  });

  it("keeps primer prose within glossary vocabulary for this early lesson", async () => {
    const lessonDir = resolve(TUTORIAL_ROOT, "lessons/tetris");
    const files = [
      resolve(lessonDir, "lesson.md"),
      ...(await readdir(resolve(lessonDir, "blocks"))).map((file) => resolve(lessonDir, "blocks", file))
    ];
    for (const file of files) {
      const content = (await readFile(file, "utf8")).replaceAll("write-worker-prompt", "");
      expect(content, file).not.toMatch(/\bworker(?: agent)?\b/i);
      expect(content, file).not.toMatch(/\bagent\b/i);
    }
  });
});

describe("tetris lesson lesson.md", () => {
  it("declares workspace tetris and names the four blocks", async () => {
    const content = await readFile(resolve(TUTORIAL_ROOT, "lessons/tetris/lesson.md"), "utf8");
    expect(content).toContain("workspace: tetris");
    expect(content).not.toContain("your-first-factory");
    expect(content).not.toContain("calculator");
  });

  it("opens as a Tetris first-factory primer with honest time and cost", async () => {
    const content = await readFile(resolve(TUTORIAL_ROOT, "lessons/tetris/lesson.md"), "utf8");
    expect(content).toMatch(/^# .*Tetris.*factory/im);
    expect(content).not.toContain("# Your first factory");
    expect(content).toMatch(/first taste|feel the loop/i);
    expect(content).toMatch(/five/i);
    expect(content).toMatch(/ten to thirty minutes/i);
    expect(content).toMatch(/costs? real money|few cents/i);
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

type BlockFrontMatter = { type: string; path?: string };

function splitBlockContent(text: string): { tutor: string; publicBody: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const closing = lines.indexOf("---", 1);
  if (lines[0] !== "---" || closing < 0) throw new Error("test fixture expected front matter");

  const frontMatter = lines.slice(1, closing).join("\n");
  const tutorMatch = /(?:^|\n)tutor: \|-\n(?<tutor>(?:  .*\n|\n)*)/.exec(`${frontMatter}\n`);
  return {
    tutor: tutorMatch?.groups?.tutor?.replace(/^  /gm, "") ?? "",
    publicBody: lines.slice(closing + 1).join("\n")
  };
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function assertPromptMechanism(text: string): void {
  const normal = compact(text);
  expect(normal).toMatch(/Without `?plan\.md`?/i);
  expect(normal).toMatch(/create `?plan\.md`? with exactly four similarly sized, independently checkable tasks/i);
  expect(normal).toMatch(/commit (?:that|the) `?plan`?[.,;]/i);
  expect(normal).toMatch(/stop without implementing anything(?: in this first pass)?/i);
  expect(normal).toMatch(/With `?plan\.md`?/i);
  expect(normal).toMatch(/find the first (?:task that is not yet marked done|incomplete task)/i);
  expect(normal).toMatch(/(?:do exactly that task and nothing more|Do only that task\. Nothing else\.)/i);
  expect(normal).toMatch(/run a relevant check if one exists/i);
  expect(normal).toMatch(/checks? must return on their own/i);
  expect(normal).toMatch(/do not start the game/i);
  expect(normal).toMatch(/interactive scaffolds, dev\/watch commands/i);
  expect(normal).toMatch(/command(?:s)? that might wait for input or keep running(?: as a check)?/i);
  expect(normal).toMatch(/choose a non-interactive check instead(?: when a command might wait)?/i);
  expect(normal).toMatch(/mark the task done in `?plan\.md`? before committing/i);
  expect(normal).toMatch(/commit(?: the)? useful task work and the `?plan\.md`? update together/i);
  expect(normal).toMatch(/stop without starting another task/i);
  expect(normal).toMatch(/If no incomplete task remains, (?:the pass should )?stop without an empty commit\./i);
  expect(normal).toMatch(/If nothing has changed, do not create an empty commit\./i);
  expect(normal).toMatch(/(?:The prompt must not|Do not) ask Pi to (?:start|run) the loop script, (?:(?:to )?complete all tasks in (?:one|a single) pass, or (?:to )?run forever|(?:to )?run forever, or (?:to )?complete all tasks in (?:one|a single) pass)\./i);
}

function assertLoopContract(text: string): void {
  const normal = compact(text);
  expect(normal).toMatch(/The script must run the exact .* unconfigured\/default command/i);
  expect(normal).toMatch(/once in each of exactly five passes/i);
  expect(normal).toMatch(/once in each of exactly five passes/i);
  expect(normal).toContain("for pass in 1 2 3 4 5; do");
  expect(normal).toContain('echo "Pass $pass/5: starting"');
  expect(normal).toContain("pi -p < prompt.md");
  expect(normal).toContain('echo "Pass $pass/5: done"');
  expect(normal).toContain("Pass 1/5: starting, Pass 1/5: done, Pass 2/5: starting, Pass 2/5: done, Pass 3/5: starting, Pass 3/5: done, Pass 4/5: starting, Pass 4/5: done, Pass 5/5: starting, and Pass 5/5: done.");
  expect(normal).toMatch(/reject `--no-session`, provider\/model options, (?:and )?other Pi flags/i);
  expect(normal).toMatch(/hard-coded provider\/model/i);
  expect(normal).toMatch(/(?:unbounded loops(?: such as `while :`)?|any other unbounded loop)/i);
  expect(normal).toMatch(/(?:loops without a fixed upper bound|fixed limit)/i);
  expect(normal).toMatch(/fewer or more than five (?:Pi )?passes/i);
  expect(normal).toMatch(/fewer or more than five Pi invocations/i);
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
    `Pass ${pass}/5: done`
  ]);
}
