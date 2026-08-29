import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorPracticeBlock } from "../src/workbook/contract.js";
import { AttemptStore } from "../src/workbook/attempts.js";
import { promoteAcceptedEditorAttempt, promoteCurrentEditorAttempt, resolveEditorTarget } from "../src/workbook/editor.js";

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

  it("resolves authored editor paths beneath the active live workspace only", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-scoped-target-");

    const target = await resolveEditorTarget(workspace, "spec.md");

    expect(target).toBe(resolve(await realpath(workspace), "spec.md"));
  });

  it("rejects traversal, absolute paths, tutor state, temp paths, git internals, and escaping symlinks", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-unsafe-");
    const outside = await temporaryWorkspace("workbook-editor-outside-");
    await mkdir(resolve(workspace, "factory"), { recursive: true });
    await symlink(outside, resolve(workspace, "factory/escape"));

    for (const path of ["../x", "/tmp/x", ".git/config", ".tutorial/state", ".tmp/output", "factory/escape/refactor.md"]) {
      await expect(resolveEditorTarget(workspace, path), path).rejects.toThrow(/outside|reserved|unsafe|absolute|symlink/i);
    }
  });

  it("rejects escaping symlinks inside the active live workspace", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-scoped-unsafe-");
    const outside = await temporaryWorkspace("workbook-editor-scoped-outside-");
    await symlink(outside, resolve(workspace, "escape"));

    await expect(resolveEditorTarget(workspace, "escape/spec.md")).rejects.toThrow(/symlink/i);
  });

  it("rejects final-file and parent-directory symlinks, including symlinks to .git", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-git-symlink-");
    await mkdir(resolve(workspace, ".git"));
    await mkdir(resolve(workspace, "factory"));
    await writeFile(resolve(workspace, ".git/config"), "repo metadata\n", "utf8");
    await symlink(resolve(workspace, ".git/config"), resolve(workspace, "factory/answer.md"));

    await expect(resolveEditorTarget(workspace, "factory/answer.md")).rejects.toThrow(/symlink/i);
    await expect(readFile(resolve(workspace, ".git/config"), "utf8")).resolves.toBe("repo metadata\n");

    await symlink(resolve(workspace, ".git"), resolve(workspace, "factory/git-parent"));
    await expect(resolveEditorTarget(workspace, "factory/git-parent/config")).rejects.toThrow(/symlink/i);
    await expect(readFile(resolve(workspace, ".git/config"), "utf8")).resolves.toBe("repo metadata\n");
  });
});

describe("promoteCurrentEditorAttempt", () => {
  it("promotes the current editor attempt before it is marked accepted", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-reviewing-attempt-");
    const attempts = new AttemptStore(workspace);
    const block: EditorPracticeBlock = {
      id: "block-id",
      type: "editor-practice",
      title: "Refactor the line",
      markdown: "Edit the draft.",
      path: "factory/refactor.md",
      outcome: "Refactor the line into the answer.",
      tutor: "private criteria"
    };

    const attempt = await attempts.create({ lessonId: "lesson-id", blockId: block.id, evidence: { kind: "editor", text: "accepted draft" } });
    await attempts.markReviewing(attempt.id);

    await expect(promoteCurrentEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block, attemptId: attempt.id })).resolves.toEqual({ path: resolve(await realpath(workspace), "factory/refactor.md") });
    await expect(readFile(resolve(workspace, "factory/refactor.md"), "utf8")).resolves.toBe("accepted draft");
    await expect(attempts.current("lesson-id", block.id)).resolves.toMatchObject({ id: attempt.id, status: "reviewing" });
  });

  it("promotes current editor attempts into the active live workspace", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-scoped-attempt-");
    const attempts = new AttemptStore(workspace);
    const block: EditorPracticeBlock = {
      id: "block-id",
      type: "editor-practice",
      title: "Write the spec",
      markdown: "Edit the draft.",
      path: "spec.md",
      outcome: "Write the spec.",
      tutor: "private criteria"
    };

    const attempt = await attempts.create({ lessonId: "lesson-id", blockId: block.id, evidence: { kind: "editor", text: "scoped draft" } });
    await attempts.markReviewing(attempt.id);

    await expect(promoteCurrentEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block, attemptId: attempt.id })).resolves.toEqual({ path: resolve(await realpath(workspace), "spec.md") });
    await expect(readFile(resolve(workspace, "spec.md"), "utf8")).resolves.toBe("scoped draft");
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
      outcome: "Refactor the line into the answer.",
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
    const block: EditorPracticeBlock = { id: "block-id", type: "editor-practice", title: "Edit", markdown: "Edit.", path: "factory/refactor.md", outcome: "Edit the draft.", tutor: "private" };
    const terminal = await attempts.create({ lessonId: "lesson-id", blockId: block.id, evidence: { kind: "terminal", transcript: "pass", terminalHtml: "<pre>pass</pre>" } });
    await attempts.acceptCurrent(terminal.id, "Terminal accepted.");

    await expect(promoteAcceptedEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block, attemptId: terminal.id })).resolves.toBeUndefined();
    await expect(access(resolve(workspace, "factory/refactor.md"))).rejects.toThrow();
  });

  it("rejects accepted promotion through final-file and parent-directory symlinks without changing .git", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-promote-git-symlink-");
    const attempts = new AttemptStore(workspace);
    await mkdir(resolve(workspace, ".git"));
    await mkdir(resolve(workspace, "factory"));
    await writeFile(resolve(workspace, ".git/config"), "repo metadata\n", "utf8");
    const block: EditorPracticeBlock = { id: "block-id", type: "editor-practice", title: "Edit", markdown: "Edit.", path: "factory/refactor.md", outcome: "Edit the draft.", tutor: "private" };
    const attempt = await attempts.create({ lessonId: "lesson-id", blockId: block.id, evidence: { kind: "editor", text: "malicious overwrite" } });
    await attempts.acceptCurrent(attempt.id, "Accepted.");

    await symlink(resolve(workspace, ".git/config"), resolve(workspace, "factory/refactor.md"));
    await expect(promoteAcceptedEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block, attemptId: attempt.id })).rejects.toThrow(/symlink|too many levels/i);
    await expect(readFile(resolve(workspace, ".git/config"), "utf8")).resolves.toBe("repo metadata\n");
    await rm(resolve(workspace, "factory/refactor.md"));

    await symlink(resolve(workspace, ".git"), resolve(workspace, "factory/git-parent"));
    const parentBlock = { ...block, path: "factory/git-parent/config" };
    await expect(promoteAcceptedEditorAttempt({ workspace, attempts, lessonId: "lesson-id", block: parentBlock, attemptId: attempt.id })).rejects.toThrow(/symlink/i);
    await expect(readFile(resolve(workspace, ".git/config"), "utf8")).resolves.toBe("repo metadata\n");
  });
});
