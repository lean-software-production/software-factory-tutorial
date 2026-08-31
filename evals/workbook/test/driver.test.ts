import { describe, expect, it } from "vitest";
import type { PublicTerminalFrame } from "../../../tutorial-engine/src/workbook/public-terminal-contract.js";
import type { PublicWorkbookState } from "../../../tutorial-engine/src/workbook/public-contract.js";
import { AuthoredWorkbookDriver } from "../driver.js";
import { createEmptyAuthoredWorkbookEvalSessionTrace } from "../public-trace.js";

const blockId = "lesson--001-public-contract--terminal";

function stateWithTerminal(phase: "running" | "checking" | "feedback" | "complete", message?: string, terminalRevision?: number): PublicWorkbookState {
  return {
    workbook: { title: "Public workbook" },
    introduction: "Intro",
    introductionComplete: true,
    chapters: [],
    progress: {
      activeLessonId: "001-public-contract",
      activeBlockId: blockId,
      completedLessons: [],
      blocks: [{
        id: blockId,
        type: "terminal-practice",
        ready: false,
        active: true,
        completed: phase === "complete",
        verified: phase === "complete",
        emerged: true,
        workAccepted: phase === "complete",
        terminal: phase === "running" || phase === "checking" ? { phase } : { phase, message: message ?? "" },
        ...(terminalRevision === undefined ? {} : { terminalRevision })
      }],
      reflections: {},
      reflectionConversations: {}
    },
    adapter: {},
    orderedBlocks: [{ id: blockId, anchorId: blockId, origin: "lesson", kind: "terminal-practice", title: "Terminal", lessonId: "001-public-contract", declaredId: "terminal" }],
    timeline: []
  };
}

function stateAfterTerminalAdvanced(message = "Accepted."): PublicWorkbookState {
  const nextBlockId = "lesson--001-public-contract--next";
  return {
    ...stateWithTerminal("complete", message, 2),
    progress: {
      ...stateWithTerminal("complete", message, 2).progress,
      activeBlockId: nextBlockId,
      blocks: [
        {
          id: blockId,
          type: "terminal-practice",
          ready: true,
          active: false,
          completed: true,
          verified: true,
          emerged: true,
          workAccepted: true,
          terminal: { phase: "complete", message },
          terminalRevision: 2
        },
        {
          id: nextBlockId,
          type: "narrative",
          ready: true,
          active: true,
          completed: false,
          verified: false,
          emerged: true
        }
      ]
    },
    currentBlock: { id: nextBlockId, anchorId: nextBlockId, origin: "lesson", kind: "narrative", title: "Next", lessonId: "001-public-contract", declaredId: "next" },
    orderedBlocks: [
      { id: blockId, anchorId: blockId, origin: "lesson", kind: "terminal-practice", title: "Terminal", lessonId: "001-public-contract", declaredId: "terminal" },
      { id: nextBlockId, anchorId: nextBlockId, origin: "lesson", kind: "narrative", title: "Next", lessonId: "001-public-contract", declaredId: "next" }
    ]
  };
}

function stateWithStructural(activeBlockId: string, completed = false): PublicWorkbookState {
  const nextBlockId = "lesson--004-public-contract--key-concept";
  return {
    ...stateWithTerminal("running"),
    progress: {
      ...stateWithTerminal("running").progress,
      activeLessonId: "004-public-contract",
      activeBlockId: completed ? nextBlockId : activeBlockId,
      canComplete: completed ? { blockId: nextBlockId, eligible: true } : { blockId: activeBlockId, eligible: true },
      blocks: [
        { id: activeBlockId, type: "lesson-preamble", ready: false, active: !completed, completed, verified: completed, emerged: true, workAccepted: true },
        { id: nextBlockId, type: "narrative", ready: completed, active: completed, completed: false, verified: false, emerged: true, workAccepted: false }
      ]
    },
    currentBlock: completed
      ? { id: nextBlockId, anchorId: nextBlockId, origin: "lesson", kind: "narrative", title: "Key concept", lessonId: "004-public-contract", declaredId: "key-concept" }
      : { id: activeBlockId, anchorId: activeBlockId, origin: "structural", kind: "lesson-preamble", title: "Lesson", lessonId: "004-public-contract" },
    orderedBlocks: [
      { id: activeBlockId, anchorId: activeBlockId, origin: "structural", kind: "lesson-preamble", title: "Lesson", lessonId: "004-public-contract" },
      { id: nextBlockId, anchorId: nextBlockId, origin: "lesson", kind: "narrative", title: "Key concept", lessonId: "004-public-contract", declaredId: "key-concept" }
    ]
  };
}

function stateWithEditor(revision: number, status: "reviewing" | "feedback" | "accepted", feedback?: string): PublicWorkbookState {
  return {
    ...stateWithTerminal("running"),
    progress: {
      ...stateWithTerminal("running").progress,
      activeBlockId: "lesson--001-public-contract--editor",
      blocks: [{
        id: "lesson--001-public-contract--editor",
        type: "editor-practice",
        ready: false,
        active: true,
        completed: status === "accepted",
        verified: status === "accepted",
        emerged: true,
        workAccepted: status === "accepted",
        revision,
        editorStatus: status === "accepted" ? "unlocked" : status,
        checkpoint: { status, ...(feedback === undefined ? {} : { feedback }) }
      }],
      reflections: {},
      reflectionConversations: {}
    },
    currentBlock: { id: "lesson--001-public-contract--editor", anchorId: "lesson--001-public-contract--editor", origin: "lesson", kind: "editor-practice", title: "Editor", lessonId: "001-public-contract", declaredId: "editor" },
    orderedBlocks: [{ id: "lesson--001-public-contract--editor", anchorId: "lesson--001-public-contract--editor", origin: "lesson", kind: "editor-practice", title: "Editor", lessonId: "001-public-contract", declaredId: "editor" }]
  };
}

class ReplayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly CONNECTING = ReplayWebSocket.CONNECTING;
  readonly OPEN = ReplayWebSocket.OPEN;
  readonly CLOSED = ReplayWebSocket.CLOSED;
  readyState = ReplayWebSocket.CONNECTING;
  sent: unknown[] = [];
  closeCalls = 0;
  protected handlers = new Map<string, Array<(...args: any[]) => void>>();
  private readonly onceWrappers = new Map<string, Map<(...args: any[]) => void, (...args: any[]) => void>>();

  constructor() {
    queueMicrotask(() => {
      this.readyState = ReplayWebSocket.OPEN;
      this.emit("open");
    });
  }

  once(event: string, callback: (...args: any[]) => void): void {
    const wrapper = (...args: any[]) => {
      this.off(event, callback);
      callback(...args);
    };
    const eventWrappers = this.onceWrappers.get(event) ?? new Map<(...args: any[]) => void, (...args: any[]) => void>();
    eventWrappers.set(callback, wrapper);
    this.onceWrappers.set(event, eventWrappers);
    this.on(event, wrapper);
  }

  on(event: string, callback: (...args: any[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(callback);
    this.handlers.set(event, handlers);
  }

  off(event: string, callback: (...args: any[]) => void): void {
    const eventWrappers = this.onceWrappers.get(event);
    const wrapper = eventWrappers?.get(callback);
    eventWrappers?.delete(callback);
    if (eventWrappers?.size === 0) this.onceWrappers.delete(event);
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((handler) => handler !== callback && handler !== wrapper));
  }

  listenerCount(event?: string): number {
    if (event !== undefined) return this.handlers.get(event)?.length ?? 0;
    return [...this.handlers.values()].reduce((total, handlers) => total + handlers.length, 0);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
    const frames: Array<PublicTerminalFrame | Record<string, unknown>> = [
      { type: "output", data: "visible output\r\n", attemptId: "socket-extra-secret" }
    ];
    frames.forEach((frame, index) => setTimeout(() => this.emit("message", Buffer.from(JSON.stringify(frame))), (index + 1) * 2));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = ReplayWebSocket.CLOSED;
    this.emit("close");
  }

  protected emit(event: string, ...args: any[]): void {
    for (const handler of [...this.handlers.get(event) ?? []]) handler(...args);
  }
}

function stateForResolution(activeBlockId: string): PublicWorkbookState {
  return {
    ...stateWithTerminal("running"),
    progress: { ...stateWithTerminal("running").progress, activeBlockId },
    currentBlock: { id: activeBlockId, anchorId: activeBlockId, origin: "lesson", kind: "narrative", title: "Current", lessonId: activeBlockId.includes("002") ? "002" : "001", declaredId: activeBlockId.endsWith("key-concept") ? "key-concept" : "other" },
    orderedBlocks: [
      { id: "lesson--001--key-concept", anchorId: "lesson--001--key-concept", origin: "lesson", kind: "narrative", title: "Key concept", lessonId: "001", declaredId: "key-concept" },
      { id: "lesson--002--key-concept", anchorId: "lesson--002--key-concept", origin: "lesson", kind: "narrative", title: "Key concept", lessonId: "002", declaredId: "key-concept" },
      { id: "lesson--001--checks", anchorId: "lesson--001--checks", origin: "lesson", kind: "reflection", title: "Checks", lessonId: "001", declaredId: "checks" },
      { id: "lesson--002--checks", anchorId: "lesson--002--checks", origin: "lesson", kind: "reflection", title: "Checks", lessonId: "002", declaredId: "checks" }
    ]
  };
}

