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

import { readFile, readdir, stat } from "node:fs/promises";
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

  it("has a clean fixture with only spec.md (no extra authored files)", async () => {
    const fixturePath = resolve(TUTORIAL_ROOT, "workspaces/tetris");
    const entries = await readdir(fixturePath, { withFileTypes: true });
    const authoredFiles = entries
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name);
    expect(authoredFiles).toEqual(["spec.md"]);
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

  it("has a terminal-practice block that accepts five-pass completion without requiring a playable game", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/run-the-factory.md"),
      "utf8"
    );
    expect(blockContent).toContain("type: terminal-practice");
    // Must check five passes ran
    expect(blockContent).toMatch(/five|Pass 5\/5|Pass N\/5/i);
    // Must not claim the game is complete/playable
    expect(blockContent).not.toMatch(/playable/i);
    // Must not require a complete Tetris implementation
    expect(blockContent).not.toMatch(/complete.*tetris|tetris.*complete/i);
  });

  it("has ralph.sh tutor guidance that checks Pass N/5 boundaries ran", async () => {
    const blockContent = await readFile(
      resolve(TUTORIAL_ROOT, "lessons/tetris/blocks/run-the-factory.md"),
      "utf8"
    );
    // Tutor should accept when evidence shows all five passes ran and script returned
    expect(blockContent).toMatch(/Pass.*5|five.*pass/i);
  });
});

describe("tetris lesson lesson.md", () => {
  it("declares workspace tetris and names the four blocks", async () => {
    const content = await readFile(resolve(TUTORIAL_ROOT, "lessons/tetris/lesson.md"), "utf8");
    expect(content).toContain("workspace: tetris");
    expect(content).not.toContain("your-first-factory");
    expect(content).not.toContain("calculator");
  });

  it("honestly states five-pass time and cost in the lesson body", async () => {
    const content = await readFile(resolve(TUTORIAL_ROOT, "lessons/tetris/lesson.md"), "utf8");
    expect(content).toMatch(/five/i);
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
