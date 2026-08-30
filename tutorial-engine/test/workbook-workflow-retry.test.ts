import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttemptStore, type Attempt } from "../src/workbook/attempts.js";
import { TerminalEvidenceRepository } from "../src/workbook/terminal-evidence.js";
import { WorkbookTimeline, type TutorFailure, type WorkbookTimelineRecord } from "../src/workbook/timeline.js";
import { createWorkbookWorkflow } from "../src/workbook/workflow.js";

let dirs: string[] = [];

const EDIT_LESSON_ID = "001-first";
const EDIT_BLOCK_ID = "lesson--001-first--edit-answer";
const TERMINAL_BLOCK_ID = "lesson--001-first--run-command";
const WORKSPACE_ID = "refactor-line";

afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook workflow retry cancellation", () => {
  it("does not expose tutor terminal-failure feedback before its public retry handle", async () => {
    const dir = await fixture();
    const timeline = new BlockingTerminalFailureTimeline(dir);
    await seedActiveTerminalBlock(timeline);
    const workflow = await createWorkbookWorkflow({
      contentRoot: dir,
      workspaceRootForId: (workspaceId) => workspaceId === WORKSPACE_ID ? resolve(dir, "workspaces", WORKSPACE_ID) : undefined,
      timeline,
      attempts: new AttemptStore(dir),
      terminalEvidence: new TerminalEvidenceRepository(dir),
      mainTutor: failingReviewTutor(),
      practiceCoach: { assess: async () => ({ outcome: "ready" as const, text: "Ready for main review." }), dispose() {} },
      log: { info() {}, error() {} }
    });
    try {
      const stateEvents: unknown[] = [];
      workflow.subscribeState((event) => stateEvents.push(event));
      expect(workflow.activeObservedBlock()).toMatchObject({ lessonId: EDIT_LESSON_ID, blockId: TERMINAL_BLOCK_ID });
      await workflow.observeTerminalFact({ type: "terminal-command-submitted", blockId: TERMINAL_BLOCK_ID, attemptId: "terminal-attempt-1", command: "npm test" });
      await workflow.observeTerminalFact({
        type: "terminal-command-finished",
        blockId: TERMINAL_BLOCK_ID,
        attemptId: "terminal-attempt-1",
        evidence: { blockId: TERMINAL_BLOCK_ID, attemptId: "terminal-attempt-1", command: "npm test", interactions: [{ type: "terminal-output", data: "pass\n" }], exitStatus: 0 }
      });
      await waitUntil(() => timeline.terminalFailureFeedbackAppendReached);

      const duringGap = await workflow.state();
      const terminal = duringGap.progress.blocks.find((block: any) => block.id === TERMINAL_BLOCK_ID)?.terminal;
      expect(terminal).toEqual({ phase: "checking" });
      const publicFailure = workflow.timeline().find((record) => record.type === "tutor_failed" && record.operation === "review" && record.blockId === TERMINAL_BLOCK_ID);
      expect(publicFailure).toMatchObject({ publicMessage: "Review is temporarily unavailable. Please run the command again in a moment." });
      expect(stateEvents).not.toContainEqual(expect.objectContaining({ terminalPhase: "feedback" }));

      timeline.releaseTerminalFailureFeedback.resolve(undefined);
      await waitUntil(async () => (await timeline.read()).some((record) => record.type === "terminal-feedback-recorded"));
      const failed = await workflow.state();
      expect(failed.progress.blocks.find((block: any) => block.id === TERMINAL_BLOCK_ID)?.terminal).toEqual({
        phase: "feedback",
        message: "Review is temporarily unavailable. Please run the command again in a moment."
      });
      expect(workflow.timeline()).toContainEqual(expect.objectContaining({ type: "tutor_failed", failureId: (publicFailure as any).failureId, publicMessage: "Review is temporarily unavailable. Please run the command again in a moment." }));
      expect(stateEvents).toContainEqual(expect.objectContaining({ terminalPhase: "feedback" }));
    } finally {
      timeline.releaseTerminalFailureFeedback.resolve(undefined);
      await workflow.close().catch(() => undefined);
    }
  });

  it("does not write retry results or mutate attempts after close for any retry operation", async () => {
    for (const operation of ["reply", "restore", "review", "block_summary", "lesson_summary", "completion_summary"] as const) {
      for (const outcome of ["resolve", "reject"] as const) {
        const dir = await fixture();
        const timeline = new WorkbookTimeline(dir);
        const attempts = new AttemptStore(dir);
        const attempt = await attempts.create({ lessonId: EDIT_LESSON_ID, blockId: EDIT_BLOCK_ID, evidence: { kind: "editor", text: `answer for ${operation} ${outcome}` } });
        const failure = await seedActiveEditorFailure(timeline, operation);
        const tutor = new RetryStallTutor(operation, outcome);
        const workflow = await createWorkbookWorkflow({
          contentRoot: dir,
          workspaceRootForId: (workspaceId) => workspaceId === WORKSPACE_ID ? resolve(dir, "workspaces", WORKSPACE_ID) : undefined,
          timeline,
          attempts,
          terminalEvidence: new TerminalEvidenceRepository(dir),
          mainTutor: tutor as any,
          practiceCoach: { assess: async () => ({ outcome: "ready" as const, text: "Ready for main review." }), dispose() {} },
          log: { info() {}, error() {} }
        });
        try {
          const stateEvents: unknown[] = [];
          workflow.subscribeState((event) => stateEvents.push(event));
          const pendingRetry = workflow.retry(failure.id).catch((error) => error);
          await waitUntil(() => tutor.stalledCalls > 0);
          const beforeCloseRecords = await timeline.read();
          const beforeCloseAttempt = await attempts.current(attempt.lessonId, attempt.blockId);

          const startedClose = Date.now();
          await workflow.close();
          expect(Date.now() - startedClose).toBeLessThan(2_000);
          expect(await timeline.read()).toEqual(beforeCloseRecords);
          expect(await attempts.current(attempt.lessonId, attempt.blockId)).toEqual(beforeCloseAttempt);

          tutor.finish();
          await pendingRetry;
          await sleep(50);

          expect(await timeline.read()).toEqual(beforeCloseRecords);
          expect(await attempts.current(attempt.lessonId, attempt.blockId)).toEqual(beforeCloseAttempt);
          expect(stateEvents).toEqual([]);
        } finally {
          await workflow.close().catch(() => undefined);
        }
      }
    }
  });
});

