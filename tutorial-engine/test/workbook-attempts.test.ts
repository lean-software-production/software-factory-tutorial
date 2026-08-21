import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttemptStore } from "../src/workbook/attempts.js";

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

describe("AttemptStore", () => {
  it("keeps immutable evidence snapshots and accepts only the current attempt", async () => {
    const workspace = await temporaryWorkspace("workbook-attempts-");
    const store = new AttemptStore(workspace);

    const first = await store.create({
      lessonId: "part/lesson-id",
      blockId: "block-id",
      evidence: { kind: "editor", text: "first draft" }
    });
    const second = await store.create({
      lessonId: "part/lesson-id",
      blockId: "block-id",
      evidence: { kind: "editor", text: "second draft" }
    });

    expect(first).toMatchObject({ version: 1, status: "working", evidence: { kind: "editor", text: "first draft" } });
    expect(second).toMatchObject({ version: 2, status: "working", evidence: { kind: "editor", text: "second draft" } });
    await expect(store.read(first.id)).resolves.toMatchObject({ status: "superseded", evidence: { kind: "editor", text: "first draft" } });
    await expect(store.acceptCurrent(first.id, "Nice work.")).resolves.toBeUndefined();
    await expect(store.acceptCurrent(second.id, "Nice work.")).resolves.toMatchObject({ status: "accepted", successMessage: "Nice work." });
    await expect(store.current("part/lesson-id", "block-id")).resolves.toMatchObject({ id: second.id, status: "accepted" });
  });

  it("round-trips terminal and reflection evidence without changing it", async () => {
    const workspace = await temporaryWorkspace("workbook-attempt-evidence-");
    const store = new AttemptStore(workspace);

    const terminal = await store.create({
      lessonId: "lesson-id",
      blockId: "terminal-block",
      evidence: { kind: "terminal", transcript: "npm test\nPASS", terminalHtml: "<pre>npm test\nPASS</pre>" }
    });
    const reflection = await store.create({
      lessonId: "lesson-id",
      blockId: "reflection-block",
      evidence: { kind: "reflection", response: "The harness keeps the doer bounded.", conversation: [{ role: "learner", text: "Earlier thought" }] }
    });

    await expect(store.read(terminal.id)).resolves.toMatchObject({ evidence: terminal.evidence });
    await expect(store.read(reflection.id)).resolves.toMatchObject({ evidence: reflection.evidence });
  });
});
