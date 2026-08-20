import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorReviewAdapter, type EditorReviewDecision, type EditorReviewRequest } from "../../tutorial-engine/src/workbook/editor.js";
import type { ReflectionConversationAdapter } from "../../tutorial-engine/src/workbook/reflection.js";
import type { TerminalObserver, TerminalPty } from "../../tutorial-engine/src/workbook/terminal.js";
import { createV2WorkbookDriver, V2WorkbookDriver } from "../v2/driver.js";
import { satisfactoryEditorDraft } from "../v2/scenarios.js";
import { createEmptyV2SessionTrace } from "../v2/session.js";
import { createEvaluationWorkspace, type CreateEvaluationWorkspaceOptions } from "../v2/workspace.js";

class DriverFakeEditorReviewAdapter extends EditorReviewAdapter {
  constructor(readonly calls: EditorReviewRequest[]) {
    super(async () => ({ prompt: async () => "" }));
  }

  override async review(request: EditorReviewRequest): Promise<EditorReviewDecision> {
    this.calls.push(request);
    if (request.draft.text.includes("editor-artifacts/evaluator-editor.txt") && request.draft.text.includes("ready for promotion")) return { status: "unlocked", revisionId: request.draft.revision };
    return { status: "feedback", message: "Name editor-artifacts/evaluator-editor.txt and explain the promotion intent." };
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
  tempRoots.push(workspace.root);
  const pty = new DriverFakePty();
  const terminalRequests: unknown[] = [];
  const terminalObserver: TerminalObserver = {
    observe: async (request) => {
      terminalRequests.push(request);
      return { status: "complete", summary: `verified ${request.blockId}` };
    }
  };
  const reflectionRequests: unknown[] = [];
  const reflectionConversation: ReflectionConversationAdapter = {
    reply: async (request) => {
      reflectionRequests.push(request);
      return "Tutor reply that asks one public follow-up.";
    }
  };
  const editorRequests: EditorReviewRequest[] = [];
  const editorReviewAdapter = new DriverFakeEditorReviewAdapter(editorRequests);
  const server = await workspace.startServer({
    terminalObserver,
    terminalPtyFactory: () => pty,
    terminalDebounceMs: 1,
    reflectionConversation,
    editorReviewAdapter,
    editorReviewDebounceMs: 1
  });
  const trace = createEmptyV2SessionTrace("driver-test");
  const driver = createV2WorkbookDriver({ serverUrl: server.url, trace });
  return { workspace, server, trace, driver, pty, terminalRequests, reflectionRequests, editorRequests };
}

async function reachExactCommand(driver: V2WorkbookDriver) {
  await driver.completeIntroduction();
  await driver.continueBlock("orientation");
  return driver.submitEditorDraft("editor-practice", satisfactoryEditorDraft);
}

async function reachReflection(driver: V2WorkbookDriver) {
  await reachExactCommand(driver);
  await driver.submitTerminalCommand("exact-command", "mkdir -p .tmp && printf 'command block complete\\n' > .tmp/evaluator-command.txt && cat .tmp/evaluator-command.txt");
  await driver.submitTerminalCommand("clue-only", "mkdir -p .tmp && printf 'clue block complete\\n' > .tmp/evaluator-clue.txt && cat .tmp/evaluator-clue.txt");
}

describe("v2 workbook driver", () => {
  it("drives public workbook state and Continue actions through the HTTP API", async () => {
    const { server, trace, driver } = await startDriver();
    try {
      const initial = await driver.readState("initial");
      expect(initial.introductionComplete).toBe(false);

      const introduced = await driver.completeIntroduction();
      expect(introduced.progress.activeBlockId).toBe("orientation");
      expect(introduced.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["orientation"]);

      const continued = await driver.continueBlock("orientation");
      expect(continued.progress.activeBlockId).toBe("editor-practice");
      expect(continued.chapters[0].lesson.blocks.map((block: any) => block.id)).toEqual(["orientation", "editor-practice"]);
      expect(trace.publicStates.map((state) => state.label)).toEqual(["initial", "introduction", "continue:orientation"]);
      expect(JSON.stringify(trace)).not.toContain('"tutor"');
    } finally {
      await server.close();
    }
  });


  it("submits editor drafts and records only public editor feedback", async () => {
    const { server, trace, driver, editorRequests } = await startDriver();
    try {
      await driver.completeIntroduction();
      await driver.continueBlock("orientation");

      const reviewed = await driver.submitEditorDraft("editor-practice", "This is a vague draft.");

      const editorBlock = reviewed.progress.blocks.find((block: any) => block.id === "editor-practice");
      expect(editorBlock).toMatchObject({ active: true, completed: false, editorStatus: "feedback", revision: 1, feedback: expect.stringContaining("editor-artifacts/evaluator-editor.txt") });
      expect(trace.editors).toEqual([
        { blockId: "editor-practice", revision: 1, status: "reviewing" },
        { blockId: "editor-practice", revision: 1, status: "feedback", feedback: "Name editor-artifacts/evaluator-editor.txt and explain the promotion intent." }
      ]);
      expect(editorRequests).toHaveLength(1);
      expect(JSON.stringify(trace)).not.toContain("Private editor criterion");
      expect(JSON.stringify(trace)).not.toContain('"tutor"');
    } finally {
      await server.close();
    }
  });

  it("submits reflections and records the public learner/tutor conversation", async () => {
    const { server, trace, driver, reflectionRequests } = await startDriver();
    try {
      await reachReflection(driver);

      const discussed = await driver.submitReflection("reflection", "The exact block gave a command; the clue block required me to choose one.");

      expect(discussed.progress.activeBlockId).toBe("reflection");
      expect(trace.reflections).toEqual([
        { blockId: "reflection", role: "learner", text: "The exact block gave a command; the clue block required me to choose one." },
        { blockId: "reflection", role: "tutor", text: "Tutor reply that asks one public follow-up." }
      ]);
      expect(reflectionRequests).toHaveLength(1);
      expect(JSON.stringify(trace)).not.toContain("Follow up until the learner");
      expect(JSON.stringify(trace)).not.toContain('"tutor":');
    } finally {
      await server.close();
    }
  });

  it("submits terminal commands over the embedded-terminal WebSocket and records observer completion", async () => {
    const { server, trace, driver, pty, terminalRequests } = await startDriver();
    try {
      await reachExactCommand(driver);

      const completed = await driver.submitTerminalCommand("exact-command", "printf 'command block complete\\n'");

      expect(completed.progress.activeBlockId).toBe("clue-only");
      expect(pty.writes).toEqual(["printf 'command block complete\\n'\r"]);
      expect(terminalRequests).toHaveLength(1);
      expect(trace.terminalTranscript).toEqual(expect.arrayContaining([
        expect.objectContaining({ blockId: "exact-command", direction: "input", text: "printf 'command block complete\\n'\r" }),
        expect.objectContaining({ blockId: "exact-command", direction: "output", text: expect.stringContaining("ran:printf") }),
        expect.objectContaining({ blockId: "exact-command", direction: "observer", text: expect.stringContaining("verified exact-command") })
      ]));
      expect(trace.publicStates.map((state) => state.label)).toContain("terminal:exact-command:verified");
      expect(trace.publicStates.map((state) => state.label)).toContain("terminal:exact-command:complete");
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
