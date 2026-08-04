import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceTools, WorkspaceBoundary } from "../src/agent/workspace-boundary.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-boundary-")); roots.push(root);
  await mkdir(join(root, "inside")); await writeFile(join(root, "inside/file.txt"), "safe");
  await writeFile(join(root, "README.md"), "safe workspace");
  return root;
}

describe("WorkspaceBoundary", () => {
  it("returns workspace-relative paths and permits nested writes", async () => {
    const root = await fixture(); const boundary = await WorkspaceBoundary.create(root);
    await boundary.writeFile("inside/new/file.txt", "written");
    await expect(boundary.readFile("inside/new/file.txt")).resolves.toEqual(Buffer.from("written"));
    await expect(boundary.resolve("inside/file.txt")).resolves.toMatchObject({ relative: "inside/file.txt" });
  });

  it("rejects parent traversal and an escaping symlink", async () => {
    const root = await fixture(); const outside = await mkdtemp(join(tmpdir(), "workspace-outside-")); roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret"); await symlink(outside, join(root, "escape"));
    const boundary = await WorkspaceBoundary.create(root);
    await expect(boundary.readFile("../secret.txt")).rejects.toThrow("outside");
    await expect(boundary.readFile("escape/secret.txt")).rejects.toThrow("outside");
  });

  it("moves a file into a new folder and audits both ends as a mutation", async () => {
    // Lesson 005 opens with a move, and read/write/edit together can copy a file
    // but never retire the original. This is the tool that makes that step
    // possible for a delegating tutor.
    const root = await fixture(); const boundary = await WorkspaceBoundary.create(root);
    const audits: Array<{ tool: string; paths: string[]; mutation: boolean; outcome: string }> = [];
    const tools = createWorkspaceTools(root, boundary, (event) => audits.push(event));
    const move = tools.find((tool) => tool.name === "move")!;

    await expect(move.execute("move-1", { path: "inside/file.txt", destination: "line/moved.txt" }, undefined, undefined, undefined))
      .resolves.toMatchObject({ content: [{ type: "text", text: "Moved inside/file.txt to line/moved.txt" }] });
    await expect(boundary.readFile("line/moved.txt")).resolves.toEqual(Buffer.from("safe"));
    await expect(boundary.exists("inside/file.txt")).resolves.toBe(false);
    expect(audits).toEqual([{ type: "audit", id: "move-1", tool: "move", paths: ["inside/file.txt", "line/moved.txt"], mutation: true, outcome: "ok" }]);
  });

  it("refuses a move whose destination leaves the workspace, or is already occupied", async () => {
    const root = await fixture(); const outside = await mkdtemp(join(tmpdir(), "workspace-outside-")); roots.push(outside);
    await symlink(outside, join(root, "escape"));
    const boundary = await WorkspaceBoundary.create(root);
    const audits: Array<{ paths: string[]; outcome: string }> = [];
    const tools = createWorkspaceTools(root, boundary, (event) => audits.push(event));
    const move = tools.find((tool) => tool.name === "move")!;

    await expect(move.execute("out", { path: "inside/file.txt", destination: "../stolen.txt" }, undefined, undefined, undefined)).rejects.toThrow("outside");
    await expect(move.execute("symlinked-out", { path: "inside/file.txt", destination: "escape/stolen.txt" }, undefined, undefined, undefined)).rejects.toThrow("outside");
    // A move relocates; it must not become a way to destroy a file.
    await expect(move.execute("occupied", { path: "inside/file.txt", destination: "README.md" }, undefined, undefined, undefined)).rejects.toThrow("already exists");
    await expect(boundary.readFile("README.md")).resolves.toEqual(Buffer.from("safe workspace"));
    await expect(boundary.exists("inside/file.txt")).resolves.toBe(true);
    expect(audits.map((event) => event.outcome)).toEqual(["rejected", "rejected", "error"]);
  });

  it("uses the canonical workspace for native tools when the supplied workspace is an alias", async () => {
    const root = await fixture();
    const alias = `${root}-alias`; roots.push(alias);
    const outside = await mkdtemp(join(tmpdir(), "workspace-outside-")); roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    await symlink(root, alias);
    const boundary = await WorkspaceBoundary.create(alias);
    const audits: Array<{ outcome: string }> = [];
    const tools = createWorkspaceTools(alias, boundary, (event) => audits.push(event));
    const read = tools.find((tool) => tool.name === "read")!;
    const ls = tools.find((tool) => tool.name === "ls")!;

    await expect(read.execute("read-alias", { path: "README.md" }, undefined, undefined, undefined)).resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("safe workspace") }] });
    await expect(ls.execute("ls-alias", {}, undefined, undefined, undefined)).resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("README.md") }] });
    await expect(read.execute("read-escape", { path: "../secret.txt" }, undefined, undefined, undefined)).rejects.toThrow("outside");
    await expect(read.execute("read-symlink-escape", { path: "escape/secret.txt" }, undefined, undefined, undefined)).rejects.toThrow("outside");
    expect(audits.map((event) => event.outcome)).toEqual(["ok", "ok", "rejected", "rejected"]);
  });
});
