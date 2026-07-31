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
