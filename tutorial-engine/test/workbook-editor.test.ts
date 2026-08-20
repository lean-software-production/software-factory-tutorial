import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorPracticeBlock } from "../src/workbook/contract.js";
import { EditorDraftStore, EditorReviewAdapter, type EditorReviewSessionFactory, resolveEditorTarget } from "../src/workbook/editor.js";

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

describe("EditorDraftStore", () => {
  it("keeps drafts separate from targets, reloads the newest revision, and promotes only the approved draft", async () => {
    const workspace = await temporaryWorkspace("workbook-editor-drafts-");
    const store = new EditorDraftStore(workspace);
    const block: EditorPracticeBlock = {
      id: "block-id",
      type: "editor-practice",
      title: "Refactor the line",
      markdown: "Edit the draft.",
      path: "factory/refactor.md",
      tutor: "private criteria"
    };

    await store.write("lesson-id", block.id, 1, "first draft");
    await store.write("lesson-id", block.id, 2, "second draft");

    await expect(access(resolve(workspace, "factory/refactor.md"))).rejects.toThrow();
    await expect(store.read("lesson-id", block.id)).resolves.toEqual({ revision: 2, text: "second draft" });

    const approvedDraft = { revision: 3, text: "approved draft" };
    await store.promote(block, approvedDraft);

    await expect(readFile(resolve(workspace, "factory/refactor.md"), "utf8")).resolves.toBe("approved draft");
  });
});

describe("EditorReviewAdapter", () => {
  it("sends only the private brief and draft to the reviewer prompt", async () => {
    const workspacePathThatMustNotLeak = "/private/workspace/path";
    const privateBrief = "Pass only when the draft names the validator boundary.";
    const draft = { revision: 2, text: "current learner draft" };
    const seenPrompts: string[] = [];
    const factory: EditorReviewSessionFactory = async () => ({
      async prompt(prompt) {
        seenPrompts.push(prompt);
        return "Name the boundary explicitly.";
      }
    });

    const result = await new EditorReviewAdapter(factory).review({ lessonId: "lesson-id", blockId: "block-id", privateBrief, draft });

    expect(result).toEqual({ status: "feedback", message: "Name the boundary explicitly." });
    expect(seenPrompts).toHaveLength(1);
    expect(JSON.parse(seenPrompts[0]!)).toEqual({ privateBrief, draft });
    expect(seenPrompts[0]).not.toContain(workspacePathThatMustNotLeak);
  });

  it("returns unlocked when the reviewer calls unlock_editor_practice for the current revision", async () => {
    const factory: EditorReviewSessionFactory = async ({ customTools }) => ({
      async prompt() {
        await customTools[0]!.execute("tool-call", { revisionId: 4 }, undefined, undefined, {} as never);
        return "";
      }
    });

    await expect(new EditorReviewAdapter(factory).review({
      lessonId: "lesson-id",
      blockId: "block-id",
      privateBrief: "Approve the exact draft.",
      draft: { revision: 4, text: "approved text" }
    })).resolves.toEqual({ status: "unlocked", revisionId: 4 });
  });

  it("rejects unlock calls for stale revisions as feedback", async () => {
    const factory: EditorReviewSessionFactory = async ({ customTools }) => ({
      async prompt() {
        await customTools[0]!.execute("tool-call", { revisionId: 3 }, undefined, undefined, {} as never);
        return "looks good";
      }
    });

    const result = await new EditorReviewAdapter(factory).review({
      lessonId: "lesson-id",
      blockId: "block-id",
      privateBrief: "Approve the exact draft.",
      draft: { revision: 4, text: "newer text" }
    });

    expect(result.status).toBe("feedback");
    expect(result).toMatchObject({ message: expect.stringMatching(/current revision|stale/i) });
  });

  it("exposes no built-in tools and exactly one bounded unlock tool", async () => {
    const seenToolRequests: Array<Parameters<EditorReviewSessionFactory>[0]> = [];
    const factory: EditorReviewSessionFactory = async (request) => {
      seenToolRequests.push(request);
      return { async prompt() { return "Keep revising."; } };
    };

    await new EditorReviewAdapter(factory).review({
      lessonId: "lesson-id",
      blockId: "block-id",
      privateBrief: "Approve the exact draft.",
      draft: { revision: 1, text: "draft" }
    });

    expect(seenToolRequests).toHaveLength(1);
    expect(seenToolRequests[0]!.tools).toEqual([]);
    expect(seenToolRequests[0]!.customTools.map((tool) => tool.name)).toEqual(["unlock_editor_practice"]);
    expect(seenToolRequests[0]!.customTools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "grep", "find", "ls"]));
    expect(JSON.stringify(seenToolRequests[0]!.customTools[0]!.parameters)).toContain('"minimum":1');
  });
});
