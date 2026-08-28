import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicTerminalFrame, type PublicTerminalFrame } from "../../tutorial-engine/src/workbook/public-terminal-contract.js";
import type { TerminalPty } from "../../tutorial-engine/src/workbook/terminal.js";
import type { TutorDecision } from "../../tutorial-engine/src/workbook/tutor.js";
import { createV2WorkbookDriver, V2WorkbookDriver } from "../v2/driver.js";
import { clueCommand, exactCommand, satisfactoryEditorDraft } from "../v2/scenarios.js";
import { createEmptyV2SessionTrace, readWorkbookTimeline } from "../v2/session.js";
import { createEvaluationWorkspace, type CreateEvaluationWorkspaceOptions } from "../v2/workspace.js";
import { RecordingPracticeCoach, RecordingMainTutor, type ReviewInput } from "../../tutorial-engine/test/support/fake-tutors.js";

class DriverFakeMainTutor extends RecordingMainTutor {
  protected override defaultReply = "Tutor reply that asks one public follow-up.";
  protected override blockSummaryFor = () => "Completed block summary.";
  protected override lessonSummaryFor = () => "Completed lesson summary.";

  protected override async decide(input: ReviewInput): Promise<TutorDecision> {
    const { evidence } = input.attempt;
    if (evidence.kind === "editor") {
      if (evidence.text.includes("editor-artifacts/evaluator-editor.txt") && evidence.text.includes("ready for promotion")) return { outcome: "accepted", message: "Editor artifact accepted for promotion." };
      return { outcome: "feedback", message: "Name editor-artifacts/evaluator-editor.txt and explain the promotion intent." };
    }
    if (evidence.kind === "terminal") {
      if (input.attempt.blockId.endsWith("--exact-command") && evidence.transcript.includes("evaluator-command.txt") && evidence.transcript.includes("command block complete")) return { outcome: "accepted", message: "verified exact-command" };
      if (input.attempt.blockId.endsWith("--clue-only") && evidence.transcript.includes("evaluator-clue.txt") && evidence.transcript.includes("clue block complete")) return { outcome: "accepted", message: "verified clue-only" };
      return { outcome: "feedback", message: `Keep working on ${input.attempt.blockId}.` };
    }
    return { outcome: "feedback", message: "Tutor reply that asks one public follow-up." };
  }
}

class DriverFakePty implements TerminalPty {
  writes: string[] = [];
  private dataCallbacks: Array<(data: string) => void> = [];
  private exitCallbacks: Array<(event: { exitCode: number }) => void> = [];

  write(data: string): void {
    this.writes.push(data);
    this.dataCallbacks.forEach((callback) => callback(`\r\nran:${data.replace(/\r/g, "\n")}`));
  }

  resize(): void {}
  kill(): void {}
  onData(callback: (data: string) => void): void { this.dataCallbacks.push(callback); }
  onExit(callback: (event: { exitCode: number }) => void): void { this.exitCallbacks.push(callback); }
  emitExit(exitCode: number): void { this.exitCallbacks.forEach((callback) => callback({ exitCode })); }
}

class DriverFakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly CONNECTING = DriverFakeWebSocket.CONNECTING;
  readonly OPEN = DriverFakeWebSocket.OPEN;
  readonly CLOSED = DriverFakeWebSocket.CLOSED;
  readyState = DriverFakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  constructor() {
    queueMicrotask(() => {
      this.readyState = DriverFakeWebSocket.OPEN;
      this.emit("open");
    });
  }

  once(event: string, callback: (...args: any[]) => void): void {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper);
      callback(...args);
    };
    this.on(event, wrapper);
  }

  on(event: string, callback: (...args: any[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(callback);
    this.handlers.set(event, handlers);
  }

  off(event: string, callback: (...args: any[]) => void): void {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((handler) => handler !== callback));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
    queueMicrotask(() => {
      this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "command block complete\r\n" })));
    });
    setTimeout(() => {
      this.emit("message", Buffer.from(JSON.stringify({ type: "attempt-status", blockId: "lesson--001-live-session--exact-command", status: "submitted" })));
    }, 50);
  }

  close(): void {
    this.readyState = DriverFakeWebSocket.CLOSED;
    this.emit("close");
  }

  protected emitMessage(payload: Buffer): void { this.emit("message", payload); }

  private emit(event: string, ...args: any[]): void {
    for (const handler of [...this.handlers.get(event) ?? []]) handler(...args);
  }
}

const tempRoots: string[] = [];
let originalOpenCodeApiKey: string | undefined;

beforeEach(() => {
  originalOpenCodeApiKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "test-opencode-key";
});

