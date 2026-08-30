import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbook } from "../../src/workbook/load.js";
import type { WorkbookServerOptions } from "../../src/workbook/server.js";
import type { TutorDecision } from "../../src/workbook/tutor.js";
import { RecordingMainTutor } from "../../test/support/fake-tutors.js";
import { createEmptyV2SessionTrace, projectV2JudgeTrace, readWorkbookTimeline, recordPublicState, snapshotArtifacts } from "../v2/session.js";
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

  it("records complete browser-public state without vocabulary or key-name bans", async () => {
    const trace = createEmptyV2SessionTrace("public-state");
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.repositoryRoot);
    const server = await workspace.startServer({
      embeddedTerminal: false,
      mainTutor: new SessionFakeMainTutor(),
      practiceCoach: { assess: async () => ({ outcome: "ready" as const, text: "Ready for Main Tutor review." }), dispose() {} }
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
      expect(session.workspaceRoots["refactor-line"]!).toBe(resolve(session.sessionRoot, "workspaces/refactor-line"));
      await expect(stat(resolve(session.workspaceRoots["refactor-line"]!, "factory"))).resolves.toBeDefined();
      await expect(stat(resolve(session.workspaceRoots["refactor-line"]!, "calculator"))).resolves.toBeDefined();

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
      expect(serialized).toContain('"source":"authored"');

      const arbitrary = recordPublicState(trace, "public-prose", {
        tutor: "Public prose may contain a tutor key, This is private tutor guidance, Do not reveal an exact command, Follow up until the learner, Private editor criterion, terminal-command-submitted, Coach handoff, and JSON-looking text like \"tutor\":."
      });
      expect(arbitrary.state).toHaveProperty("tutor");
      expect(JSON.stringify(arbitrary)).toContain("Coach handoff");
    } finally {
      await server.close();
      await workspace.close();
      tempRoots.length = 0;
    }
  });

  it("keeps raw private timeline records internal while projecting only public judge fields", async () => {
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.repositoryRoot);
    const server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new SessionFakeMainTutor() });
    await server.close();
    const { sessionRoot } = workspace.latestSession();
    await mkdir(resolve(sessionRoot, "workbook"), { recursive: true });
    await writeFile(resolve(sessionRoot, "workbook/events.jsonl"), `${JSON.stringify({
      type: "terminal-coach-handoff-recorded",
      id: "raw-id-secret",
      sequence: 42,
      at: "2026-08-20T00:00:00.000Z",
      attemptId: "attempt-secret",
      outcome: "ready",
      text: "private-handoff-secret-for-gate-only-event"
    })}\n${JSON.stringify({
      type: "attempt_accepted",
      id: "raw-accepted-secret",
      sequence: 43,
      at: "2026-08-20T00:00:01.000Z",
      lessonId: "001-live-session",
      blockId: "exact-command",
      attemptId: "attempt-secret",
      version: 1,
      kind: "terminal",
      summary: "accepted summary secret"
    })}\n`);

    const trace = createEmptyV2SessionTrace("raw-internal");
    trace.events = await readWorkbookTimeline(sessionRoot);

    expect(JSON.stringify(trace.events)).toContain("attempt-secret");
    expect(JSON.stringify(trace.events)).toContain("raw-id-secret");
    const projected = projectV2JudgeTrace(trace);
    expect(projected.progressionEvents).toEqual([{ type: "attempt_accepted", lessonId: "001-live-session", blockId: "exact-command", kind: "terminal" }]);
    expect(JSON.stringify(projected)).not.toContain("attempt-secret");
    expect(JSON.stringify(projected)).not.toContain("terminal-coach-handoff-recorded");

    await workspace.close();
    tempRoots.length = 0;
  });

  it("snapshots only disposable artifacts from the evaluation workspace", async () => {
    const trace = createEmptyV2SessionTrace("artifacts");
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.repositoryRoot);
    const server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new SessionFakeMainTutor() });
    await server.close();
    const workspaceRoot = workspace.latestSession().workspaceRoots["refactor-line"]!;
    await mkdir(resolve(workspaceRoot, "factory/.tmp"), { recursive: true });
    await mkdir(resolve(workspaceRoot, "editor-artifacts"), { recursive: true });
    await writeFile(resolve(workspaceRoot, "factory/.tmp/evaluator-command.txt"), "command block complete\n");
    await writeFile(resolve(workspaceRoot, "editor-artifacts/evaluator-editor.txt"), "editor draft complete\n");

    trace.artifacts = await snapshotArtifacts(workspaceRoot);

    expect(trace.artifacts).toEqual([
      { path: "editor-artifacts/evaluator-editor.txt", content: "editor draft complete\n" },
      { path: "factory/.tmp/evaluator-command.txt", content: "command block complete\n" }
    ]);
    expect(JSON.stringify(trace)).not.toContain("private-handoff-secret-for-gate-only-event");

    await workspace.close();
    tempRoots.length = 0;
  });
});
