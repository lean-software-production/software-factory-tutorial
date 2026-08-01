import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetFactory, TutorialSessionLog } from "../src/session-log.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (workspace) => {
    const { rm } = await import("node:fs/promises");
    await rm(workspace, { recursive: true, force: true });
  }));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tutorial-session-"));
  workspaces.push(root);
  await mkdir(join(root, "factory"));
  return root;
}

describe("TutorialSessionLog", () => {
  it("persists protocol events and loads them in order", async () => {
    const root = await workspace();
    const log = new TutorialSessionLog(root);

    log.append({ type: "user-message", markdown: "I made success.md." });
    log.append({ type: "assistant-message", messageId: "assistant-1", markdown: "Great. Next, write the doer prompt." });
    await log.flush();

    expect(await log.exists()).toBe(true);
    await expect(log.read()).resolves.toEqual([
      { type: "user-message", markdown: "I made success.md." },
      { type: "assistant-message", messageId: "assistant-1", markdown: "Great. Next, write the doer prompt." }
    ]);
  });

  it("starts over by removing factory artifacts and the saved transcript", async () => {
    const root = await workspace();
    await writeFile(join(root, "factory", ".gitkeep"), "");
    await writeFile(join(root, "factory", "success.md"), "criteria");
    await mkdir(join(root, "factory", "scratch"));
    await writeFile(join(root, "factory", "scratch", "note.txt"), "temporary");
    const log = new TutorialSessionLog(root);
    log.append({ type: "user-message", markdown: "temporary work" });
    await log.flush();

    await resetFactory(root);

    expect((await readdir(join(root, "factory"))).sort()).toEqual([".gitkeep"]);
    expect(await log.exists()).toBe(false);
  });
});
