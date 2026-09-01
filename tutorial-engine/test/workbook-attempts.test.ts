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

  it("lets editor revisions supersede accepted active attempts while protecting reflection acceptance", async () => {
    const workspace = await temporaryWorkspace("workbook-attempt-accepted-revision-");
    const store = new AttemptStore(workspace);

    const editor = await store.create({ lessonId: "lesson-id", blockId: "editor-block", evidence: { kind: "editor", text: "accepted editor draft" } });
    await store.acceptCurrent(editor.id, "Editor accepted.");
    await expect(store.create({ lessonId: "lesson-id", blockId: "editor-block", evidence: { kind: "editor", text: "newer editor draft" } })).resolves.toMatchObject({ version: 2, status: "working", evidence: { kind: "editor", text: "newer editor draft" } });
    await expect(store.read(editor.id)).resolves.toMatchObject({ status: "superseded", evidence: { kind: "editor", text: "accepted editor draft" } });
    await expect(store.current("lesson-id", "editor-block")).resolves.toMatchObject({ status: "working", evidence: { kind: "editor", text: "newer editor draft" } });

    const reflection = await store.create({ lessonId: "lesson-id", blockId: "reflection-block", evidence: { kind: "reflection", response: "Accepted reflection.", conversation: [] } });
    await store.acceptCurrent(reflection.id, "Reflection accepted.");
    await expect(store.create({ lessonId: "lesson-id", blockId: "reflection-block", evidence: { kind: "reflection", response: "Second reflection.", conversation: [] } })).rejects.toThrow(/accepted work/i);
    await expect(store.current("lesson-id", "reflection-block")).resolves.toMatchObject({ id: reflection.id, status: "accepted" });
  });

  it("lists every versioned attempt for a block in ascending version order", async () => {
    const workspace = await temporaryWorkspace("workbook-attempt-history-");
    const attempts = new AttemptStore(workspace);

    await attempts.create({ lessonId: "lesson", blockId: "editor", evidence: { kind: "editor", text: "first" } });
    await attempts.create({ lessonId: "lesson", blockId: "editor", evidence: { kind: "editor", text: "second" } });
    await attempts.create({ lessonId: "lesson", blockId: "editor", evidence: { kind: "editor", text: "third" } });

    expect(await attempts.list("lesson", "editor")).toMatchObject([
      { version: 1, status: "superseded", evidence: { kind: "editor", text: "first" } },
      { version: 2, status: "superseded", evidence: { kind: "editor", text: "second" } },
      { version: 3, status: "working", evidence: { kind: "editor", text: "third" } },
    ]);
  });
});
