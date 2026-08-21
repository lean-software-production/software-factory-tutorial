import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalPty } from "../../tutorial-engine/src/workbook/terminal.js";
import type { TutorDecision, TutorReview, WorkbookTutor } from "../../tutorial-engine/src/workbook/tutor.js";
import { createV2WorkbookDriver, V2WorkbookDriver } from "../v2/driver.js";
import { clueCommand, exactCommand, satisfactoryEditorDraft } from "../v2/scenarios.js";
import { createEmptyV2SessionTrace } from "../v2/session.js";
import { createEvaluationWorkspace, type CreateEvaluationWorkspaceOptions } from "../v2/workspace.js";

class DriverFakeTutor implements WorkbookTutor {
  readonly reviews: TutorReview[] = [];
  compactions = 0;
  disposed = false;

  async review(input: TutorReview): Promise<TutorDecision> {
    this.reviews.push(input);
    const { evidence } = input.attempt;
    if (evidence.kind === "editor") {
      if (evidence.text.includes("editor-artifacts/evaluator-editor.txt") && evidence.text.includes("ready for promotion")) return { accepted: true, feedback: "Editor artifact accepted for promotion." };
      return { accepted: false, feedback: "Name editor-artifacts/evaluator-editor.txt and explain the promotion intent." };
    }
    if (evidence.kind === "terminal") {
      if (input.attempt.blockId === "exact-command" && evidence.transcript.includes("evaluator-command.txt") && evidence.transcript.includes("command block complete")) return { accepted: true, feedback: "verified exact-command" };
      if (input.attempt.blockId === "clue-only" && evidence.transcript.includes("evaluator-clue.txt") && evidence.transcript.includes("clue block complete")) return { accepted: true, feedback: "verified clue-only" };
      return { accepted: false, feedback: `Keep working on ${input.attempt.blockId}.` };
    }
    return { accepted: false, feedback: "Tutor reply that asks one public follow-up." };
  }

  async compactAfterBlock(): Promise<void> { this.compactions++; }
  dispose(): void { this.disposed = true; }
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
  const workbookTutor = new DriverFakeTutor();
  const server = await workspace.startServer({
    terminalPtyFactory: () => pty,
    terminalDebounceMs: 1,
    workbookTutor
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
    const { server, trace, driver, workbookTutor } = await startDriver();
    try {
      await driver.completeIntroduction();
      await driver.continueBlock("orientation");

      const reviewed = await driver.submitEditorDraft("editor-practice", "This is a vague draft.");

      const editorBlock = reviewed.progress.blocks.find((block: any) => block.id === "editor-practice");
      expect(editorBlock).toMatchObject({ active: true, completed: false, editorStatus: "feedback", revision: 1, checkpoint: { status: "feedback", feedback: expect.stringContaining("editor-artifacts/evaluator-editor.txt") } });
      expect(trace.editors).toEqual([
        { blockId: "editor-practice", revision: 1, status: "reviewing" },
        { blockId: "editor-practice", revision: 1, status: "feedback", feedback: "Name editor-artifacts/evaluator-editor.txt and explain the promotion intent." }
      ]);
      expect(workbookTutor.reviews).toHaveLength(1);
      expect(workbookTutor.reviews[0]).toMatchObject({ privateGuidance: expect.stringContaining("Private editor criterion"), attempt: { evidence: { kind: "editor", text: "This is a vague draft." } } });
      expect(JSON.stringify(trace)).not.toContain("Private editor criterion");
      expect(JSON.stringify(trace)).not.toContain('"tutor"');
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

  it("submits reflections and records the public learner/tutor conversation", async () => {
    const { server, trace, driver, workbookTutor } = await startDriver();
    try {
      await reachReflection(driver);

      const discussed = await driver.submitReflection("reflection", "The exact block gave a command; the clue block required me to choose one.");

      expect(discussed.progress.activeBlockId).toBe("reflection");
      expect(trace.reflections).toEqual([
        { blockId: "reflection", role: "learner", text: "The exact block gave a command; the clue block required me to choose one." },
        { blockId: "reflection", role: "tutor", text: "Tutor reply that asks one public follow-up." }
      ]);
      expect(workbookTutor.reviews.filter((review) => review.attempt.blockId === "reflection")).toHaveLength(1);
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

      expect(completed.progress.activeBlockId).toBe("clue-only");
      expect(pty.writes).toEqual([`${exactCommand}\r`]);
      expect(workbookTutor.reviews.filter((review) => review.attempt.blockId === "exact-command")).toHaveLength(1);
      expect(trace.terminalTranscript).toEqual(expect.arrayContaining([
        expect.objectContaining({ blockId: "exact-command", direction: "input", text: `${exactCommand}\r` }),
        expect.objectContaining({ blockId: "exact-command", direction: "output", text: expect.stringContaining("ran:mkdir") }),
        expect.objectContaining({ blockId: "exact-command", direction: "observer", text: expect.stringContaining("status:submitted") })
      ]));
      expect(trace.publicStates.map((state) => state.label)).toContain("terminal:exact-command:reviewed:1");
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
