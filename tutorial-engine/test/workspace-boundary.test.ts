import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceBoundary } from "../src/workbook/workspace-boundary.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-boundary-")); roots.push(root);
  await mkdir(join(root, "inside"));
  await writeFile(join(root, "inside/file.txt"), "safe");
  await writeFile(join(root, "README.md"), "safe workspace");
  return root;
}

describe("WorkspaceBoundary", () => {
  it("resolves and reads ordinary workspace-relative files through a canonical root", async () => {
    const root = await fixture();
    const alias = `${root}-alias`; roots.push(alias);
    await symlink(root, alias);
    const boundary = await WorkspaceBoundary.create(alias);

    await expect(boundary.readFile("inside/file.txt")).resolves.toEqual(Buffer.from("safe"));
    await expect(boundary.resolve("inside/./file.txt")).resolves.toMatchObject({ relative: "inside/file.txt" });
    expect(isAbsolute(boundary.root)).toBe(true);
    await expect(boundary.readdir(".")).resolves.toEqual(expect.arrayContaining(["README.md", "inside"]));
  });

  it("rejects absolute paths, parent traversal with either separator, and invalid characters", async () => {
    const root = await fixture();
    const boundary = await WorkspaceBoundary.create(root);

    await expect(boundary.readFile(resolve(root, "README.md"))).rejects.toThrow(/absolute/i);
    await expect(boundary.readFile("C:\\outside\\secret.txt")).rejects.toThrow(/absolute/i);
    await expect(boundary.readFile("\\\\server\\share\\secret.txt")).rejects.toThrow(/absolute/i);
    await expect(boundary.readFile("../secret.txt")).rejects.toThrow(/outside/i);
    await expect(boundary.readFile("inside\\..\\..\\secret.txt")).rejects.toThrow(/outside/i);
    await expect(boundary.readFile("inside/\0secret.txt")).rejects.toThrow(/invalid/i);
  });

  it("allows a static symlink that stays inside and rejects one that escapes", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "workspace-outside-")); roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink(join(root, "inside/file.txt"), join(root, "inside-link.txt"));
    await symlink(outside, join(root, "escape"));
    const boundary = await WorkspaceBoundary.create(root);

    await expect(boundary.readFile("inside-link.txt")).resolves.toEqual(Buffer.from("safe"));
    await expect(boundary.readFile("escape/secret.txt")).rejects.toThrow(/outside/i);
    await expect(boundary.stat("escape/secret.txt")).rejects.toThrow(/outside/i);
  });
});
