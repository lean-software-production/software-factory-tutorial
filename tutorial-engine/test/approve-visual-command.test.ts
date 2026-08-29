import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// approve:visual is a plain Node ESM script so npm can run it without a TypeScript loader.
// @ts-ignore TS has no declaration file for that script.
const approvalCommand = await import("../../scripts/approve-visual.mjs");
const { APPROVAL_ENVIRONMENT_MESSAGE, approveVisual, assertCanonicalApprovalEnvironment } = approvalCommand;

const sandboxes: string[] = [];

async function visualRootWithReceived(name = "activity-band"): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "approve-visual-"));
  sandboxes.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, `${name}.approved.png`), "old approved\n");
  await writeFile(resolve(dir, `${name}.received.png`), "new received\n");
  return dir;
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("visual approval command", () => {
  it("accepts the canonical repository devcontainer environment", () => {
    expect(() => assertCanonicalApprovalEnvironment({ inContainer: true, canonical: true })).not.toThrow();
  });

  it.each([
    { label: "host", state: { inContainer: false, canonical: false } },
    { label: "noncanonical container", state: { inContainer: true, canonical: false } },
  ])("refuses on $label before renaming received screenshots", async ({ state }) => {
    const visualRoot = await visualRootWithReceived();

    await expect(approveVisual({ visualRoot, state, log: vi.fn() })).rejects.toThrow(APPROVAL_ENVIRONMENT_MESSAGE);

    await expect(readFile(resolve(visualRoot, "activity-band.received.png"), "utf8")).resolves.toBe("new received\n");
    await expect(readFile(resolve(visualRoot, "activity-band.approved.png"), "utf8")).resolves.toBe("old approved\n");
  });

  it("renames received screenshots only after the canonical guard passes", async () => {
    const visualRoot = await visualRootWithReceived("reading-line");
    const log = vi.fn();

    await expect(approveVisual({ visualRoot, state: { inContainer: true, canonical: true }, log })).resolves.toBe(1);

    await expect(readFile(resolve(visualRoot, "reading-line.approved.png"), "utf8")).resolves.toBe("new received\n");
    await expect(readFile(resolve(visualRoot, "reading-line.received.png"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(log).toHaveBeenCalledWith("Approved reading-line.approved.png");
  });
});