afterEach(async () => {
  if (originalOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = originalOpenCodeApiKey;
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function startDriver(options: CreateEvaluationWorkspaceOptions = {}) {
  const workspace = await createEvaluationWorkspace(options);
  tempRoots.push(workspace.repositoryRoot);
  const pty = new DriverFakePty();
  const workbookTutor = new DriverFakeMainTutor();
  const practiceCoach = new RecordingPracticeCoach();
  const server = await workspace.startServer({
    terminalPtyFactory: () => pty,
    terminalDebounceMs: 1,
    mainTutor: workbookTutor,
    practiceCoach
  });
  const trace = createEmptyV2SessionTrace("driver-test");
  const driver = createV2WorkbookDriver({ serverUrl: server.url, trace });
  return { workspace, server, trace, driver, pty, workbookTutor };
}

async function reachExactCommand(driver: V2WorkbookDriver) {
  await driver.completeIntroduction();
  await driver.continueBlock("orientation");
  await driver.submitEditorDraft("editor-practice", satisfactoryEditorDraft);
  return driver.continueBlock("editor-practice");
}

async function reachReflection(driver: V2WorkbookDriver) {
  await reachExactCommand(driver);
  await driver.submitTerminalCommand("exact-command", exactCommand);
  await driver.submitTerminalCommand("clue-only", clueCommand);
}

describe("v2 workbook driver", () => {
  it("drives public workbook state and Continue actions through the HTTP API", async () => {
    const { server, trace, driver } = await startDriver();
    try {
      const initial = await driver.readState("initial");
      expect(initial.introductionComplete).toBe(false);

      const introduced = await driver.completeIntroduction();
      expect(introduced.progress.activeBlockId).toBe("lesson--001-live-session--orientation");
      expect(introduced.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["lesson--001-live-session--orientation"]);

      const continued = await driver.continueBlock("orientation");
      expect(continued.progress.activeBlockId).toBe("lesson--001-live-session--editor-practice");
      expect(continued.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["lesson--001-live-session--orientation", "lesson--001-live-session--editor-practice"]);
      expect(trace.publicStates.map((state) => state.label)).toEqual(["initial", "introduction", "introduction:structural:part--evaluator", "introduction:structural:lesson--001-live-session", "continue:orientation"]);
      expect(JSON.stringify(trace)).not.toContain('"tutor"');
    } finally {
      await server.close();
    }
  });


  it("submits editor drafts and records only public editor feedback", async () => {
    const { server, trace, driver, workbookTutor } = await startDriver();
    try {
      await driver.completeIntroduction();
      await driver.continueBlock("orientation");

      const reviewed = await driver.submitEditorDraft("editor-practice", "This is a vague draft.");

      const editorBlock = reviewed.progress.blocks.find((block: any) => block.id.endsWith("--editor-practice"));
      expect(editorBlock).toMatchObject({ active: true, completed: false, editorStatus: "feedback", revision: 1, checkpoint: { status: "feedback", feedback: expect.stringContaining("editor-artifacts/evaluator-editor.txt") } });
      expect(trace.editors).toEqual([
        { blockId: "lesson--001-live-session--editor-practice", revision: 1, status: "reviewing" },
        { blockId: "lesson--001-live-session--editor-practice", revision: 1, status: "feedback", feedback: "Name editor-artifacts/evaluator-editor.txt and explain the promotion intent." }
      ]);
      expect(workbookTutor.reviews).toHaveLength(1);
      expect(workbookTutor.reviews[0]).toMatchObject({ privateGuidance: expect.stringContaining("Private editor criterion"), attempt: { evidence: { kind: "editor", text: "This is a vague draft." } } });
      expect(JSON.stringify(trace)).not.toContain("Private editor criterion");
      // An editor-practice block reaches the learner through its checkpoint feedback, asserted
      // above; the main tutor's review is no longer appended as a timeline message for editor
      // evidence. That the learner sees it exactly once is covered by workbook-ui.test.tsx.
    } finally {
      await server.close();
    }
  });

  it("uses a dedicated editor review timeout instead of the terminal timeout", async () => {
    const trace = createEmptyV2SessionTrace("editor-timeout-test");
    let stateReads = 0;
    const reviewingState = { progress: { blocks: [{ id: "editor-practice", revision: 1, editorStatus: "reviewing" }] } };
    const feedbackState = { progress: { blocks: [{ id: "editor-practice", revision: 1, editorStatus: "feedback", feedback: "Review finished after the terminal timeout." }] } };
    const driver = new V2WorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      terminalTimeoutMs: 30,
      editorReviewTimeoutMs: 100,
      fetch: async (_input, init) => {
        if (init?.method === "POST") return new Response(JSON.stringify(reviewingState), { status: 202 });
        stateReads += 1;
        return new Response(JSON.stringify(stateReads >= 3 ? feedbackState : reviewingState), { status: 200 });
      }
    });

    const reviewed = await driver.submitEditorDraft("editor-practice", "draft that needs a model-backed review");

    expect(stateReads).toBe(3);
    expect(reviewed.progress.blocks[0]).toMatchObject({ editorStatus: "feedback", feedback: "Review finished after the terminal timeout." });
    expect(trace.editors.at(-1)).toEqual({ blockId: "editor-practice", revision: 1, status: "feedback", feedback: "Review finished after the terminal timeout." });
  });

  it("waits for a learner-visible reflection tutor reply instead of treating status-only feedback as usable", async () => {
    const trace = createEmptyV2SessionTrace("reflection-status-only-test");
    let stateReads = 0;
    const blockId = "lesson--001-live-session--reflection";
    const learnerOnly = {
      progress: {
        blocks: [{ id: blockId, checkpoint: { status: "feedback", feedback: "Review is temporarily unavailable." } }],
        reflectionConversations: { [blockId]: [{ role: "learner", text: "My reflection" }] }
      }
    };
    const withTutor = {
      progress: {
        blocks: [{ id: blockId, checkpoint: { status: "feedback", feedback: "Please add one public/private distinction." } }],
        reflectionConversations: { [blockId]: [{ role: "learner", text: "My reflection" }, { role: "tutor", text: "Please add one public/private distinction." }] }
      }
    };
    const driver = new V2WorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      editorReviewTimeoutMs: 200,
      fetch: async (_input, init) => {
        if (init?.method === "POST") return new Response(JSON.stringify(learnerOnly), { status: 202 });
        stateReads += 1;
        return new Response(JSON.stringify(stateReads >= 2 ? withTutor : learnerOnly), { status: 200 });
      }
    });

    const reviewed = await driver.submitReflection(blockId, "My reflection");

    expect(stateReads).toBe(2);
    expect(reviewed.progress.reflectionConversations[blockId]).toHaveLength(2);
    expect(trace.reflections).toEqual([
      { blockId, role: "learner", text: "My reflection" },
      { blockId, role: "tutor", text: "Please add one public/private distinction." }
    ]);
  });

  it("uses a dedicated terminal review timeout for terminal submission and review", async () => {
    const trace = createEmptyV2SessionTrace("terminal-review-timeout-test");
    let stateReads = 0;
    const reviewingState = { progress: { blocks: [{ id: "lesson--001-live-session--exact-command", checkpoint: { status: "reviewing" } }] } };
    const acceptedState = { progress: { blocks: [{ id: "lesson--001-live-session--exact-command", checkpoint: { status: "accepted", successMessage: "Review accepted after the terminal I/O timeout." } }] } };
    const driver = new V2WorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      terminalTimeoutMs: 30,
      terminalReviewTimeoutMs: 200,
      WebSocket: DriverFakeWebSocket as any,
      fetch: async () => {
        stateReads += 1;
        return new Response(JSON.stringify(stateReads >= 3 ? acceptedState : reviewingState), { status: 200 });
      }
    });

    const reviewed = await driver.submitTerminalCommand("lesson--001-live-session--exact-command", "echo command block complete", { complete: false });

    expect(stateReads).toBe(3);
    expect(reviewed.progress.blocks[0]).toMatchObject({ checkpoint: { status: "accepted", successMessage: "Review accepted after the terminal I/O timeout." } });
    expect(trace.terminalTranscript).toEqual(expect.arrayContaining([
      { blockId: "lesson--001-live-session--exact-command", direction: "input", text: "echo command block complete\r" },
      { blockId: "lesson--001-live-session--exact-command", direction: "output", text: "command block complete\r\n" },
      { blockId: "lesson--001-live-session--exact-command", direction: "observer", text: "status:submitted" }
    ]));
  });

  it("records every terminal frame the server sends, not only the ones a scenario asserts on", async () => {
    const blockId = "lesson--001-live-session--exact-command";
    // One of each frame in PublicTerminalFrame. Before attempts replaced the observer the driver
    // matched names no server had sent since f55dcf1, so an errored or evicted terminal left a
    // trace that read as a clean run.
    const frames: PublicTerminalFrame[] = [
      { type: "output", data: "ran:echo hi\r\n" },
      { type: "attempt-status", blockId, status: "running" },
      { type: "attempt-status", status: "checking" },
      { type: "attempt-error", blockId, message: "Could not submit the terminal attempt." },
      { type: "terminal-error", message: "The embedded terminal could not start on this machine." },
      { type: "busy", message: "Another browser is already connected to this terminal." },
      { type: "exit", exitCode: 137, signal: 9 },
      { type: "attempt-status", blockId, status: "submitted" }
    ];
    class ReplayWebSocket extends DriverFakeWebSocket {
      override send(): void {
        frames.forEach((frame, index) => setTimeout(() => this.emitMessage(Buffer.from(publicTerminalFrame(frame))), (index + 1) * 5));
      }
    }
    const trace = createEmptyV2SessionTrace("terminal-frame-coverage-test");
    const accepted = { progress: { blocks: [{ id: blockId, checkpoint: { status: "accepted", successMessage: "ok" } }] } };
    const driver = new V2WorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      terminalTimeoutMs: 200,
      terminalReviewTimeoutMs: 2_000,
      WebSocket: ReplayWebSocket as any,
      fetch: async () => new Response(JSON.stringify(accepted), { status: 200 })
    });

    await driver.submitTerminalCommand(blockId, "echo hi", { complete: false });

    expect(trace.terminalTranscript.filter((entry) => entry.direction === "observer")).toEqual([
      { blockId, direction: "observer", text: "status:running" },
      { blockId, direction: "observer", text: "status:checking" },
      { blockId, direction: "observer", text: "Could not submit the terminal attempt." },
      { blockId, direction: "observer", text: "The embedded terminal could not start on this machine." },
      { blockId, direction: "observer", text: "Another browser is already connected to this terminal." },
      { blockId, direction: "observer", text: "exit:137 signal:9" },
      { blockId, direction: "observer", text: "status:submitted" }
    ]);
  });

  it("submits reflections and records the public learner/tutor conversation", async () => {
    const { workspace, server, trace, driver, workbookTutor } = await startDriver();
    try {
      await reachReflection(driver);

      const discussed = await driver.submitReflection("reflection", "The exact block gave a command; the clue block required me to choose one.");

      expect(discussed.progress.activeBlockId).toBe("lesson--001-live-session--reflection");
      expect(trace.reflections).toEqual([
        { blockId: "lesson--001-live-session--reflection", role: "learner", text: "The exact block gave a command; the clue block required me to choose one." },
        { blockId: "lesson--001-live-session--reflection", role: "tutor", text: "Tutor reply that asks one public follow-up." }
      ]);
      const session = workspace.latestSession();
      expect(session.sessionRoot.endsWith(`/.tutorial/${session.sessionId}`)).toBe(true);
      expect(session.workspaceRoot).toBe(resolve(session.sessionRoot, "workspace"));
      trace.events = await readWorkbookTimeline(session.sessionRoot);
      expect(trace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "reflection_submitted", blockId: "lesson--001-live-session--reflection" }),
        expect.objectContaining({ type: "reflection_reply_recorded", blockId: "lesson--001-live-session--reflection" })
      ]));
      expect(workbookTutor.reviews.filter((review) => review.attempt.blockId.endsWith("--reflection"))).toHaveLength(1);
      expect(JSON.stringify(trace)).not.toContain("Follow up until the learner");
      expect(JSON.stringify(trace)).not.toContain('"tutor":');
    } finally {
      await server.close();
    }
  });

  it("submits terminal commands over the embedded-terminal WebSocket and records tutor-reviewed completion", async () => {
    const { server, trace, driver, pty, workbookTutor } = await startDriver();
    try {
      await reachExactCommand(driver);

      const completed = await driver.submitTerminalCommand("exact-command", exactCommand);

      expect(completed.progress.activeBlockId).toBe("lesson--001-live-session--clue-only");
      expect(pty.writes).toEqual([`${exactCommand}\r`]);
      expect(workbookTutor.reviews.filter((review) => review.attempt.blockId.endsWith("--exact-command"))).toHaveLength(1);
      expect(trace.terminalTranscript).toEqual(expect.arrayContaining([
        expect.objectContaining({ blockId: "lesson--001-live-session--exact-command", direction: "input", text: `${exactCommand}\r` }),
        expect.objectContaining({ blockId: "lesson--001-live-session--exact-command", direction: "output", text: expect.stringContaining("ran:mkdir") }),
        expect.objectContaining({ blockId: "lesson--001-live-session--exact-command", direction: "observer", text: expect.stringContaining("status:submitted") })
      ]));
      expect(trace.publicStates.map((state) => state.label)).toContain("terminal:exact-command:reviewed:1");
      expect(trace.publicStates.map((state) => state.label)).toContain("terminal:lesson--001-live-session--exact-command:complete");
      expect(JSON.stringify(trace)).not.toContain("This is private tutor guidance");
    } finally {
      await server.close();
    }
  });

  it("rejects API responses that expose private tutor fields", async () => {
    const trace = createEmptyV2SessionTrace("leaky-api");
    const driver = new V2WorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      fetch: async () => new Response(JSON.stringify({ workbook: { title: "Leaky" }, tutor: "private guidance" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    });

    await expect(driver.readState("leaky")).rejects.toThrow(/private tutor/i);
    expect(trace.publicStates).toEqual([]);
  });
});
