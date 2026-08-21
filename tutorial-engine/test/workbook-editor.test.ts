import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorPracticeBlock } from "../src/workbook/contract.js";
import { AttemptStore } from "../src/workbook/attempts.js";
import { promoteAcceptedEditorAttempt, resolveEditorTarget } from "../src/workbook/editor.js";

const tempDirs: string[] = [];

async function temporaryWorkspace(stem: string): Promise<string> {
  const workspace = await mkdtemp(resolve(tmpdir(), stem));
  tempDirs.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("resolveEditorTarget", () => {
  it("resolves authored editor paths beneath the workspace", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-target-");
    await mkdir(resolve(workspace, "factory"), { recursive: true });

    const target = await resolveEditorTarget(workspace, "factory/refactor.md");

    expect(target).toBe(resolve(await realpath(workspace), "factory/refactor.md"));
  });

  it("rejects traversal, absolute paths, tutor state, temp paths, git internals, and escaping symlinks", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-unsafe-");
    const outside = await temporaryWorkspace("workbook-editor-outside-");
    await mkdir(resolve(workspace, "factory"), { recursive: true });
    await symlink(outside, resolve(workspace, "factory/escape"));

    for (const path of ["../x", "/tmp/x", ".git/config", ".tutorial/state", ".tmp/output", "factory/escape/refactor.md"]) {
      await expect(resolveEditorTarget(workspace, path), path).rejects.toThrow(/outside|reserved|unsafe|absolute/i);
    }
  });
});

describe("promoteAcceptedEditorAttempt", () => {
  it("promotes only the accepted current editor attempt", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-attempts-");
    const attempts = new AttemptStore(workspace);
    const block: EditorPracticeBlock = {
      id: "block-id",
      type: "editor-practice",
      title: "Refactor the line",
      markdown: "Edit the draft.",
      path: "factory/refactor.md",
      tutor: "private criteria"
    };

    const first = await attempts.create({ lessonId: "lesson-id", blockId: block.id, evidence: { kind: "editor", text: "first draft" } });
    const second = await attempts.create({ lessonId: "lesson-id", blockId: block.id, evidence: { kind: "editor", text: "accepted draft" } });
    await attempts.acceptCurrent(second.id, "Looks good.");

    await expect(promoteAcceptedEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block, attemptId: first.id })).resolves.toBeUndefined();
    await expect(access(resolve(workspace, "factory/refactor.md"))).rejects.toThrow();

    await expect(promoteAcceptedEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block, attemptId: second.id })).resolves.toEqual({ path: resolve(await realpath(workspace), "factory/refactor.md") });
    await expect(readFile(resolve(workspace, "factory/refactor.md"), "utf8")).resolves.toBe("accepted draft");
  });

  it("does not promote accepted attempts for another evidence kind", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-non-editor-");
    const attempts = new AttemptStore(workspace);
    const block: EditorPracticeBlock = { id: "block-id", type: "editor-practice", title: "Edit", markdown: "Edit.", path: "factory/refactor.md", tutor: "private" };
    const terminal = await attempts.create({ lessonId: "lesson-id", blockId: block.id, evidence: { kind: "terminal", transcript: "pass", terminalHtml: "<pre>pass</pre>" } });
    await attempts.acceptCurrent(terminal.id, "Terminal accepted.");

    await expect(promoteAcceptedEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block, attemptId: terminal.id })).resolves.toBeUndefined();
    await expect(access(resolve(workspace, "factory/refactor.md"))).rejects.toThrow();
  });
});
