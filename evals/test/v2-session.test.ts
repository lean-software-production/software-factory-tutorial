import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbook } from "../../tutorial-engine/src/workbook/load.js";
import type { WorkbookServerOptions } from "../../tutorial-engine/src/workbook/server.js";
import type { TutorDecision } from "../../tutorial-engine/src/workbook/tutor.js";
import { RecordingMainTutor } from "../../tutorial-engine/test/support/fake-tutors.js";
import { createEmptyV2SessionTrace, readWorkbookTimeline, recordPublicState, snapshotArtifacts } from "../v2/session.js";
import { createEvaluationWorkspace } from "../v2/workspace.js";

const tempRoots: string[] = [];
class SessionFakeMainTutor extends RecordingMainTutor {
  protected override defaultReply = "Public fake tutor reply.";
  protected override blockSummaryFor = () => "Public fake block summary.";
  protected override lessonSummaryFor = () => "Public fake lesson summary.";
  protected override async decide(): Promise<TutorDecision> { return { outcome: "working" }; }
}

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("v2 session workspace", () => {
  it("copies the evaluator workbook into an isolated disposable workspace", async () => {
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.repositoryRoot);

    expect(workspace.root).toBe(resolve(workspace.repositoryRoot, "tutorial"));
    const workbook = await loadWorkbook(workspace.root);
    expect(workbook.identity.title).toBe("V2 Live Evaluator Workbook");
    expect(workbook.workspace).toBe(await realpath(workspace.root));
    expect((await stat(resolve(workspace.webRoot, "index.html"))).isFile()).toBe(true);

    const copiedWorkbookPath = resolve(workspace.root, "workbook.md");
    const fixtureWorkbookPath = resolve(import.meta.dirname, "../workbook/workbook.md");
    await writeFile(copiedWorkbookPath, "---\n---\n# Mutated copy\n\nOnly the temp copy changed.\n");

    expect(await readFile(fixtureWorkbookPath, "utf8")).toContain("# V2 Live Evaluator Workbook");
    expect(await readFile(fixtureWorkbookPath, "utf8")).not.toContain("# Mutated copy");

    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });
});

describe("v2 public session trace", () => {
  it("deduplicates repeated public state polls while preserving changed states", () => {
    const trace = createEmptyV2SessionTrace("dedupe");

    recordPublicState(trace, "poll:1", { progress: { activeBlockId: "reflection" } });
    recordPublicState(trace, "poll:2", { progress: { activeBlockId: "reflection" } });
    recordPublicState(trace, "poll:3", { progress: { activeBlockId: "transition" } });

    expect(trace.publicStates.map((entry) => entry.label)).toEqual(["poll:1", "poll:3"]);
  });

  it("records only public workbook state and rejects private tutor fields", async () => {
    const trace = createEmptyV2SessionTrace("public-state");
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.repositoryRoot);
    const server = await workspace.startServer({
      embeddedTerminal: false,
      mainTutor: new SessionFakeMainTutor(),
      practiceCoach: { assess: async () => ({ outcome: "ready" as const, text: "Ready for Main Tutor review." }) }
    });
    try {
      let state = await fetch(`${server.url}/api/workbook/state`).then((response) => response.json() as any);
      while (state.progress.activeBlockId !== "lesson--001-live-session--editor-practice") {
        const result = await fetch(`${server.url}/api/workbook/complete-block`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blockId: state.progress.activeBlockId })
        }).then((response) => response.json() as any);
        state = result.state;
      }

      recordPublicState(trace, "exact-command-visible", state);
      const session = workspace.latestSession();
      trace.events = await readWorkbookTimeline(session.sessionRoot);

      expect(session.contentRoot).toBe(await realpath(workspace.root));
      expect(session.workspaceRoot).toBe(resolve(session.sessionRoot, "workspace"));
      await expect(stat(resolve(session.workspaceRoot, "factory"))).resolves.toBeDefined();
      await expect(stat(resolve(session.workspaceRoot, "calculator"))).resolves.toBeDefined();

      expect(trace).toMatchObject({
        scenarioId: "public-state",
        publicStates: [{ label: "exact-command-visible", state: expect.objectContaining({ workbook: { title: "V2 Live Evaluator Workbook" } }) }],
        terminalTranscript: [],
        reflections: [],
        editors: [],
        events: expect.arrayContaining([expect.objectContaining({ type: "session_started" }), expect.objectContaining({ type: "block_completed", blockId: "workbook--introduction" }), expect.objectContaining({ type: "block_completed", blockId: "lesson--001-live-session--orientation" })]),
        artifacts: []
      });
      const serialized = JSON.stringify(trace);
      expect(serialized).toContain("Draft the editor artifact");
      expect(serialized).toContain("editor-artifacts/evaluator-editor.txt");
      expect(serialized).not.toContain("Private editor criterion");
      expect(serialized).not.toContain("This is private tutor guidance");
      expect(serialized).not.toContain("Do not reveal an exact command");
      expect(serialized).not.toContain("Follow up until the learner");
      expect(serialized).toContain('"source":"authored"');

      expect(() => recordPublicState(trace, "leaky", { tutor: "private tutor guidance" })).toThrow(/private tutor/i);
    } finally {
      await server.close();
      await workspace.close();
      tempRoots.length = 0;
    }
  });

  it("rejects private tutor text in workbook events before they enter the trace", async () => {
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.repositoryRoot);
    const server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new SessionFakeMainTutor() });
    await server.close();
    const { sessionRoot } = workspace.latestSession();
    await mkdir(resolve(sessionRoot, "workbook"), { recursive: true });
    await writeFile(resolve(sessionRoot, "workbook/events.jsonl"), `${JSON.stringify({
      type: "observation_verified",
      at: "2026-08-20T00:00:00.000Z",
      lessonId: "001-live-session",
      blockId: "exact-command",
      source: "terminal_observer",
      summary: "This is private tutor guidance for the live evaluator's exact-command scenario.",
      terminalHtml: ""
    })}\n`);

    await expect(readWorkbookTimeline(sessionRoot)).rejects.toThrow(/private tutor/i);

    await workspace.close();
    tempRoots.length = 0;
  });

  it("snapshots only disposable artifacts from the evaluation workspace", async () => {
    const trace = createEmptyV2SessionTrace("artifacts");
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.repositoryRoot);
    const server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new SessionFakeMainTutor() });
    await server.close();
    const { workspaceRoot } = workspace.latestSession();
    await mkdir(resolve(workspaceRoot, "factory/.tmp"), { recursive: true });
    await mkdir(resolve(workspaceRoot, "editor-artifacts"), { recursive: true });
    await writeFile(resolve(workspaceRoot, "factory/.tmp/evaluator-command.txt"), "command block complete\n");
    await writeFile(resolve(workspaceRoot, "editor-artifacts/evaluator-editor.txt"), "editor draft complete\n");

    trace.artifacts = await snapshotArtifacts(workspaceRoot);

    expect(trace.artifacts).toEqual([
      { path: "editor-artifacts/evaluator-editor.txt", content: "editor draft complete\n" },
      { path: "factory/.tmp/evaluator-command.txt", content: "command block complete\n" }
    ]);
    expect(JSON.stringify(trace)).not.toContain("private tutor guidance");

    await workspace.close();
    tempRoots.length = 0;
  });
});