async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-workflow-retry-")); dirs.push(dir);
  await mkdir(resolve(dir, "parts"), { recursive: true });
  await mkdir(resolve(dir, "lessons/001-first/blocks"), { recursive: true });
  await writeFile(resolve(dir, "workbook.md"), ["---", "parts:", "  - id: validation-loop", "    lessons:", "      - 001-first", "---", "# Demo workbook", "", "Welcome."].join("\n"));
  await writeFile(resolve(dir, "parts/validation-loop.md"), ["---", "---", "# Validation loop", "", "Part preamble."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/lesson.md"), ["---", "durationMinutes: 5", `workspace: ${WORKSPACE_ID}`, "blocks:", "  - orientation", "  - edit-answer", "  - run-command", "  - finish", "---", "# Run an agent headlessly", "", "Lesson preamble."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/orientation.md"), ["---", "type: narrative", "---", "## Orientation", "", "Read this."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/edit-answer.md"), ["---", "type: editor-practice", "outcome: Write a clear answer to the question.", "path: factory/answer.txt", "tutor: Accept any clear answer.", "---", "## Edit answer", "", "Write the answer."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/run-command.md"), ["---", "type: terminal-practice", "outcome: Run the verification command.", "tutor: Accept successful verification.", "---", "## Run command", "", "Run the command."].join("\n"));
  await writeFile(resolve(dir, "lessons/001-first/blocks/finish.md"), ["---", "type: narrative", "---", "## Finish", "", "Done."].join("\n"));
  await mkdir(resolve(dir, "workspaces", WORKSPACE_ID, "factory"), { recursive: true });
  await writeFile(resolve(dir, "workspaces", WORKSPACE_ID, "factory/answer.txt"), "");
  return dir;
}

async function seedActiveEditorFailure(timeline: WorkbookTimeline, operation: TutorFailure["operation"]): Promise<TutorFailure> {
  await timeline.append({ type: "session_started" });
  await timeline.append({ type: "workbook_introduction_completed" });
  await timeline.append({ type: "block_completed", blockId: "part--validation-loop" });
  await timeline.append({ type: "block_completed", blockId: "lesson--001-first" });
  await timeline.append({ type: "block_completed", lessonId: EDIT_LESSON_ID, blockId: "lesson--001-first--orientation" });
  await timeline.append({ type: "message", lessonId: EDIT_LESSON_ID, blockId: EDIT_BLOCK_ID, role: "user", source: "learner", presentation: "chat", text: "Can you review this?" });
  return await timeline.append({ type: "tutor_failed", lessonId: EDIT_LESSON_ID, blockId: EDIT_BLOCK_ID, requestId: "retry-request", operation, publicMessage: "The tutor is temporarily unavailable. Please retry." }) as TutorFailure;
}

async function seedActiveTerminalBlock(timeline: WorkbookTimeline): Promise<void> {
  await timeline.append({ type: "session_started" });
  await timeline.append({ type: "workbook_introduction_completed" });
  await timeline.append({ type: "block_completed", blockId: "part--validation-loop" });
  await timeline.append({ type: "block_completed", blockId: "lesson--001-first" });
  await timeline.append({ type: "block_completed", lessonId: EDIT_LESSON_ID, blockId: "lesson--001-first--orientation" });
  await timeline.append({ type: "block_completed", lessonId: EDIT_LESSON_ID, blockId: EDIT_BLOCK_ID });
}

class BlockingTerminalFailureTimeline extends WorkbookTimeline {
  terminalFailureFeedbackAppendReached = false;
  readonly releaseTerminalFailureFeedback = deferred<void>();

  override async appendWithinRun(input: Parameters<WorkbookTimeline["appendWithinRun"]>[0]) {
    if (input.type === "terminal-feedback-recorded" && input.text === "Review is temporarily unavailable. Please run the command again in a moment.") {
      this.terminalFailureFeedbackAppendReached = true;
      await this.releaseTerminalFailureFeedback.promise;
    }
    return await super.appendWithinRun(input);
  }
}

function failingReviewTutor() {
  return {
    async restore() {},
    async reply() { return "Tutor reply."; },
    async review() { throw new Error("temporary provider outage"); },
    async summarizeBlock() { return "Block summary."; },
    async summarizeLesson() { return "Lesson summary."; },
    dispose() {}
  };
}

class RetryStallTutor {
  stalledCalls = 0;
  readonly #deferred = deferred<unknown>();

  constructor(readonly operation: TutorFailure["operation"], readonly outcome: "resolve" | "reject") {}

  async restore() {
    if (this.operation === "restore") return await this.#stall(undefined);
  }

  async reply() {
    if (this.operation === "reply") return await this.#stall("Late retry reply after close.");
    return "Tutor reply.";
  }

  async review(_input: { attempt: Attempt }) {
    if (this.operation === "review") return await this.#stall({ outcome: "accepted", message: "Late accepted review after close." });
    return { outcome: "working" as const };
  }

  async summarizeBlock() {
    if (this.operation === "block_summary") return await this.#stall("Late block summary after close.");
    return "Block summary.";
  }

  async summarizeLesson(input: { lessonId: string }) {
    if ((this.operation === "lesson_summary" && input.lessonId === EDIT_LESSON_ID) || (this.operation === "completion_summary" && input.lessonId === "workbook")) {
      return await this.#stall("Late lesson summary after close.");
    }
    return "Lesson summary.";
  }

  dispose() {}

  finish() {
    if (this.outcome === "resolve") this.#deferred.resolve(undefined);
    else this.#deferred.reject(new Error("disposed after close"));
  }

  async #stall<T>(result: T): Promise<T> {
    this.stalledCalls += 1;
    await this.#deferred.promise;
    return result;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolveDeferred = resolvePromise; rejectDeferred = rejectPromise; });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 50; index += 1) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("Timed out waiting for workflow condition.");
}

function sleep(ms: number) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
