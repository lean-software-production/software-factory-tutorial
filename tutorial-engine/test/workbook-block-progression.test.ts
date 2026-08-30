import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(), practiceCoach: fakePracticeCoach() });
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
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor, practiceCoach: fakePracticeCoach() });
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

      const restarted = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(), practiceCoach: fakePracticeCoach() });
      try {
        const restored = await fetch(`${restarted.url}/api/workbook/state`).then((response) => response.json() as any);
        expect(restored.progress.activeBlockId).toBe("lesson--001-first--edit-answer");
        expect(restored.progress.workAcceptedBlocks).toContain("lesson--001-first--edit-answer");
        expect(restored.progress.readyBlocks).toEqual(["lesson--001-first--finish"]);
        expect(block(restored, "lesson--001-first--finish")).toMatchObject({ ready: true, active: false, completed: false });
      } finally { await restarted.close(); }
    } finally { await server.close(); }
  });

  it("renders completed jump prerequisites and keeps the target evaluation evidence-gated", async () => {
    const dir = await fixture();
    const loaded = await loadWorkbook(dir);
    await initializeLessonJump(tutorialStatePath(dir), loaded, resolveLessonJump(loaded, "001"));
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(undefined, { outcome: "complete-block", blockId: "lesson--001-first--edit-answer" }), practiceCoach: fakePracticeCoach() });
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
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor, practiceCoach: fakePracticeCoach() });
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
      expect(records).not.toContainEqual(expect.objectContaining({ type: "block_summarized", blockId: "lesson--001-first--orientation" }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "block_summarized", blockId: "lesson--001-first--finish" }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "tutor_failed" }));
    } finally { await server.close(); }
  });

  it("does not write late summaries or failures after closing during completion compaction", async () => {
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
      const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: tutor, practiceCoach: fakePracticeCoach() });
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
          expect.objectContaining({ type: "workbook_completion_summary" }),
          expect.objectContaining({ type: "tutor_failed" })
        ]));
      } finally {
        await server.close().catch(() => undefined);
      }
    }
  });

  it("promotes the same ready successor by button or tutor and duplicate crossings cannot skip", async () => {
    const dir = await fixture();
    const server = await startWorkbookServer({ target: dir, webRoot: resolve(dir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(), practiceCoach: fakePracticeCoach() });
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
    const tutorServer = await startWorkbookServer({ target: tutorDir, webRoot: resolve(tutorDir, "web"), embeddedTerminal: false, mainTutor: fakeTutor(undefined, { outcome: "complete-block", blockId: "workbook--introduction" }), practiceCoach: fakePracticeCoach() });
    try {
      const response = await postMessage(tutorServer.url, { blockId: "workbook--introduction", text: "I'm ready to continue." });
      expect(response.status).toBe(202);
      const advanced = await response.json() as any;
      expect(advanced.progress.activeBlockId).toBe("part--validation-loop");
      expect(advanced.progress.completedBlocks).toContain("workbook--introduction");
    } finally { await tutorServer.close(); }
  });
});

async function complete(serverUrl: string, blockId: string) {
  const response = await fetch(`${serverUrl}/api/workbook/complete-block`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ blockId }) });
  expect(response.status).toBe(202);
  return response.json() as Promise<any>;
}

async function postMessage(serverUrl: string, body: unknown) {
  return fetch(`${serverUrl}/api/workbook/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function block(state: any, id: string) { return state.progress.blocks.find((candidate: any) => candidate.id === id); }
function authoredCourseBlocks(state: any): string[] { return state.timeline.filter((record: any) => record.type === "message" && record.source === "authored" && record.presentation === "course").map((record: any) => record.blockId); }
async function timelineRecords(dir: string): Promise<WorkbookTimelineRecord[]> {
  const text = await readFile(tutorialStatePath(dir, "workbook", "events.jsonl"), "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as WorkbookTimelineRecord);
}
async function workAcceptedEvents(dir: string, blockId: string) {
  return (await timelineRecords(dir)).filter((record) => record.type === "work_accepted" && record.blockId === blockId);
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

function fakeTutor(decision: any = { outcome: "working" }, reply: any = "Tutor reply."): any {
  return { restore: async () => undefined, reply: async () => reply, review: async () => decision, summarizeBlock: async () => "Block summary.", summarizeLesson: async () => "Lesson summary.", dispose() {} };
}

function fakePracticeCoach(): any {
  return { assess: async () => ({ outcome: "ready", text: "Ready for main review." }), dispose() {} };
}
