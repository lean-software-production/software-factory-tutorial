import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbook } from "../src/workbook/load.js";
import { startWorkbookServer } from "../src/workbook/server.js";
import { tutorialStatePath } from "../src/workbook/tutorial-state.js";
import { DefaultMainWorkbookTutor, type WorkbookTutorSessionFactoryRequest } from "../src/workbook/tutor.js";
import { WorkbookTimeline, type WorkbookTimelineRecord } from "../src/workbook/timeline.js";
import { initializeLessonJump, resolveLessonJump } from "../src/workbook/lesson-jump.js";
import { buildWorkbookBlockStream } from "../src/workbook/workbook-blocks.js";

let dirs: string[] = [];

async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-block-progression-")); dirs.push(dir);
  await mkdir(resolve(dir, "parts"), { recursive: true });
  await mkdir(resolve(dir, "lessons/001-first/blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), ["---", "parts:", "  - id: validation-loop", "    lessons:", "      - 001-first", "---", "# Demo workbook", "", "Welcome."].join("\n"));
  await writeFile(resolve(dir, "parts/validation-loop.md"), ["---", "---", "# Validation loop", "", "Part preamble."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/lesson.md"), ["---", "durationMinutes: 5", "workspace: refactor-line", "blocks:", "  - orientation", "  - edit-answer", "  - finish", "---", "# Run an agent headlessly", "", "Lesson preamble.", "", "Full lesson introduction before declared blocks."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/orientation.md"), ["---", "type: narrative", "---", "## Orientation", "", "Read this."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/edit-answer.md"), ["---", "type: editor-practice", "outcome: Write a clear answer to the question.", "path: factory/answer.txt", "tutor: Accept any clear answer.", "---", "## Edit answer", "", "Write the answer."].join("\n"));
  await mkdir(resolve(dir, "workspaces/refactor-line/factory"), { recursive: true });
  await writeFile(resolve(dir, "workspaces/refactor-line/factory/answer.txt"), "");
  await writeFile(resolve(dir, "lessons/001-first/blocks/finish.md"), ["---", "type: narrative", "---", "## Finish", "", "Done."].join("\n"));
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
}

async function terminalLifecycleFixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-terminal-lifecycle-")); dirs.push(dir);
  await mkdir(resolve(dir, "parts"), { recursive: true });
  await mkdir(resolve(dir, "lessons/001-first/blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), ["---", "parts:", "  - id: validation-loop", "    lessons:", "      - 001-first", "---", "# Demo workbook", "", "Welcome."].join("\n"));
  await writeFile(resolve(dir, "parts/validation-loop.md"), ["---", "---", "# Validation loop", "", "Part preamble."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/lesson.md"), ["---", "durationMinutes: 5", "workspace: refactor-line", "blocks:", "  - orientation", "  - run-command", "  - edit-answer", "  - finish", "---", "# Run an agent headlessly", "", "Lesson preamble."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/orientation.md"), ["---", "type: narrative", "---", "## Orientation", "", "Read this."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/run-command.md"), ["---", "type: terminal-practice", "outcome: Run the acceptance command.", "tutor: Accept a passing command.", "---", "## Run command", "", "Run this:", "", "```sh command", "npm test", "```"].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/edit-answer.md"), ["---", "type: editor-practice", "outcome: Write a clear answer to the question.", "path: factory/answer.txt", "tutor: Accept any clear answer.", "---", "## Edit answer", "", "Write the answer."].join("\n"));
  await mkdir(resolve(dir, "workspaces/refactor-line/factory"), { recursive: true });
  await writeFile(resolve(dir, "workspaces/refactor-line/factory/answer.txt"), "");
  await writeFile(resolve(dir, "lessons/001-first/blocks/finish.md"), ["---", "type: narrative", "---", "## Finish", "", "Done."].join("\n"));
  await mkdir(resolve(dir, "web")); await writeFile(resolve(dir, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
  return dir;
}

afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook block progression", () => {
  it("builds structural and declared blocks with canonical anchors in one stream", async () => {
    const loaded = await loadWorkbook(await fixture());
    const stream = buildWorkbookBlockStream(loaded);
    expect(stream.map((block) => [block.origin, block.kind, block.id, block.anchorId])).toEqual([
      ["structural", "workbook-introduction", "workbook--introduction", "workbook--introduction"],
      ["structural", "part-preamble", "part--validation-loop", "part--validation-loop"],
      ["structural", "lesson-preamble", "lesson--001-first", "lesson--001-first"],
      ["declared", "narrative", "lesson--001-first--orientation", "lesson--001-first--orientation"],
      ["declared", "editor-practice", "lesson--001-first--edit-answer", "lesson--001-first--edit-answer"],
      ["declared", "narrative", "lesson--001-first--finish", "lesson--001-first--finish"],
    ]);
    const lessonPreamble = stream.find((block) => block.kind === "lesson-preamble");
    expect(lessonPreamble?.markdown).toContain("Lesson preamble.\n\n## What you will learn\n\n- Write a clear answer to the question.\n\nFull lesson introduction before declared blocks.");
    expect(lessonPreamble?.markdown.split("Full lesson introduction before declared blocks.")).toHaveLength(2);
    expect(stream.filter((block) => block.title === "Full lesson introduction before declared blocks.")).toEqual([]);
  });

  it("completes exact current blocks idempotently and rejects skipping unrevealed blocks", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const initial = await fetch(`${server.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(initial.progress.activeBlockId).toBe("workbook--introduction");
      expect(initial.progress.canComplete).toMatchObject({ blockId: "workbook--introduction", eligible: true });
      expect(initial.progress.workAcceptedBlocks).toEqual(["workbook--introduction"]);
      expect(initial.progress.readyBlocks).toEqual(["part--validation-loop"]);
      expect(initial.revealedBlockIds).toEqual(["workbook--introduction"]);
      expect(initial.renderedBlockIds).toEqual(["workbook--introduction", "part--validation-loop"]);
      expect(block(initial, "workbook--introduction")).toMatchObject({ active: true, ready: false, completed: false, workAccepted: true });
      expect(block(initial, "part--validation-loop")).toMatchObject({ active: false, ready: true, completed: false, emerged: true });

      const skipped = await complete(server.url, "lesson--001-first--orientation");
      expect(skipped).toMatchObject({ outcome: "rejected", reason: "unrevealed" });
      expect(skipped.state.progress.activeBlockId).toBe("workbook--introduction");

      const intro = await complete(server.url, "workbook--introduction");
      expect(intro).toMatchObject({ outcome: "completed", navigationTarget: "part--validation-loop" });
      expect(intro.state.progress.completedBlocks).toContain("workbook--introduction");
      expect(block(intro.state, "workbook--introduction")?.completedAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(block(intro.state, "workbook--introduction")?.completedAt))).toBe(true);
      expect(intro.state.progress.activeBlockId).toBe("part--validation-loop");
      expect(intro.state.progress.readyBlocks).toEqual(["lesson--001-first"]);
      expect(block(intro.state, "part--validation-loop")).toMatchObject({ active: true, ready: false, completed: false, workAccepted: true });

      const duplicate = await complete(server.url, "workbook--introduction");
      expect(duplicate).toMatchObject({ outcome: "already-completed" });
      expect(duplicate.state.progress.activeBlockId).toBe("part--validation-loop");
    } finally { await server.close(); }
  });

  it("accepts evaluated evidence once, renders exactly one ready successor, and reconstructs it after restart", async () => {
    const dir = await fixture();
    const tutor = fakeTutor({ outcome: "accepted", message: "Accepted editor answer." });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor });
    try {
      await complete(server.url, "workbook--introduction");
      await complete(server.url, "part--validation-loop");
      await complete(server.url, "lesson--001-first");
      await complete(server.url, "lesson--001-first--orientation");
      const opened = await fetch(`${server.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(opened.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      expect(opened.progress.readyBlocks).toEqual([]);

      const draft = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", text: "The answer is 42." }) });
      expect(draft.status).toBe(202);
      // The checkpoint status flips before the projection that follows it: workAcceptedBlocks, the
      // ready successor and its authored course row are all filled afterwards. Waiting on the
      // status alone let the assertions below read a state where only the status had landed, which
      // is why this failed intermittently as "expected [] to have a length of 1". Each clause here
      // waits for a value to ARRIVE; the assertions still check its exact shape, so a duplicate or
      // a wrong successor is still a failure.
      const accepted = await waitForState(server.url, (next) =>
        block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted"
        && next.progress.workAcceptedBlocks.includes("lesson--001-first--edit-answer")
        && next.progress.readyBlocks.length > 0
        && authoredCourseBlocks(next).includes("lesson--001-first--finish"));
      expect(accepted.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      expect(accepted.progress.workAcceptedBlocks.filter((id: string) => id === "lesson--001-first--edit-answer")).toHaveLength(1);
      expect(accepted.progress.readyBlocks).toEqual(["lesson--001-first--finish"]);
      expect(block(accepted, "lesson--001-first--finish")).toMatchObject({ ready: true, active: false, completed: false, emerged: true });
      await waitForRecords(dir, (records) => records.some((record) => record.type === "work_accepted" && record.blockId === "lesson--001-first--edit-answer"), "the work_accepted record for the editor block");
      // Exactly one, not merely at least one: the wait above only proves a record arrived, and a
      // duplicated append is a real failure this catches — verified by appending twice, which gives
      // "expected [ …(2) ] to have a length of 1".
      expect(await workAcceptedEvents(dir, "lesson--001-first--edit-answer")).toHaveLength(1);
      expect(authoredCourseBlocks(accepted).filter((id: string) => id === "lesson--001-first--finish")).toHaveLength(1);

      const restarted = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
      try {
        const restored = await fetch(`${restarted.url}/api/workbook/state`).then((response) => response.json() as any);
        expect(restored.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
        expect(restored.progress.workAcceptedBlocks).toContain("lesson--001-first--edit-answer");
        expect(restored.progress.readyBlocks).toEqual(["lesson--001-first--finish"]);
        expect(block(restored, "lesson--001-first--finish")).toMatchObject({ ready: true, active: false, completed: false });
      } finally { await restarted.close(); }
    } finally { await server.close(); }
  });

  it("keeps accepted editor practice active, editable in public state, and ineligible after a newer revision until reaccepted", async () => {
    const dir = await fixture();
    let accepted = true;
    const tutor = fakeTutor(undefined);
    tutor.review = async () => accepted ? { outcome: "accepted", message: "Accepted editor answer." } : { outcome: "feedback", message: "Revise the newer draft." };
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor });
    try {
      await advanceToEditor(server.url);
      const first = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", revision: 1, text: "accepted editor text" }) });
      expect(first.status).toBe(202);
      const activeAccepted = await waitForState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted");
      expect(block(activeAccepted, "lesson--001-first--edit-answer")).toMatchObject({ active: true, completed: false, draftText: "accepted editor text", editorStatus: "accepted" });
      expect(activeAccepted.progress.canComplete).toMatchObject({ blockId: "lesson--001-first--edit-answer", eligible: true });
      expect(activeAccepted.progress.readyBlocks).toEqual(["lesson--001-first--finish"]);

      accepted = false;
      const second = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", revision: 2, text: "newer unaccepted editor text" }) });
      expect(second.status).toBe(202);
      const reviewing = await second.json() as any;
      expect(block(reviewing, "lesson--001-first--edit-answer")).toMatchObject({ active: true, completed: false, draftText: "newer unaccepted editor text", editorStatus: "reviewing" });
      expect(reviewing.progress.canComplete).toMatchObject({ blockId: "lesson--001-first--edit-answer", eligible: false, reason: "awaiting-acceptance" });

      accepted = true;
      const third = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", revision: 3, text: "reaccepted editor text" }) });
      expect(third.status).toBe(202);
      const reaccepted = await waitForState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.revision === 3 && block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted");
      expect(reaccepted.progress.canComplete).toMatchObject({ blockId: "lesson--001-first--edit-answer", eligible: true });
    } finally { await server.close(); }
  });

  it("emits editor content snapshots and restores completed history from the latest accepted matching snapshot", async () => {
    const dir = await fixture();
    const blockId = "lesson--001-first--edit-answer";
    let firstAttemptId = "";
    let secondAttemptId = "";
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor({ outcome: "accepted", message: "Accepted editor answer." }) });
    try {
      await advanceToEditor(server.url);

      const first = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision: 1, text: "v1 accepted editor text" }) });
      expect(first.status).toBe(202);
      const firstRecords = await waitForRecords(dir, (records) => {
        const acceptance = acceptedAttempts(records, blockId).find((record) => record.version === 1);
        return Boolean(acceptance && editorSnapshots(records, blockId).some((snapshot) => snapshot.attemptId === acceptance.attemptId && snapshot.text === "v1 accepted editor text"));
      }, "the first editor acceptance snapshot");
      const firstAcceptance = acceptedAttempts(firstRecords, blockId).find((record) => record.version === 1)!;
      firstAttemptId = firstAcceptance.attemptId;
      expect(editorSnapshots(firstRecords, blockId).find((record) => record.attemptId === firstAttemptId)).toMatchObject({
        type: "editor-content-snapshotted",
        attemptId: firstAttemptId,
        lessonId: "001-first",
        blockId,
        text: "v1 accepted editor text",
      });

      const second = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision: 2, text: "v2 accepted editor text" }) });
      expect(second.status).toBe(202);
      const secondRecords = await waitForRecords(dir, (records) => {
        const acceptance = acceptedAttempts(records, blockId).find((record) => record.version === 2);
        return Boolean(acceptance && editorSnapshots(records, blockId).some((snapshot) => snapshot.attemptId === acceptance.attemptId && snapshot.text === "v2 accepted editor text"));
      }, "the second editor acceptance snapshot");
      const secondAcceptance = acceptedAttempts(secondRecords, blockId).find((record) => record.version === 2)!;
      secondAttemptId = secondAcceptance.attemptId;
      expect(secondAttemptId).not.toBe(firstAttemptId);
      expect(editorSnapshots(secondRecords, blockId).find((record) => record.attemptId === secondAttemptId)).toMatchObject({
        type: "editor-content-snapshotted",
        attemptId: secondAttemptId,
        lessonId: "001-first",
        blockId,
        text: "v2 accepted editor text",
      });
    } finally { await server.close(); }

    await appendRawTimelineRecords(dir, [
      { type: "editor-content-snapshotted", attemptId: "orphan-editor-attempt", lessonId: "001-first", blockId, text: "ORPHAN EDITOR SNAPSHOT" },
      { type: "editor-content-snapshotted", attemptId: firstAttemptId, lessonId: "001-first", blockId, text: "STALE V1 EDITOR SNAPSHOT" },
    ]);

    const restarted = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const completed = await complete(restarted.url, blockId);
      expect(block(completed.state, blockId)).toMatchObject({
        active: false,
        completed: true,
        draftText: "v2 accepted editor text",
        editorStatus: "accepted",
        checkpoint: { status: "accepted", successMessage: "Accepted editor answer.", evidence: { kind: "editor", text: "v2 accepted editor text" } }
      });
      expect(JSON.stringify(completed.state)).not.toContain("ORPHAN EDITOR SNAPSHOT");
      expect(JSON.stringify(completed.state)).not.toContain("STALE V1 EDITOR SNAPSHOT");
    } finally { await restarted.close(); }

    await rm(tutorialStatePath(dir, "workbook", "attempts"), { recursive: true, force: true });
    const restoredServer = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const restored = await fetch(`${restoredServer.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(block(restored, blockId)).toMatchObject({
        active: false,
        completed: true,
        draftText: "v2 accepted editor text",
        editorStatus: "accepted",
        checkpoint: { status: "accepted", successMessage: "Accepted editor answer.", evidence: { kind: "editor", text: "v2 accepted editor text" } }
      });
      expect(JSON.stringify(restored)).not.toContain("ORPHAN EDITOR SNAPSHOT");
      expect(JSON.stringify(restored)).not.toContain("STALE V1 EDITOR SNAPSHOT");
    } finally { await restoredServer.close(); }
  });

  it("uses latest durable terminal submission and accepted snapshot, not old work_accepted, for completion eligibility across restart", async () => {
    const dir = await terminalLifecycleFixture();
    await writeTerminalLifecycleRecords(dir, [
      { type: "block_completed", blockId: "workbook--introduction" },
      { type: "block_completed", blockId: "part--validation-loop" },
      { type: "block_completed", blockId: "lesson--001-first" },
      { type: "block_completed", blockId: "lesson--001-first--orientation" },
      terminalSubmitted("attempt-1", "npm test"),
      terminalFinished("attempt-1", "npm test", "v1 PASS"),
      { type: "terminal-transcript-snapshotted", attemptId: "attempt-1", lessonId: "001-first", blockId: "lesson--001-first--run-command", transcript: "v1 PASS" },
      { type: "attempt_accepted", attemptId: "attempt-1", lessonId: "001-first", blockId: "lesson--001-first--run-command", version: 1, kind: "terminal", summary: "Accepted v1." },
      { type: "work_accepted", blockId: "lesson--001-first--run-command" },
      terminalSubmitted("attempt-2", "npm test --again"),
      terminalFinished("attempt-2", "npm test --again", "v2 awaiting review"),
    ]);

    const reviewing = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const state = await fetch(`${reviewing.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(block(state, "lesson--001-first--run-command")).toMatchObject({ active: true, completed: false, terminal: { phase: "checking" }, terminalRevision: 2 });
      expect(state.progress.canComplete).toMatchObject({ blockId: "lesson--001-first--run-command", eligible: false, reason: "awaiting-acceptance" });
      expect(state.progress.readyBlocks).toEqual(["lesson--001-first--edit-answer"]);
    } finally { await reviewing.close(); }

    await writeTerminalLifecycleRecords(dir, [
      { type: "terminal-transcript-snapshotted", attemptId: "orphan", lessonId: "001-first", blockId: "lesson--001-first--run-command", transcript: "ORPHAN SNAPSHOT" },
      { type: "terminal-transcript-snapshotted", attemptId: "attempt-2", lessonId: "001-first", blockId: "lesson--001-first--run-command", transcript: "v2 accepted transcript" },
      { type: "attempt_accepted", attemptId: "attempt-2", lessonId: "001-first", blockId: "lesson--001-first--run-command", version: 2, kind: "terminal", summary: "Accepted v2." },
      { type: "work_accepted", blockId: "lesson--001-first--run-command" },
      { type: "block_completed", blockId: "lesson--001-first--run-command", lessonId: "001-first" },
    ]);
    const completed = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const state = await fetch(`${completed.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(block(state, "lesson--001-first--run-command")).toMatchObject({ active: false, completed: true, terminal: { phase: "accepted", message: "Accepted v2." }, terminalRevision: 2, terminalSnapshot: { transcript: "v2 accepted transcript" } });
      expect(JSON.stringify(state)).not.toContain("ORPHAN SNAPSHOT");
    } finally { await completed.close(); }
  });

  it("keeps completion ineligible after restart when a newer terminal submission from an old session is unfinished", async () => {
    const dir = await terminalLifecycleFixture();
    const blockId = "lesson--001-first--run-command";
    await writeTerminalLifecycleRecords(dir, [
      { type: "block_completed", blockId: "workbook--introduction" },
      { type: "block_completed", blockId: "part--validation-loop" },
      { type: "block_completed", blockId: "lesson--001-first" },
      { type: "block_completed", blockId: "lesson--001-first--orientation" },
      terminalSubmitted("attempt-1", "npm test", "old-terminal-session"),
      terminalFinished("attempt-1", "npm test", "v1 PASS"),
      { type: "terminal-transcript-snapshotted", attemptId: "attempt-1", lessonId: "001-first", blockId, transcript: "v1 PASS" },
      { type: "attempt_accepted", attemptId: "attempt-1", lessonId: "001-first", blockId, version: 1, kind: "terminal", summary: "Accepted v1." },
      { type: "work_accepted", blockId },
      terminalSubmitted("attempt-2", "npm test --again", "old-terminal-session"),
    ]);

    const restarted = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const state = await fetch(`${restarted.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(block(state, blockId)).toMatchObject({ active: true, completed: false });
      expect(block(state, blockId)?.terminal).toBeUndefined();
      expect(state.progress.canComplete).toMatchObject({ blockId, eligible: false, reason: "awaiting-acceptance" });
      expect(state.progress.readyBlocks).toEqual(["lesson--001-first--edit-answer"]);
      await expect(complete(restarted.url, blockId)).resolves.toMatchObject({ outcome: "rejected", reason: "ineligible" });
    } finally { await restarted.close(); }
  });

  it("renders completed jump prerequisites and keeps the target evaluation evidence-gated", async () => {
    const dir = await fixture();
    const loaded = await loadWorkbook(dir);
    await initializeLessonJump(tutorialStatePath(dir), loaded, resolveLessonJump(loaded, "001"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(undefined, { outcome: "complete-block", blockId: "lesson--001-first--edit-answer" }) });
    try {
      const opened = await fetch(`${server.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(opened.progress.activeBlockId).toBe("lesson--001-first");
      expect(opened.progress.completedBlocks).toEqual(["workbook--introduction", "part--validation-loop"]);
      expect(opened.timeline.filter((record: any) => record.type === "message" && record.source === "authored").map((record: any) => record.blockId)).toEqual([
        "workbook--introduction", "part--validation-loop", "lesson--001-first", "lesson--001-first--orientation"
      ]);
      expect(opened.adapter).not.toHaveProperty("testOnlyJump");

      await complete(server.url, "lesson--001-first");
      await complete(server.url, "lesson--001-first--orientation");
      expect((await complete(server.url, "lesson--001-first--edit-answer"))).toMatchObject({ outcome: "rejected", reason: "ineligible" });

      const afterMoveOn = await postMessage(server.url, { blockId: "lesson--001-first--edit-answer", text: "move on" }).then((response) => response.json() as any);
      expect(afterMoveOn.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
      expect(await timelineRecords(dir)).toEqual(expect.not.arrayContaining([expect.objectContaining({ type: "block_skipped" })]));
    } finally { await server.close(); }
  });

  it("does not compact declared narratives, but still summarizes evaluated departures and benign lesson no-ops", async () => {
    const dir = await fixture();
    const compactInstructions: string[] = [];
    const tutor = new DefaultMainWorkbookTutor({ workspace: dir, sessionFactory: async (request: WorkbookTutorSessionFactoryRequest) => ({
      async prompt(prompt: string) {
        if (prompt.includes("WORKBOOK ATTEMPT REVIEW")) {
          await (request.customTools.find((tool: any) => tool.name === "accept_current_attempt") as any).execute("tool-call", {});
          return "Accepted editor answer.";
        }
        return "Tutor reply.";
      },
      async compact(instruction: string) {
        compactInstructions.push(instruction);
        if (instruction.includes("completed workbook lesson")) throw new Error("Nothing to compact (session too small)");
        return { summary: "Compacted edit block." };
      },
      dispose() {}
    }) });
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor });
    try {
      await complete(server.url, "workbook--introduction");
      await complete(server.url, "part--validation-loop");
      await complete(server.url, "lesson--001-first");
      await complete(server.url, "lesson--001-first--orientation");
      expect(compactInstructions).toEqual([]);

      const draft = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", text: "The answer is 42." }) });
      expect(draft.status).toBe(202);
      await waitForState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted");
      await complete(server.url, "lesson--001-first--edit-answer");
      expect(compactInstructions.filter((instruction) => instruction.includes("completed workbook block"))).toHaveLength(1);
      expect(compactInstructions[0]).toContain("lesson--001-first--edit-answer");

      await complete(server.url, "lesson--001-first--finish");
      const blockCompactions = compactInstructions.filter((instruction) => instruction.includes("completed workbook block"));
      expect(blockCompactions).toHaveLength(1);
      expect(blockCompactions.join("\n")).not.toContain("orientation");
      expect(blockCompactions.join("\n")).not.toContain("finish");

      // compactInstructions is filled when the fake's compact() is called; the summary records are
      // appended after it returns, so read the log only once both are actually there.
      const records = await waitForRecords(
        dir,
        (candidates) => candidates.some((record) => record.type === "block_summarized" && record.blockId === "lesson--001-first--edit-answer") && candidates.some((record) => record.type === "lesson_summarized"),
        "the block and lesson summary records"
      );
      expect(records).toContainEqual(expect.objectContaining({ type: "block_summarized", lessonId: "001-first", blockId: "lesson--001-first--edit-answer", text: "Compacted edit block." }));
      expect(records).toContainEqual(expect.objectContaining({ type: "lesson_summarized", lessonId: "001-first" }));
      expect(records).toContainEqual(expect.objectContaining({ type: "workbook_completion_summary" }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "block_summarized", blockId: "lesson--001-first--orientation" }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "block_summarized", blockId: "lesson--001-first--finish" }));

      const blockSummaryIndex = records.findIndex((record) => record.type === "block_summarized" && record.blockId === "lesson--001-first--edit-answer");
      const editorCompletionIndex = records.findIndex((record) => record.type === "block_completed" && record.blockId === "lesson--001-first--edit-answer");
      const lessonSummaryIndex = records.findIndex((record) => record.type === "lesson_summarized" && record.lessonId === "001-first");
      const workbookSummaryIndex = records.findIndex((record) => record.type === "workbook_completion_summary");
      const finalCompletionIndex = records.findIndex((record) => record.type === "block_completed" && record.blockId === "lesson--001-first--finish");
      expect(blockSummaryIndex).toBeLessThan(editorCompletionIndex);
      expect(lessonSummaryIndex).toBeLessThan(finalCompletionIndex);
      expect(workbookSummaryIndex).toBeLessThan(finalCompletionIndex);
      const blockSummary = records[blockSummaryIndex] as Extract<WorkbookTimelineRecord, { type: "block_summarized" }>;
      const lessonSummary = records[lessonSummaryIndex] as Extract<WorkbookTimelineRecord, { type: "lesson_summarized" }>;
      expect(blockSummary.coveredThroughId).toBe(records[blockSummaryIndex - 1]?.id);
      expect(lessonSummary.coveredThroughId).toBe(records[lessonSummaryIndex - 1]?.id);
    } finally { await server.close(); }
  });

  it("leaves progression incomplete when a required block, lesson, or workbook summary fails", async () => {
    for (const stage of ["block", "lesson", "workbook"] as const) {
      const dir = await fixture();
      const tutor = {
        ...fakeTutor({ outcome: "accepted", message: "Accepted editor answer." }),
        summarizeBlock: async () => {
          if (stage === "block") throw new Error("private block summary failure");
          return "Block summary.";
        },
        summarizeLesson: async (input: { lessonId: string }) => {
          if (stage === "lesson" && input.lessonId === "001-first") throw new Error("private lesson summary failure");
          if (stage === "workbook" && input.lessonId === "workbook") throw new Error("private workbook summary failure");
          return "Lesson summary.";
        }
      };
      const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor });
      try {
        await complete(server.url, "workbook--introduction");
        await complete(server.url, "part--validation-loop");
        await complete(server.url, "lesson--001-first");
        await complete(server.url, "lesson--001-first--orientation");
        const draft = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", text: `answer before ${stage} summary failure` }) });
        expect(draft.status).toBe(202);
        await waitForState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted");

        const failingBlockId = stage === "block" ? "lesson--001-first--edit-answer" : "lesson--001-first--finish";
        if (stage !== "block") await complete(server.url, "lesson--001-first--edit-answer");
        const response = await fetch(`${server.url}/api/workbook/complete-block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: failingBlockId }) });
        expect(response.status).toBe(409);

        const failed = await fetch(`${server.url}/api/workbook/state`).then((result) => result.json() as any);
        expect(failed.fatal?.message).toMatch(/restart/i);
        expect(failed.progress.activeBlockId).toBe(failingBlockId);
        expect(block(failed, failingBlockId)?.completed).toBe(false);
        expect(JSON.stringify(failed)).not.toContain(`private ${stage} summary failure`);

        const records = await timelineRecords(dir);
        expect(records).not.toContainEqual(expect.objectContaining({ type: "block_completed", blockId: failingBlockId }));
        if (stage === "block") expect(records).not.toContainEqual(expect.objectContaining({ type: "block_summarized", blockId: failingBlockId }));
        if (stage === "lesson") expect(records).not.toContainEqual(expect.objectContaining({ type: "lesson_summarized", lessonId: "001-first" }));
        if (stage === "workbook") {
          expect(records).not.toContainEqual(expect.objectContaining({ type: "lesson_summarized", lessonId: "001-first" }));
          expect(records).not.toContainEqual(expect.objectContaining({ type: "workbook_completion_summary" }));
        }
      } finally { await server.close(); }
    }
  });

  it("regenerates a block summary after restart when the following lesson summary had failed", async () => {
    const dir = await fixture();
    const lessonPath = resolve(dir, "lessons/001-first/lesson.md");
    await writeFile(lessonPath, (await readFile(lessonPath, "utf8")).replace("  - finish\n", ""));
    await rm(resolve(dir, "lessons/001-first/blocks/finish.md"));
    const failingTutor = {
      ...fakeTutor({ outcome: "accepted", message: "Accepted editor answer." }),
      summarizeBlock: async () => "Durable block summary.",
      summarizeLesson: async (input: { lessonId: string }) => {
        if (input.lessonId === "001-first") throw new Error("private lesson summary failure");
        return "Workbook summary.";
      }
    };
    const first = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: failingTutor });
    try {
      await complete(first.url, "workbook--introduction");
      await complete(first.url, "part--validation-loop");
      await complete(first.url, "lesson--001-first");
      await complete(first.url, "lesson--001-first--orientation");
      const draft = await fetch(`${first.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", text: "answer before restart" }) });
      expect(draft.status).toBe(202);
      await waitForState(first.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted");
      const failed = await fetch(`${first.url}/api/workbook/complete-block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer" }) });
      expect(failed.status).toBe(409);
      const partial = await timelineRecords(dir);
      expect(partial.filter((record) => record.type === "block_summarized" && record.blockId === "lesson--001-first--edit-answer")).toHaveLength(0);
      expect(partial).not.toContainEqual(expect.objectContaining({ type: "lesson_summarized", lessonId: "001-first" }));
      expect(partial).not.toContainEqual(expect.objectContaining({ type: "block_completed", blockId: "lesson--001-first--edit-answer" }));
    } finally { await first.close(); }

    const restarted = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor({ outcome: "accepted", message: "Accepted editor answer." }) });
    try {
      const completed = await complete(restarted.url, "lesson--001-first--edit-answer");
      expect(completed.state.progress.workbookComplete).toBe(true);
      const records = await timelineRecords(dir);
      expect(records.filter((record) => record.type === "block_summarized" && record.blockId === "lesson--001-first--edit-answer")).toHaveLength(1);
      const blockSummaryIndex = records.findIndex((record) => record.type === "block_summarized" && record.blockId === "lesson--001-first--edit-answer");
      const lessonSummaryIndex = records.findIndex((record) => record.type === "lesson_summarized" && record.lessonId === "001-first");
      const workbookSummaryIndex = records.findIndex((record) => record.type === "workbook_completion_summary");
      const completionIndex = records.findIndex((record) => record.type === "block_completed" && record.blockId === "lesson--001-first--edit-answer");
      const lessonSummary = records[lessonSummaryIndex] as Extract<WorkbookTimelineRecord, { type: "lesson_summarized" }>;
      expect(lessonSummary.coveredThroughId).toBe(records[blockSummaryIndex]?.id);
      expect(blockSummaryIndex).toBeLessThan(lessonSummaryIndex);
      expect(lessonSummaryIndex).toBeLessThan(workbookSummaryIndex);
      expect(workbookSummaryIndex).toBeLessThan(completionIndex);
    } finally { await restarted.close(); }
  });

  it("regenerates a lesson summary after restart when the following workbook summary had failed", async () => {
    const dir = await fixture();
    const failingTutor = {
      ...fakeTutor({ outcome: "accepted", message: "Accepted editor answer." }),
      summarizeLesson: async (input: { lessonId: string }) => {
        if (input.lessonId === "workbook") throw new Error("private workbook summary failure");
        return "Durable lesson summary.";
      }
    };
    const first = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: failingTutor });
    try {
      await complete(first.url, "workbook--introduction");
      await complete(first.url, "part--validation-loop");
      await complete(first.url, "lesson--001-first");
      await complete(first.url, "lesson--001-first--orientation");
      const draft = await fetch(`${first.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", text: "answer before final restart" }) });
      expect(draft.status).toBe(202);
      await waitForState(first.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted");
      await complete(first.url, "lesson--001-first--edit-answer");
      const failed = await fetch(`${first.url}/api/workbook/complete-block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--finish" }) });
      expect(failed.status).toBe(409);
      const partial = await timelineRecords(dir);
      expect(partial.filter((record) => record.type === "lesson_summarized" && record.lessonId === "001-first")).toHaveLength(0);
      expect(partial).not.toContainEqual(expect.objectContaining({ type: "workbook_completion_summary" }));
      expect(partial).not.toContainEqual(expect.objectContaining({ type: "block_completed", blockId: "lesson--001-first--finish" }));
    } finally { await first.close(); }

    const restarted = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const completed = await complete(restarted.url, "lesson--001-first--finish");
      expect(completed.state.progress.workbookComplete).toBe(true);
      const records = await timelineRecords(dir);
      expect(records.filter((record) => record.type === "lesson_summarized" && record.lessonId === "001-first")).toHaveLength(1);
      const lessonSummaryIndex = records.findIndex((record) => record.type === "lesson_summarized" && record.lessonId === "001-first");
      const workbookSummaryIndex = records.findIndex((record) => record.type === "workbook_completion_summary");
      const completionIndex = records.findIndex((record) => record.type === "block_completed" && record.blockId === "lesson--001-first--finish");
      expect(lessonSummaryIndex).toBeLessThan(workbookSummaryIndex);
      expect(workbookSummaryIndex).toBeLessThan(completionIndex);
    } finally { await restarted.close(); }
  });

  it("cancels slow accepted-editor completion when a newer editor submission arrives and keeps that draft", async () => {
    const dir = await fixture();
    const deferredSummary = deferred<string>();
    const tutor = new SummaryStallTutor("block", deferredSummary.promise);
    const blockId = "lesson--001-first--edit-answer";
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor });
    try {
      await advanceToEditor(server.url);
      const first = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision: 1, text: "accepted v1" }) });
      expect(first.status).toBe(202);
      await waitForState(server.url, (next) => block(next, blockId)?.checkpoint?.status === "accepted" && next.progress.canComplete?.eligible === true);

      const pendingCompletion = complete(server.url, blockId);
      await waitUntil(() => tutor.stalledCalls > 0);
      const pendingEditor = fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision: 2, text: "newer v2 while summary waits" }) });
      await sleep(20);
      expect(await timelineRecords(dir)).not.toContainEqual(expect.objectContaining({ type: "block_completed", blockId }));

      deferredSummary.resolve("Summary that should be discarded after invalidation.");
      const completion = await pendingCompletion;
      const editorResponse = await pendingEditor;
      expect(editorResponse.status).toBe(202);
      expect(completion).toMatchObject({ outcome: "rejected", reason: "not-current" });
      const afterEditor = await editorResponse.json() as any;
      expect(block(afterEditor, blockId)).toMatchObject({ active: true, completed: false, revision: 2, draftText: "newer v2 while summary waits" });
      await waitForState(server.url, (next) => block(next, blockId)?.revision === 2 && block(next, blockId)?.checkpoint?.status === "accepted");
      const records = await timelineRecords(dir);
      expect(records).not.toContainEqual(expect.objectContaining({ type: "block_completed", blockId }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "block_summarized", blockId, text: "Summary that should be discarded after invalidation." }));
    } finally { await server.close(); }
  });

  it("stages departure summaries so an invalidated last-editor completion leaves no stale summary", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/001-first/lesson.md"), ["---", "durationMinutes: 5", "workspace: refactor-line", "blocks:", "  - orientation", "  - edit-answer", "---", "# Run an agent headlessly", "", "Lesson preamble."].join("\n"));
    await rm(resolve(dir, "lessons/001-first/blocks/finish.md"), { force: true });
    const lessonSummary = deferred<string>();
    let stallFirstLessonSummary = true;
    const tutor = {
      stalledCalls: 0,
      async restore() {},
      async reply() { return "Tutor reply."; },
      async review() { return { outcome: "accepted" as const, message: "Accepted editor answer." }; },
      async summarizeBlock(input: any) {
        const attempt = input.activeContext?.attempts?.at(-1);
        const text = attempt?.evidence?.kind === "editor" ? attempt.evidence.text : "missing editor text";
        return `Block summary for ${text}`;
      },
      async summarizeLesson(input: any) {
        if (input.lessonId === "001-first" && stallFirstLessonSummary) {
          stallFirstLessonSummary = false;
          this.stalledCalls += 1;
          return lessonSummary.promise;
        }
        return `Lesson summary for ${input.lessonId}.`;
      },
      dispose() {}
    };
    const blockId = "lesson--001-first--edit-answer";
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor });
    try {
      await advanceToEditor(server.url);
      expect((await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision: 1, text: "accepted v1" }) })).status).toBe(202);
      await waitForState(server.url, (next) => block(next, blockId)?.checkpoint?.status === "accepted" && next.progress.canComplete?.eligible === true);

      const pendingCompletion = complete(server.url, blockId);
      await waitUntil(() => tutor.stalledCalls > 0);
      const pendingEditor = fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId, revision: 2, text: "accepted v2" }) });
      await sleep(20);
      lessonSummary.resolve("Stale lesson summary for v1.");
      await expect(pendingCompletion).resolves.toMatchObject({ outcome: "rejected", reason: "not-current" });
      expect((await pendingEditor).status).toBe(202);
      await waitForState(server.url, (next) => block(next, blockId)?.revision === 2 && block(next, blockId)?.checkpoint?.status === "accepted");
      expect(await timelineRecords(dir)).toEqual(expect.not.arrayContaining([
        expect.objectContaining({ type: "block_summarized", blockId }),
        expect.objectContaining({ type: "lesson_summarized", lessonId: "001-first" }),
        expect.objectContaining({ type: "workbook_completion_summary" })
      ]));

      const completed = await complete(server.url, blockId);
      expect(completed).toMatchObject({ outcome: "completed" });
      const records = await timelineRecords(dir);
      expect(records).toContainEqual(expect.objectContaining({ type: "block_summarized", blockId, text: "Block summary for accepted v2" }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "block_summarized", blockId, text: "Block summary for accepted v1" }));
      const blockSummaryIndex = records.findIndex((record) => record.type === "block_summarized" && record.blockId === blockId);
      const lessonSummaryIndex = records.findIndex((record) => record.type === "lesson_summarized" && record.lessonId === "001-first");
      const completionIndex = records.findIndex((record) => record.type === "block_completed" && record.blockId === blockId);
      expect(blockSummaryIndex).toBeLessThan(lessonSummaryIndex);
      expect(lessonSummaryIndex).toBeLessThan(completionIndex);
    } finally { await server.close(); }
  });

  it("does not write late summaries after closing during completion compaction", async () => {
    for (const [stall, outcome] of [
      ["block", "resolve"],
      ["block", "reject"],
      ["lesson", "resolve"],
      ["lesson", "reject"],
      ["workbook", "resolve"],
      ["workbook", "reject"],
    ] as const) {
      const dir = await fixture();
      const deferredSummary = deferred<string>();
      const tutor = new SummaryStallTutor(stall, deferredSummary.promise);
      const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor });
      try {
        await complete(server.url, "workbook--introduction");
        await complete(server.url, "part--validation-loop");
        await complete(server.url, "lesson--001-first");
        await complete(server.url, "lesson--001-first--orientation");
        const draft = await fetch(`${server.url}/api/workbook/editor`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId: "lesson--001-first--edit-answer", text: `answer for ${stall} ${outcome}` }) });
        expect(draft.status).toBe(202);
        await waitForState(server.url, (next) => block(next, "lesson--001-first--edit-answer")?.checkpoint?.status === "accepted");

        const pending = stall === "block"
          ? complete(server.url, "lesson--001-first--edit-answer")
          : (async () => {
            await complete(server.url, "lesson--001-first--edit-answer");
            return complete(server.url, "lesson--001-first--finish");
          })();
        const observedPending = pending.catch(() => undefined);
        await waitUntil(() => tutor.stalledCalls > 0);
        const beforeClose = await timelineRecords(dir);
        const startedClose = Date.now();
        await server.close();
        expect(Date.now() - startedClose).toBeLessThan(2_000);
        const afterClose = await timelineRecords(dir);
        expect(afterClose).toEqual(beforeClose);

        if (outcome === "resolve") deferredSummary.resolve("Late summary after close.");
        else deferredSummary.reject(new Error("disposed after close"));
        await observedPending;
        await sleep(50);
        expect(await timelineRecords(dir)).toEqual(beforeClose);
        expect(await timelineRecords(dir)).toEqual(expect.not.arrayContaining([
          expect.objectContaining({ type: "block_summarized", text: "Late summary after close." }),
          expect.objectContaining({ type: "lesson_summarized", text: "Late summary after close." }),
          expect.objectContaining({ type: "workbook_completion_summary" })
        ]));
      } finally {
        await server.close().catch(() => undefined);
      }
    }
  });

  it("promotes the same ready successor by button or tutor and duplicate crossings cannot skip", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor() });
    try {
      const initial = await fetch(`${server.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(initial.progress.readyBlocks).toEqual(["part--validation-loop"]);
      expect((await postMessage(server.url, { blockId: "part--validation-loop", text: "ready chat target?" })).status).toBe(409);

      const readyRequest = await complete(server.url, "part--validation-loop");
      expect(readyRequest).toMatchObject({ outcome: "rejected", reason: "not-current" });
      expect(readyRequest.state.progress.activeBlockId).toBe("workbook--introduction");

      const button = await complete(server.url, "workbook--introduction");
      expect(button).toMatchObject({ outcome: "completed", navigationTarget: "part--validation-loop" });
      expect(button.state.progress.activeBlockId).toBe("part--validation-loop");

      const duplicateCrossing = await complete(server.url, "workbook--introduction");
      expect(duplicateCrossing).toMatchObject({ outcome: "already-completed" });
      expect(duplicateCrossing.state.progress.activeBlockId).toBe("part--validation-loop");
    } finally { await server.close(); }

    const tutorDir = await fixture();
    const tutorServer = await startWorkbookServer({ target: tutorDir, webRoot: resolve(tutorDir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(undefined, { outcome: "complete-block", blockId: "workbook--introduction" }) });
    try {
      const response = await postMessage(tutorServer.url, { blockId: "workbook--introduction", text: "I'm ready to continue." });
      expect(response.status).toBe(202);
      const advanced = await response.json() as any;
      expect(advanced.progress.activeBlockId).toBe("part--validation-loop");
      expect(advanced.progress.completedBlocks).toContain("workbook--introduction");
    } finally { await tutorServer.close(); }
  });
});

async function advanceToEditor(serverUrl: string) {
  await complete(serverUrl, "workbook--introduction");
  await complete(serverUrl, "part--validation-loop");
  await complete(serverUrl, "lesson--001-first");
  await complete(serverUrl, "lesson--001-first--orientation");
}

async function complete(serverUrl: string, blockId: string) {
  const response = await fetch(`${serverUrl}/api/workbook/complete-block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId }) });
  expect(response.status).toBe(202);
  return response.json() as Promise<any>;
}

