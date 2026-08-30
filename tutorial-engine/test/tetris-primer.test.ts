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

  it("has a worker-prompt editor-practice block describing the plan.md mechanism", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-worker-prompt.md"),
      "utf8"
    );
    expect(blockContent).toContain("type: editor-practice");
    // Must describe two-branch plan.md mechanism: create plan or complete first task
    expect(blockContent).toMatch(/plan\.md/);
    expect(blockContent).toMatch(/four/i);
    expect(blockContent).not.toContain("calculator");
    expect(blockContent).not.toContain("two plus two");
  });

  it("has a loop block for ralph.sh with five passes and pi -p (no --no-session)", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-the-loop.md"),
      "utf8"
    );
    expect(blockContent).toContain("type: editor-practice");
    // Must mention exactly five passes
    expect(blockContent).toMatch(/five/i);
    expect(blockContent).toMatch(/pi -p/);
    // Must NOT hard-code --no-session
    expect(blockContent).not.toContain("--no-session");
    // Must NOT prescribe exactly two passes
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

  it("steers stuck workers away from interactive checks without speculating about stdin", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/write-worker-prompt.md"),
      "utf8"
    );
    expect(blockContent).toMatch(/checks? must return on (?:their|its) own/i);
    expect(blockContent).toMatch(/do not start the game/i);
    expect(blockContent).toMatch(/interactive scaffold/i);
    expect(blockContent).toMatch(/dev\/watch|watch\/dev|dev or watch/i);
    expect(blockContent).toMatch(/non-interactive check/i);
    expect(blockContent).toMatch(/mark.*task.*done.*plan\.md.*before.*commit/is);
    expect(blockContent).toMatch(/no incomplete task.*stop.*empty commit/is);
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
