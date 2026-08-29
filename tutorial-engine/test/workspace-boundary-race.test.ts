import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBoundary } from "../src/workbook/workspace-boundary.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "workspace-boundary-race-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const outside = join(parent, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  const target = join(workspace, "race.txt");
  const outsideSecret = join(outside, "secret.txt");
  await writeFile(target, "inside contents\n", "utf8");
  await writeFile(outsideSecret, "outside secret\n", "utf8");
  return { workspace, target, outsideSecret };
}

async function replaceWithEscapingSymlink(target: string, outsideSecret: string): Promise<void> {
  await rm(target, { force: true });
  await symlink(outsideSecret, target);
}

async function restoreInsideFile(target: string): Promise<void> {
  await rm(target, { force: true });
  await writeFile(target, "inside restored\n", "utf8");
}

describe("WorkspaceBoundary read races", () => {
  it("does not leak outside contents when the resolved pathname is swapped before the read opens it", async () => {
    const { workspace, target, outsideSecret } = await fixture();
    const boundary = await WorkspaceBoundary.create(workspace);
    const originalResolve = WorkspaceBoundary.prototype.resolve;
    let swapped = false;
    vi.spyOn(WorkspaceBoundary.prototype, "resolve").mockImplementation(async function (this: WorkspaceBoundary, rawPath: string, forWrite?: boolean) {
      const resolved = await originalResolve.call(this, rawPath, forWrite);
      if (!swapped && rawPath === "race.txt" && !forWrite) {
        swapped = true;
        await replaceWithEscapingSymlink(target, outsideSecret);
      }
      return resolved;
    });

    const result = await boundary.readFile("race.txt").then(
      (buffer) => buffer.toString("utf8"),
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );

    expect(result).not.toContain("outside secret");
  });

  it("rejects when the opened file is outside even if the path is swapped back before validation", async () => {
    const { workspace, target, outsideSecret } = await fixture();
    const boundary = await WorkspaceBoundary.create(workspace);
    const originalResolve = WorkspaceBoundary.prototype.resolve;
    let resolveCount = 0;
    vi.spyOn(WorkspaceBoundary.prototype, "resolve").mockImplementation(async function (this: WorkspaceBoundary, rawPath: string, forWrite?: boolean) {
      if (rawPath === "race.txt" && !forWrite && resolveCount === 1) await restoreInsideFile(target);
      const resolved = await originalResolve.call(this, rawPath, forWrite);
      if (rawPath === "race.txt" && !forWrite && resolveCount === 0) await replaceWithEscapingSymlink(target, outsideSecret);
      if (rawPath === "race.txt" && !forWrite) resolveCount += 1;
      return resolved;
    });

    await expect(boundary.readFile("race.txt")).rejects.toThrow(/changed|outside|stable/i);
  });

  it("does not validate an escaping descriptor through a pathname swapped between resolve and stat", async () => {
    const { workspace, target, outsideSecret } = await fixture();
    const boundary = await WorkspaceBoundary.create(workspace);
    const originalResolve = WorkspaceBoundary.prototype.resolve;
    let resolveCount = 0;
    vi.spyOn(WorkspaceBoundary.prototype, "resolve").mockImplementation(async function (this: WorkspaceBoundary, rawPath: string, forWrite?: boolean) {
      if (rawPath === "race.txt" && !forWrite && resolveCount > 0) await restoreInsideFile(target);
      const resolved = await originalResolve.call(this, rawPath, forWrite);
      if (rawPath === "race.txt" && !forWrite) {
        await replaceWithEscapingSymlink(target, outsideSecret);
        resolveCount += 1;
      }
      return resolved;
    });

    const result = await boundary.readFile("race.txt").then(
      (buffer) => buffer.toString("utf8"),
      (error: unknown) => error instanceof Error ? error.message : String(error)
    );

    expect(result).not.toContain("outside secret");
  });
});