async function writeTerminalLifecycleRecords(dir: string, inputs: any[]) {
  const timeline = new WorkbookTimeline(dir);
  for (const input of inputs) await timeline.append(input);
}

function terminalSubmitted(attemptId: string, command: string, terminalSessionId = "terminal-session") {
  return { type: "terminal-command-submitted", attemptId, lessonId: "001-first", blockId: "lesson--001-first--run-command", command, terminalSessionId };
}

function terminalFinished(attemptId: string, command: string, output: string) {
  return { type: "terminal-command-finished", attemptId, evidence: { kind: "finished", command, interactions: [{ kind: "output", data: output }], exitStatus: 0 } };
}

async function postMessage(serverUrl: string, body: unknown) {
  return fetch(`${serverUrl}/api/workbook/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function block(state: any, id: string) { return state.progress.blocks.find((candidate: any) => candidate.id === id); }
function authoredCourseBlocks(state: any): string[] { return state.timeline.filter((record: any) => record.type === "message" && record.source === "authored" && record.presentation === "course").map((record: any) => record.blockId); }
async function timelineRecords(dir: string): Promise<WorkbookTimelineRecord[]> {
  const text = await readFile(tutorialStatePath(dir, "workbook", "events.jsonl"), "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.type !== "workbook-session-format") as WorkbookTimelineRecord[];
}
async function workAcceptedEvents(dir: string, blockId: string) {
  return (await timelineRecords(dir)).filter((record) => record.type === "work_accepted" && record.blockId === blockId);
}
function acceptedAttempts(records: readonly WorkbookTimelineRecord[], blockId: string) {
  return records.filter((record): record is Extract<WorkbookTimelineRecord, { type: "attempt_accepted" }> => record.type === "attempt_accepted" && record.blockId === blockId);
}
function editorSnapshots(records: readonly WorkbookTimelineRecord[], blockId: string) {
  return records.filter((record: any) => record.type === "editor-content-snapshotted" && record.blockId === blockId) as Array<{ type: "editor-content-snapshotted"; attemptId: string; lessonId: string; blockId: string; text: string }>;
}
async function appendRawTimelineRecords(dir: string, inputs: Array<Record<string, unknown>>) {
  const existing = await timelineRecords(dir).catch(() => []);
  const lines = inputs.map((input, index) => JSON.stringify({ id: `raw-test-event-${existing.length + index + 1}`, sequence: (existing.at(-1)?.sequence ?? 0) + index + 1, at: new Date().toISOString(), ...input }));
  await appendFile(tutorialStatePath(dir, "workbook", "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
}
/**
 * Polls the on-disk event log. The server writes an attempt's checkpoint status before appending
 * the matching record, and reads are served outside the timeline lock, so waiting on HTTP state and
 * then reading the log can see the status without the row that follows it.
 */
async function waitForRecords(dir: string, predicate: (records: Awaited<ReturnType<typeof timelineRecords>>) => boolean, description: string) {
  for (let index = 0; index < 50; index += 1) {
    const records = await timelineRecords(dir).catch(() => []);
    if (predicate(records)) return records;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function waitForState(serverUrl: string, predicate: (state: any) => boolean) {
  for (let index = 0; index < 50; index += 1) {
    const next = await fetch(`${serverUrl}/api/workbook/state`).then((response) => response.json() as any);
    if (predicate(next)) return next;
    await sleep(20);
  }
  throw new Error("Timed out waiting for workbook state.");
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error("Timed out waiting for condition.");
}

function sleep(ms: number) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolveDeferred = resolvePromise; rejectDeferred = rejectPromise; });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

class SummaryStallTutor {
  stalledCalls = 0;
  constructor(readonly stall: "block" | "lesson" | "workbook", readonly stalled: Promise<string>) {}
  async restore() {}
  async reply() { return "Tutor reply."; }
  async review() { return { outcome: "accepted" as const, message: "Accepted editor answer." }; }
  async summarizeBlock() {
    if (this.stall === "block") { this.stalledCalls += 1; return this.stalled; }
    return "Block summary.";
  }
  async summarizeLesson(input: { lessonId: string }) {
    if ((this.stall === "lesson" && input.lessonId === "001-first") || (this.stall === "workbook" && input.lessonId === "workbook")) {
      this.stalledCalls += 1;
      return this.stalled;
    }
    return "Lesson summary.";
  }
  dispose() {}
}

function fakeTutor(decision: any = { outcome: "feedback", message: "Keep going." }, reply: any = "Tutor reply."): any {
  return { restore: async () => undefined, reply: async () => reply, review: async () => decision, summarizeBlock: async () => "Block summary.", summarizeLesson: async () => "Lesson summary.", dispose() {} };
}