describe("authored workbook public driver", () => {
  it("records browser-public states through the HTTP API without duplicating or narrowing their schema", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("driver-state");
    const visibleState = stateWithTerminal("running");
    visibleState.adapter.note = "Public text can mention Tutor, Coach handoff, terminal-command-submitted, and JSON-looking \"tutor\":";
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      fetch: async () => new Response(JSON.stringify(visibleState), { status: 200 })
    });

    const state = await driver.readState("initial");

    expect(state).toEqual(visibleState);
    expect(trace.publicStates).toEqual([{ label: "initial", state: visibleState }]);
    expect(JSON.stringify(trace.publicStates)).toContain("Coach handoff");
  });

  it("rejects malformed state responses through the shared public parser", async () => {
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("driver-malformed-state"),
      fetch: async () => new Response(JSON.stringify({ progress: { activeBlockId: "not-enough" } }), { status: 200 })
    });

    await expect(driver.readState("bad")).rejects.toThrow(/invalid public state/);
  });

  it("bounds stalled HTTP actions and does not echo HTTP error bodies", async () => {
    const stalled = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("driver-http-timeout"),
      requestTimeoutMs: 20,
      fetch: async () => new Promise<Response>(() => {})
    });
    await expect(stalled.readState("timeout")).rejects.toThrow("Timed out waiting for workbook HTTP response.");

    const failed = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("driver-http-error"),
      fetch: async () => new Response(JSON.stringify({ error: "private server diagnostic" }), { status: 500, statusText: "Server diagnostic" })
    });
    await expect(failed.readState("error")).rejects.toThrow("GET /api/workbook/state failed with HTTP 500.");
    await expect(failed.readState("error")).rejects.not.toThrow(/private server diagnostic|Server diagnostic/);
  });

  it("bounds structural introduction auto-progression loops", async () => {
    const looping = {
      ...stateWithTerminal("running"),
      progress: { ...stateWithTerminal("running").progress, activeBlockId: "part--loop" },
      currentBlock: { id: "part--loop", anchorId: "part--loop", origin: "structural", kind: "part-preamble", title: "Loop", lessonId: "001-public-contract" }
    };
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("driver-structural-loop"),
      fetch: async () => new Response(JSON.stringify(looping), { status: 200 })
    });

    await expect(driver.completeIntroduction()).rejects.toThrow(/repeated block 'part--loop'/);
  });

  it("uses the server-returned editor revision as the submitted correlation key", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("editor-resumed-revision");
    const states = [stateWithEditor(3, "feedback", "Existing feedback."), stateWithEditor(4, "reviewing"), stateWithEditor(3, "feedback", "Old feedback."), stateWithEditor(4, "feedback", "Visible resumed feedback.")];
    const posted: unknown[] = [];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      editorReviewTimeoutMs: 1_000,
      fetch: async (_input, init) => {
        if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(states.shift() ?? stateWithEditor(4, "feedback", "Visible resumed feedback.")), { status: 200 });
      }
    });

    const reviewed = await driver.submitEditorDraft("editor", "draft text");

    expect(posted).toEqual([{ blockId: "lesson--001-public-contract--editor", text: "draft text" }]);
    expect(reviewed.progress.blocks[0]?.revision).toBe(4);
    expect(trace.editors).toEqual([
      { blockId: "lesson--001-public-contract--editor", revision: 4, status: "reviewing" },
      { blockId: "lesson--001-public-contract--editor", revision: 4, status: "feedback", feedback: "Visible resumed feedback." }
    ]);
  });

  it("resolves repeated short block IDs to the active matching ordered block", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("active-short-id");
    const posted: unknown[] = [];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      fetch: async (_input, init) => {
        if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(stateForResolution("lesson--002--key-concept")), { status: 200 });
      }
    });

    await driver.continueBlock("key-concept");
    await driver.continueBlock("lesson--001--key-concept");

    expect(posted).toEqual([
      { blockId: "lesson--002--key-concept", action: "continue" },
      { blockId: "lesson--001--key-concept", action: "continue" }
    ]);
  });

  it("rejects ambiguous repeated short block IDs when no active match disambiguates", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("ambiguous-short-id");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      fetch: async () => new Response(JSON.stringify(stateForResolution("lesson--002--other")), { status: 200 })
    });

    await expect(driver.continueBlock("checks")).rejects.toThrow(/Ambiguous workbook block id 'checks'/);
  });

  it("continues active structural lesson preambles through the complete-block endpoint", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("structural-lesson-preamble");
    const structuralBlockId = "lesson--004-public-contract";
    const posted: Array<{ path: string; body: unknown }> = [];
    const states = [stateWithStructural(structuralBlockId), stateWithStructural(structuralBlockId, true)];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      fetch: async (input, init) => {
        if (init?.method === "POST") posted.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(states.shift() ?? stateWithStructural(structuralBlockId, true)), { status: 200 });
      }
    });

    const state = await driver.continueBlock(structuralBlockId, "lesson004:introduction");

    expect(state.progress.activeBlockId).toBe("lesson--004-public-contract--key-concept");
    expect(posted).toEqual([{ path: "/api/workbook/complete-block", body: { blockId: structuralBlockId } }]);
    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["lesson004:introduction:active", "lesson004:introduction"]);
  });

  it("parses public terminal frames, drops socket extras, and supports expected feedback followed by retry", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-feedback-retry");
    const states = [stateWithTerminal("complete", "At rest."), stateWithTerminal("checking"), stateWithTerminal("feedback", "Try again with the visible filename."), stateWithTerminal("feedback", "Try again with the visible filename."), stateWithTerminal("checking"), stateWithTerminal("complete", "Accepted.")];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", "Accepted.")), { status: 200 });
      }
    });

    const feedback = await driver.submitTerminalCommand(blockId, "bad command", { label: "terminal:bad", complete: false, expectedFeedback: /visible filename/ });
    const completed = await driver.submitTerminalCommand(blockId, "good command", { label: "terminal:retry", complete: false });

    expect(feedback.progress.blocks[0]?.terminal).toEqual({ phase: "feedback", message: "Try again with the visible filename." });
    expect(completed.progress.blocks[0]?.terminal).toEqual({ phase: "complete", message: "Accepted." });
    expect(trace.terminalTranscript).toEqual([
      { blockId, direction: "input", text: "bad command\r" },
      { blockId, direction: "output", text: "visible output\r\n" },
      { blockId, direction: "input", text: "good command\r" },
      { blockId, direction: "output", text: "visible output\r\n" }
    ]);
    expect(JSON.stringify(trace.terminalTranscript)).not.toContain("socket-extra-secret");
    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["terminal:bad:baseline", "terminal:bad:reviewed:1", "terminal:bad:reviewed:2", "terminal:retry:reviewed:1", "terminal:retry:reviewed:2"]);
  });

  it("retries only the canonical transient terminal tutor failure through the public retry endpoint", async () => {
    const transient = "Review is temporarily unavailable. Please run the command again in a moment.";
    class CapturingWebSocket extends ReplayWebSocket {
      static instances: CapturingWebSocket[] = [];
      constructor() { super(); CapturingWebSocket.instances.push(this); }
    }
    const withFailure = stateWithTerminal("feedback", transient, 1);
    withFailure.timeline = [{ type: "tutor_failed", id: "failure-row", failureId: "failure-row", sequence: 7, at: "public-at", lessonId: "001-public-contract", blockId, operation: "review", publicMessage: transient }];
    const states = [stateWithTerminal("checking", undefined, 0), withFailure, stateWithTerminal("complete", "Accepted after retry.", 1)];
    const posted: Array<{ path: string; body: unknown }> = [];
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-transient-retry");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: CapturingWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      transientTerminalReviewRetryDelayMs: 0,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === "POST") {
          posted.push({ path, body: JSON.parse(String(init.body)) });
          expect(path).toBe("/api/workbook/retry");
          return new Response(JSON.stringify(stateWithTerminal("checking", undefined, 1)), { status: 202 });
        }
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", "Accepted after retry.", 1)), { status: 200 });
      }
    });

    const reviewed = await driver.submitTerminalCommand(blockId, "good command", { complete: false });

    expect(reviewed.progress.blocks[0]?.terminal).toEqual({ phase: "complete", message: "Accepted after retry." });
    expect(posted).toEqual([{ path: "/api/workbook/retry", body: { failureId: "failure-row" } }]);
    expect(CapturingWebSocket.instances).toHaveLength(1);
    expect(CapturingWebSocket.instances[0]!.sent).toEqual([{ type: "input", data: "good command\r" }]);
    expect(trace.terminalTranscript.filter((entry) => entry.direction === "input")).toEqual([{ blockId, direction: "input", text: "good command\r" }]);
  });

  it("does not treat a canonical-looking terminal feedback message without a failure row as retryable", async () => {
    const transient = "Review is temporarily unavailable. Please run the command again in a moment.";
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-transient-no-failure-row");
    const states = [stateWithTerminal("checking", undefined, 0), stateWithTerminal("feedback", transient, 1)];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async (_input, init) => {
        if (init?.method === "POST") throw new Error("retry should not be called");
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("feedback", transient, 1)), { status: 200 });
      }
    });

    await expect(driver.submitTerminalCommand(blockId, "bad command", { complete: false })).rejects.toThrow(`Terminal attempt for ${blockId} received tutor feedback: ${transient}`);
  });

  it("bounds transient terminal tutor retries and does not accept the transient text as expected feedback", async () => {
    const transient = "Review is temporarily unavailable. Please run the command again in a moment.";
    let sequence = 0;
    let posts = 0;
    const failedState = () => {
      const state = stateWithTerminal("feedback", transient, 1);
      sequence += 1;
      state.timeline = [{ type: "tutor_failed", id: `failure-${sequence}`, failureId: `failure-${sequence}`, sequence, at: "public-at", lessonId: "001-public-contract", blockId, operation: "review", publicMessage: transient }];
      return state;
    };
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("terminal-transient-bounded"),
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      transientTerminalReviewRetryDelayMs: 0,
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          posts += 1;
          return new Response(JSON.stringify(stateWithTerminal("checking", undefined, 1)), { status: 202 });
        }
        return new Response(JSON.stringify(failedState()), { status: 200 });
      }
    });

    await expect(driver.submitTerminalCommand(blockId, "good command", { complete: false, expectedFeedback: /temporarily unavailable/ })).rejects.toThrow(/repeatedly returned transient tutor failure/);
    expect(posts).toBe(2);
  });

  it("aborts a transient terminal retry without recording late retry state", async () => {
    const transient = "Review is temporarily unavailable. Please run the command again in a moment.";
    const abort = trackedAbortController();
    let retrySignal: AbortSignal | undefined;
    let resolveRetry!: (response: Response) => void;
    const withFailure = stateWithTerminal("feedback", transient, 1);
    withFailure.timeline = [{ type: "tutor_failed", id: "failure-row", failureId: "failure-row", sequence: 7, at: "public-at", lessonId: "001-public-contract", blockId, operation: "review", publicMessage: transient }];
    const states = [stateWithTerminal("checking", undefined, 0), withFailure];
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-transient-abort");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      signal: abort.signal,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      transientTerminalReviewRetryDelayMs: 0,
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          retrySignal = init.signal as AbortSignal;
          return new Promise<Response>((resolve) => { resolveRetry = resolve; });
        }
        return new Response(JSON.stringify(states.shift() ?? withFailure), { status: 200 });
      }
    });

    const pending = driver.submitTerminalCommand(blockId, "good command", { complete: false });
    while (!retrySignal) await new Promise((resolve) => setTimeout(resolve, 1));
    abort.abort(new Error("private abort diagnostic"));
    resolveRetry(new Response(JSON.stringify(stateWithTerminal("complete", "Late accepted.", 1)), { status: 202 }));
    await expect(pending).rejects.toThrow("Authored workbook driver operation was cancelled.");
    await allowLateCallbacks();

    expect(retrySignal.aborted).toBe(true);
    expect(trace.publicStates.map((entry) => entry.label)).not.toContain("terminal:lesson--001-public-contract--terminal:transient-review-retry:1");
    expect(JSON.stringify(trace.publicStates)).not.toContain("Late accepted.");
    expect(abort.listenerBalance()).toBe(0);
  });

  it("applies private terminal activation only to socket bytes and redacts it from trace/state", async () => {
    const activation = "export AUTHORED_EVAL_COMMAND_STUB_CONFIG=/workspace/private/config.json; export PATH=/workspace/private/bin:$PATH";
    class CapturingWebSocket extends ReplayWebSocket {
      static instances: CapturingWebSocket[] = [];
      constructor() { super(); CapturingWebSocket.instances.push(this); }
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
        this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: `${activation}\r\nlogical output\r\n` })));
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("private-terminal-prefix");
    const states = [stateWithTerminal("running"), stateWithTerminal("checking", activation, 1), stateWithTerminal("complete", `${activation} Accepted.`, 2)];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: CapturingWebSocket as any,
      privateTerminalShellPrefix: activation,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", `${activation} Accepted.`, 2)), { status: 200 })
    });

    await driver.submitTerminalCommand(blockId, "echo logical", { complete: false });

    expect(CapturingWebSocket.instances[0]?.sent).toEqual([{ type: "input", data: `${activation}\necho logical\r` }]);
    const serializedTrace = JSON.stringify(trace);
    expect(serializedTrace).not.toContain("AUTHORED_EVAL_COMMAND_STUB_CONFIG");
    expect(serializedTrace).not.toContain("/workspace/private/config.json");
    expect(trace.terminalTranscript).toEqual([
      { blockId, direction: "input", text: "echo logical\r" },
      { blockId, direction: "output", text: "logical output\r\n" }
    ]);
  });

  it("does not send or record input when a terminal busy frame arrives before the open callback", async () => {
    class EarlyBusyWebSocket extends ReplayWebSocket {
      static instances: EarlyBusyWebSocket[] = [];
      constructor() {
        super();
        EarlyBusyWebSocket.instances.push(this);
      }
      override once(event: string, callback: (...args: any[]) => void): void {
        if (event !== "open") return super.once(event, callback);
        return super.once(event, (...args: any[]) => {
          this.emit("message", Buffer.from(JSON.stringify({ type: "busy", message: "Terminal is already busy." })));
          callback(...args);
        });
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-early-busy");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: EarlyBusyWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(stateWithTerminal("running")), { status: 200 })
    });

    await expect(driver.submitTerminalCommand(blockId, "should not send", { complete: false })).rejects.toThrow("Terminal is already busy.");

    expect(EarlyBusyWebSocket.instances[0]?.sent).toEqual([]);
    expect(trace.terminalTranscript).toEqual([{ blockId, direction: "observer", text: "Terminal is already busy." }]);
  });

  it("ignores pre-send replay output but records post-send output", async () => {
    class EarlyReplayOutputWebSocket extends ReplayWebSocket {
      override once(event: string, callback: (...args: any[]) => void): void {
        if (event !== "open") return super.once(event, callback);
        return super.once(event, (...args: any[]) => {
          this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "stale replay output\r\n" })));
          callback(...args);
        });
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-replay-output");
    const states = [stateWithTerminal("complete", "Accepted.", 1), stateWithTerminal("complete", "Accepted.", 2)];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: EarlyReplayOutputWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", "Accepted.", 2)), { status: 200 })
    });

    await driver.submitTerminalCommand(blockId, "command", { complete: false });

    expect(trace.terminalTranscript).toEqual([
      { blockId, direction: "input", text: "command\r" },
      { blockId, direction: "output", text: "visible output\r\n" }
    ]);
  });

  it("completes repeated identical terminal results with no intermediate public state when the public revision advances", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-identical-complete");
    const states = [
      stateWithTerminal("complete", "Accepted.", 0),
      stateWithTerminal("complete", "Accepted.", 1),
      stateWithTerminal("complete", "Accepted.", 1),
      stateWithTerminal("complete", "Accepted.", 2),
    ];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", "Accepted.", 2)), { status: 200 })
    });

    await driver.submitTerminalCommand(blockId, "same command", { label: "terminal:first", complete: false });
    await driver.submitTerminalCommand(blockId, "same command", { label: "terminal:second", complete: false });

    expect(trace.terminalTranscript).toEqual([
      { blockId, direction: "input", text: "same command\r" },
      { blockId, direction: "output", text: "visible output\r\n" },
      { blockId, direction: "input", text: "same command\r" },
      { blockId, direction: "output", text: "visible output\r\n" }
    ]);
  });

  it("continues terminal blocks after correlated completion by default", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-complete-continues");
    const states = [stateWithTerminal("running"), stateWithTerminal("complete", "Accepted."), stateWithTerminal("complete", "Advanced.")];
    const posted: unknown[] = [];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async (_input, init) => {
        if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", "Advanced.")), { status: 200 });
      }
    });

    const continued = await driver.submitTerminalCommand(blockId, "good command");

    expect(continued.progress.blocks[0]?.terminal).toEqual({ phase: "complete", message: "Advanced." });
    expect(posted).toEqual([{ blockId, action: "continue" }]);
  });

  it("bounds the terminal post-review completion action", async () => {
    const states = [stateWithTerminal("running"), stateWithTerminal("complete", "Accepted.")];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("terminal-complete-timeout"),
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      requestTimeoutMs: 20,
      fetch: async (_input, init) => {
        if (init?.method === "POST") return new Promise<Response>(() => {});
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", "Accepted.")), { status: 200 });
      }
    });

    await expect(driver.submitTerminalCommand(blockId, "good command")).rejects.toThrow("Timed out waiting for workbook HTTP response.");
  });

  it("treats a 409 terminal completion race as success only after the same accepted block advanced", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-complete-409-applied");
    const states = [stateWithTerminal("running"), stateWithTerminal("complete", "Accepted."), stateAfterTerminalAdvanced("Accepted.")];
    const posted: unknown[] = [];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ error: "private active-block race diagnostic" }), { status: 409 });
        }
        return new Response(JSON.stringify(states.shift() ?? stateAfterTerminalAdvanced("Accepted.")), { status: 200 });
      }
    });

    const continued = await driver.submitTerminalCommand(blockId, "good command");

    expect(continued.progress.activeBlockId).toBe("lesson--001-public-contract--next");
    expect(posted).toEqual([{ blockId, action: "continue" }]);
    expect(JSON.stringify(trace.publicStates)).not.toContain("private active-block race diagnostic");
    expect(trace.publicStates.map((entry) => entry.label)).toContain(`terminal:${blockId}:complete:conflict-state`);
  });

  it("does not swallow a genuine 409 terminal completion conflict", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-complete-409-conflict");
    const states = [stateWithTerminal("running"), stateWithTerminal("complete", "Accepted."), stateWithTerminal("feedback", "Still active feedback.", 2)];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async (_input, init) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ error: "private body" }), { status: 409, statusText: "private status" });
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("feedback", "Still active feedback.", 2)), { status: 200 });
      }
    });

    const pending = driver.submitTerminalCommand(blockId, "good command");
    await expect(pending).rejects.toThrow("POST /api/workbook/events failed with HTTP 409.");
    await expect(pending).rejects.not.toThrow(/private body|private status/);
  });

  it("accepts identical repeated terminal feedback when the public revision advances", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-identical-feedback");
    const states = [stateWithTerminal("feedback", "Use the visible filename.", 1), stateWithTerminal("feedback", "Use the visible filename.", 2)];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(states.shift() ?? stateWithTerminal("feedback", "Use the visible filename.", 2)), { status: 200 })
    });

    const reviewed = await driver.submitTerminalCommand(blockId, "bad command", { complete: false, expectedFeedback: "visible filename" });

    expect(reviewed.progress.blocks[0]?.terminal).toEqual({ phase: "feedback", message: "Use the visible filename." });
  });

  it("does not let post-send output authorize stale complete; it waits through checking for new feedback", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-stale-complete-after-output");
    const states = [
      stateWithTerminal("complete", "Accepted."),
      stateWithTerminal("complete", "Accepted."),
      stateWithTerminal("checking"),
      stateWithTerminal("feedback", "Run the visible command."),
    ];
    let reads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        reads += 1;
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("feedback", "Run the visible command.")), { status: 200 });
      }
    });

    const reviewed = await driver.submitTerminalCommand(blockId, "retry command", { complete: false, expectedFeedback: "visible command" });

    expect(reads).toBe(4);
    expect(reviewed.progress.blocks[0]?.terminal).toEqual({ phase: "feedback", message: "Run the visible command." });
    expect(trace.publicStates.map((entry) => entry.label)).toEqual([
      "terminal:lesson--001-public-contract--terminal:baseline",
      "terminal:lesson--001-public-contract--terminal:reviewed:2",
      "terminal:lesson--001-public-contract--terminal:reviewed:3",
    ]);
  });

  it("does not let post-send output authorize stale feedback; it waits through checking for new completion", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-stale-feedback-after-output");
    const states = [
      stateWithTerminal("feedback", "Old visible feedback."),
      stateWithTerminal("feedback", "Old visible feedback."),
      stateWithTerminal("checking"),
      stateWithTerminal("complete", "Accepted."),
    ];
    let reads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        reads += 1;
        return new Response(JSON.stringify(states.shift() ?? stateWithTerminal("complete", "Accepted.")), { status: 200 });
      }
    });

    const reviewed = await driver.submitTerminalCommand(blockId, "fixed command", { complete: false });

    expect(reads).toBe(4);
    expect(reviewed.progress.blocks[0]?.terminal).toEqual({ phase: "complete", message: "Accepted." });
    expect(trace.publicStates.map((entry) => entry.label)).toEqual([
      "terminal:lesson--001-public-contract--terminal:baseline",
      "terminal:lesson--001-public-contract--terminal:reviewed:2",
      "terminal:lesson--001-public-contract--terminal:reviewed:3",
    ]);
  });

  it("times out instead of accepting identical stale final state with only post-send output", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-stale-final-output-only");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 80,
      fetch: async () => new Response(JSON.stringify(stateWithTerminal("complete", "Accepted.")), { status: 200 })
    });

    await expect(driver.submitTerminalCommand(blockId, "stale command", { complete: false })).rejects.toThrow(/Timed out waiting for terminal review/);
    expect(trace.terminalTranscript).toEqual([
      { blockId, direction: "input", text: "stale command\r" },
      { blockId, direction: "output", text: "visible output\r\n" }
    ]);
  });

  it("drops frames buffered during send if the send ultimately fails", async () => {
    class ThrowAfterOutputWebSocket extends ReplayWebSocket {
      override send(): void {
        this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "should not be recorded\r\n" })));
        throw new Error("send failed after sync output");
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-send-throws-buffered");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ThrowAfterOutputWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(stateWithTerminal("running")), { status: 200 })
    });

    await expect(driver.submitTerminalCommand(blockId, "not sent", { complete: false })).rejects.toThrow(`Workbook terminal socket send failed before terminal review completed for ${blockId}.`);
    expect(trace.terminalTranscript).toEqual([]);
  });

  it("does not commit terminal input when send synchronously closes the socket", async () => {
    class SyncCloseWebSocket extends ReplayWebSocket {
      static instances: SyncCloseWebSocket[] = [];
      constructor() {
        super();
        SyncCloseWebSocket.instances.push(this);
      }
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
        this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "sync output must be dropped\r\n" })));
        this.close();
        setTimeout(() => this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "late output must be dropped\r\n" }))), 1);
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-sync-close-during-send");
    let fetchReads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: SyncCloseWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        fetchReads += 1;
        return new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 });
      }
    });

    await expect(driver.submitTerminalCommand(blockId, "close before commit", { complete: false })).rejects.toThrow(`Workbook terminal socket closed before terminal review completed for ${blockId}.`);
    await allowLateCallbacks();

    expect(fetchReads).toBe(1);
    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["terminal:lesson--001-public-contract--terminal:baseline"]);
    expect(trace.terminalTranscript).toEqual([]);
    expect(SyncCloseWebSocket.instances[0]?.closeCalls).toBe(1);
    expect(SyncCloseWebSocket.instances[0]?.listenerCount()).toBe(0);
  });

  it("does not commit terminal input when send synchronously emits a socket error", async () => {
    class SyncErrorWebSocket extends ReplayWebSocket {
      static instances: SyncErrorWebSocket[] = [];
      constructor() {
        super();
        SyncErrorWebSocket.instances.push(this);
      }
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
        this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "sync output must be dropped\r\n" })));
        this.emit("error", new Error("private socket diagnostic"));
        setTimeout(() => this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "late output must be dropped\r\n" }))), 1);
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-sync-error-during-send");
    let fetchReads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: SyncErrorWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        fetchReads += 1;
        return new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 });
      }
    });

    const pending = driver.submitTerminalCommand(blockId, "error before commit", { complete: false });
    await expect(pending).rejects.toThrow(`Workbook terminal socket errored before terminal review completed for ${blockId}.`);
    await expect(pending).rejects.not.toThrow(/private socket diagnostic/);
    await allowLateCallbacks();

    expect(fetchReads).toBe(1);
    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["terminal:lesson--001-public-contract--terminal:baseline"]);
    expect(trace.terminalTranscript).toEqual([]);
    expect(SyncErrorWebSocket.instances[0]?.closeCalls).toBe(1);
    expect(SyncErrorWebSocket.instances[0]?.listenerCount()).toBe(0);
  });

  it("does not commit terminal input or buffered output when send synchronously throws", async () => {
    class SyncThrowWebSocket extends ReplayWebSocket {
      static instances: SyncThrowWebSocket[] = [];
      constructor() {
        super();
        SyncThrowWebSocket.instances.push(this);
      }
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
        this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "sync output must be dropped\r\n" })));
        setTimeout(() => this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "late output must be dropped\r\n" }))), 1);
        throw new Error("send failed before input commit");
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-sync-throw-during-send");
    let fetchReads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: SyncThrowWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        fetchReads += 1;
        return new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 });
      }
    });

    await expect(driver.submitTerminalCommand(blockId, "throw before commit", { complete: false })).rejects.toThrow(`Workbook terminal socket send failed before terminal review completed for ${blockId}.`);
    await allowLateCallbacks();

    expect(fetchReads).toBe(1);
    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["terminal:lesson--001-public-contract--terminal:baseline"]);
    expect(trace.terminalTranscript).toEqual([]);
    expect(SyncThrowWebSocket.instances[0]?.closeCalls).toBe(1);
    expect(SyncThrowWebSocket.instances[0]?.listenerCount()).toBe(0);
  });

  it("does not commit terminal input when abort settles during send", async () => {
    const abort = trackedAbortController();
    class AbortDuringSendWebSocket extends ReplayWebSocket {
      static instances: AbortDuringSendWebSocket[] = [];
      constructor() {
        super();
        AbortDuringSendWebSocket.instances.push(this);
      }
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
        abort.abort(new Error("private abort diagnostic"));
        this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "sync output must be dropped\r\n" })));
        setTimeout(() => this.emit("message", Buffer.from(JSON.stringify({ type: "output", data: "late output must be dropped\r\n" }))), 1);
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-abort-during-send");
    let fetchReads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      signal: abort.signal,
      WebSocket: AbortDuringSendWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        fetchReads += 1;
        return new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 });
      }
    });

    const pending = driver.submitTerminalCommand(blockId, "abort before commit", { complete: false });
    await expect(pending).rejects.toThrow("Authored workbook driver operation was cancelled.");
    await expect(pending).rejects.not.toThrow(/private abort diagnostic/);
    await allowLateCallbacks();

    expect(fetchReads).toBe(1);
    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["terminal:lesson--001-public-contract--terminal:baseline"]);
    expect(trace.terminalTranscript).toEqual([]);
    expect(AbortDuringSendWebSocket.instances[0]?.closeCalls).toBe(1);
    expect(AbortDuringSendWebSocket.instances[0]?.listenerCount()).toBe(0);
    expect(abort.listenerBalance()).toBe(0);
  });

  it("ignores stale terminal feedback until a correlated new attempt appears", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-stale-feedback");
    const oldFeedback = stateWithTerminal("feedback", "Use the visible filename.");
    const staleFeedbackWithUnrelatedTimeline = stateWithTerminal("feedback", "Use the visible filename.");
    staleFeedbackWithUnrelatedTimeline.timeline = [{ type: "message", id: "unrelated", sequence: 11, at: "public-at", lessonId: "001-public-contract", blockId, role: "assistant", source: "main_tutor", presentation: "chat", text: "Unrelated public text for the same block." }];
    const checking = stateWithTerminal("checking");
    const repeatedFeedback = stateWithTerminal("feedback", "Use the visible filename.");
    repeatedFeedback.timeline = [{ type: "message", id: "new-feedback", sequence: 12, at: "public-at", lessonId: "001-public-contract", blockId, role: "assistant", source: "main_tutor", presentation: "review", text: "Use the visible filename." }];
    const states = [oldFeedback, staleFeedbackWithUnrelatedTimeline, checking, repeatedFeedback];
    class SilentWebSocket extends ReplayWebSocket {
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
      }
    }
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: SilentWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(states.shift() ?? repeatedFeedback), { status: 200 })
    });

    const reviewed = await driver.submitTerminalCommand(blockId, "retry command", { complete: false, expectedFeedback: "visible filename" });

    expect(reviewed.progress.blocks[0]?.terminal).toEqual({ phase: "feedback", message: "Use the visible filename." });
    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["terminal:lesson--001-public-contract--terminal:baseline", "terminal:lesson--001-public-contract--terminal:reviewed:1", "terminal:lesson--001-public-contract--terminal:reviewed:2", "terminal:lesson--001-public-contract--terminal:reviewed:3"]);
  });

  it("treats public terminal exit as immediate command failure while keeping the transcript", async () => {
    class ExitWebSocket extends ReplayWebSocket {
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
        this.emit("message", Buffer.from(JSON.stringify({ type: "exit", exitCode: 2, signal: 9 })));
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-exit");
    let fetchReads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ExitWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        fetchReads += 1;
        return new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 });
      }
    });

    await expect(driver.submitTerminalCommand(blockId, "exit command", { complete: false })).rejects.toThrow(/exited with code 2 signal 9/);
    expect(fetchReads).toBe(1);
    expect(trace.terminalTranscript).toEqual([
      { blockId, direction: "input", text: "exit command\r" },
      { blockId, direction: "observer", text: "exit:2 signal:9" }
    ]);
  });

  it("fails when the terminal socket closes before correlated review completes", async () => {
    class CloseWebSocket extends ReplayWebSocket {
      override send(data: string): void {
        this.sent.push(JSON.parse(data));
        this.close();
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-close");
    let fetchReads = 0;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: CloseWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => {
        fetchReads += 1;
        return new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 });
      }
    });

    await expect(driver.submitTerminalCommand(blockId, "close command", { complete: false })).rejects.toThrow(/socket closed before terminal review completed/);
    expect(fetchReads).toBe(1);
  });

  it("bounds a stalled baseline state read with the terminal review timeout", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-stalled-baseline");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 30,
      fetch: async () => new Promise<Response>(() => {})
    });

    await expect(driver.submitTerminalCommand(blockId, "never read baseline", { complete: false })).rejects.toThrow(/Timed out waiting for terminal review/);
    expect(trace.terminalTranscript).toEqual([]);
  });

  it("does not record terminal input when socket send throws", async () => {
    class ThrowingSendWebSocket extends ReplayWebSocket {
      override send(): void {
        throw new Error("send failed");
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-send-throws");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ThrowingSendWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 })
    });

    await expect(driver.submitTerminalCommand(blockId, "not sent", { complete: false })).rejects.toThrow("send failed");
    expect(trace.terminalTranscript).toEqual([]);
  });

  it("rejects unexpected terminal feedback with the public feedback message", async () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-unexpected-feedback");
    const states = [stateWithTerminal("complete", "At rest."), stateWithTerminal("checking"), stateWithTerminal("feedback", "Visible retry guidance.")];
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: ReplayWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(states.shift() ?? stateWithTerminal("feedback", "Visible retry guidance.")), { status: 200 })
    });

    await expect(driver.submitTerminalCommand(blockId, "bad command", { complete: false })).rejects.toThrow("Visible retry guidance.");
  });

  it("fails closed when terminal socket sends non-JSON instead of a public frame", async () => {
    class BadWebSocket extends ReplayWebSocket {
      override send(): void {
        setTimeout(() => (this as any).handlers.get("message")?.forEach((handler: (...args: unknown[]) => void) => handler(Buffer.from("not json"))), 1);
      }
    }
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("terminal-bad-frame");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      WebSocket: BadWebSocket as any,
      terminalTimeoutMs: 100,
      terminalReviewTimeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(stateWithTerminal("checking")), { status: 200 })
    });

    await expect(driver.submitTerminalCommand(blockId, "bad command", { complete: false })).rejects.toThrow(/non-JSON|JSON/);
  });

  it("aborts before HTTP work starts with a fixed sanitized error", async () => {
    const abort = new AbortController();
    abort.abort(new Error("private reason"));
    let fetchCalled = false;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("abort-before"),
      signal: abort.signal,
      fetch: async () => { fetchCalled = true; return new Response(JSON.stringify(stateWithTerminal("running")), { status: 200 }); }
    });

    await expect(driver.readState("aborted")).rejects.toThrow("Authored workbook driver operation was cancelled.");
    expect(fetchCalled).toBe(false);
  });

  it("aborts a stalled HTTP fetch and removes external abort listeners", async () => {
    const abort = trackedAbortController();
    let fetchSignal: AbortSignal | undefined;
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace: createEmptyAuthoredWorkbookEvalSessionTrace("abort-fetch"),
      signal: abort.signal,
      requestTimeoutMs: 10_000,
      fetch: async (_input, init) => {
        fetchSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>(() => {});
      }
    });

    const pending = driver.readState("stalled");
    while (!fetchSignal) await new Promise((resolve) => setTimeout(resolve, 1));
    abort.abort();

    await expect(pending).rejects.toThrow("Authored workbook driver operation was cancelled.");
    expect(fetchSignal.aborted).toBe(true);
    expect(abort.listenerBalance()).toBe(0);
  });

  it("aborts during editor-review polling without recording stale review transitions", async () => {
    const abort = trackedAbortController();
    let pollStarted = false;
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("abort-poll");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      signal: abort.signal,
      editorReviewTimeoutMs: 10_000,
      fetch: async (_input, init) => {
        if (init?.method === "POST") return new Response(JSON.stringify(stateWithEditor(1, "reviewing")), { status: 200 });
        pollStarted = true;
        return new Promise<Response>(() => {});
      }
    });

    const pending = driver.submitEditorDraft("lesson--001-public-contract--editor", "draft");
    while (!pollStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    abort.abort();

    await expect(pending).rejects.toThrow("Authored workbook driver operation was cancelled.");
    expect(trace.editors).toEqual([{ blockId: "lesson--001-public-contract--editor", revision: 1, status: "reviewing" }]);
    expect(abort.listenerBalance()).toBe(0);
  });

  it("aborts terminal baseline/review work, closes the socket, and records no stale terminal transition", async () => {
    const abort = trackedAbortController();
    class StalledTerminalWebSocket extends ReplayWebSocket {
      static instances: StalledTerminalWebSocket[] = [];
      closed = false;
      constructor() {
        super();
        StalledTerminalWebSocket.instances.push(this);
      }
      override close(): void {
        this.closed = true;
        super.close();
      }
    }
    let fetchStarted = false;
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("abort-terminal");
    const driver = new AuthoredWorkbookDriver({
      serverUrl: "http://workbook.invalid",
      trace,
      signal: abort.signal,
      WebSocket: StalledTerminalWebSocket as any,
      terminalTimeoutMs: 1_000,
      terminalReviewTimeoutMs: 10_000,
      fetch: async () => {
        fetchStarted = true;
        return new Promise<Response>(() => {});
      }
    });

    const pending = driver.submitTerminalCommand(blockId, "never sent", { complete: false });
    while (!fetchStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    abort.abort();

    await expect(pending).rejects.toThrow("Authored workbook driver operation was cancelled.");
    expect(StalledTerminalWebSocket.instances[0]?.closed).toBe(true);
    expect(StalledTerminalWebSocket.instances[0]?.sent).toEqual([]);
    expect(trace.terminalTranscript).toEqual([]);
    expect(abort.listenerBalance()).toBe(0);
  });
});

async function allowLateCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function trackedAbortController(): AbortController & { listenerBalance(): number } {
  const controller = new AbortController() as AbortController & { listenerBalance(): number };
  const signal = controller.signal as AbortSignal & {
    addEventListener: AbortSignal["addEventListener"];
    removeEventListener: AbortSignal["removeEventListener"];
  };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let balance = 0;
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "abort") balance += 1;
    return add(type, listener, options);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "abort") balance -= 1;
    return remove(type, listener, options);
  }) as AbortSignal["removeEventListener"];
  controller.listenerBalance = () => balance;
  return controller;
}
