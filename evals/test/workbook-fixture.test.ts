import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbook } from "../../tutorial-engine/src/workbook/load.js";

const fixtureRoot = resolve(import.meta.dirname, "../workbook");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function copyFixture(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "eval-workbook-fixture-"));
  tempRoots.push(workspace);
  await cp(fixtureRoot, workspace, { recursive: true });
  return workspace;
}

describe("v2 live-evaluation workbook fixture", () => {
  it("loads an isolated Markdown-manifest workbook with the evaluator-only block shapes", async () => {
    const workspace = await copyFixture();

    const workbook = await loadWorkbook(workspace);

    expect(workbook.identity.title).toBe("V2 Live Evaluator Workbook");
    expect(workbook.introduction).toContain("dedicated disposable workbook");
    expect(workbook.chapters).toHaveLength(1);

    const chapter = workbook.chapters[0]!;
    expect(chapter.id).toBe("001-live-session");
    expect(chapter.part).toBe("Evaluator Fixture");
    expect(chapter.partMarkdown).toContain("isolated from the authored curriculum");
    expect(chapter.title).toBe("Live evaluator session");
    expect(chapter.lesson.dek).toBe("Exercise every public block shape the live evaluator drives.");
    expect(chapter.lesson.outcomes).toEqual([
      "Continue from a narrative block.",
      "Submit an editor draft and wait for reviewer promotion.",
      "Run a learner-visible exact command in the embedded terminal.",
      "Attempt a clue-only terminal task without exposing private tutor guidance.",
      "Submit a reflection and finish through a transition."
    ]);

    expect(chapter.lesson.blocks.map((block) => [block.id, block.type, block.title])).toEqual([
      ["orientation", "narrative", "Start the disposable session"],
      ["editor-practice", "editor-practice", "Draft the editor artifact"],
      ["exact-command", "terminal-practice", "Run the exact command"],
      ["clue-only", "terminal-practice", "Use the clues"],
      ["reflection", "reflection", "Reflection"],
      ["transition", "lesson-transition", "Finish the evaluator fixture"]
    ]);

    const editorPractice = chapter.lesson.blocks[1]!;
    if (editorPractice.type !== "editor-practice") throw new Error("editor-practice must be editor-practice");
    expect(editorPractice.path).toBe("editor-artifacts/evaluator-editor.txt");
    expect(editorPractice.markdown).toContain("editor-artifacts/evaluator-editor.txt");
    expect(editorPractice.tutor).toContain("Private editor criterion");
    expect(editorPractice.markdown).not.toContain("Private editor criterion");

    const exactCommand = chapter.lesson.blocks[2]!;
    if (exactCommand.type !== "terminal-practice") throw new Error("exact-command must be terminal-practice");
    expect(exactCommand.markdown).toContain("```sh command\nmkdir -p .tmp && printf 'command block complete\\n' > .tmp/evaluator-command.txt && cat .tmp/evaluator-command.txt\n```");
    expect(exactCommand.tutor).toContain("private tutor guidance");
    expect(exactCommand.markdown).not.toContain("private tutor guidance");

    const clueOnly = chapter.lesson.blocks[3]!;
    if (clueOnly.type !== "terminal-practice") throw new Error("clue-only must be terminal-practice");
    expect(clueOnly.markdown).toContain("Create `.tmp/evaluator-clue.txt`");
    expect(clueOnly.markdown).toContain("print it back with a command that reads the file");
    expect(clueOnly.markdown).not.toContain("```sh command");
    expect(clueOnly.tutor).toContain("Do not reveal an exact command");

    const reflection = chapter.lesson.blocks[4]!;
    if (reflection.type !== "reflection") throw new Error("reflection must be reflection");
    expect(reflection.markdown).toContain("Which terminal block gave you an exact command");
    expect(reflection.tutor).toContain("Follow up");

    const transition = chapter.lesson.blocks[5]!;
    expect(transition.type).toBe("lesson-transition");
    expect(transition.markdown).toContain("The live evaluator has enough signal");
    expect((transition as any).tutor).toBeUndefined();
  });
});
