import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbook } from "../../tutorial-engine/src/workbook/load.js";
import { createEmptyV2SessionTrace, readWorkbookEvents, recordPublicState, snapshotArtifacts } from "../v2/session.js";
import { createEvaluationWorkspace } from "../v2/workspace.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("v2 session workspace", () => {
  it("copies the evaluator workbook into an isolated disposable workspace", async () => {
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.root);

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
    await expect(stat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });
});

describe("v2 public session trace", () => {
  it("records only public workbook state and rejects private tutor fields", async () => {
    const trace = createEmptyV2SessionTrace("public-state");
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.root);
    const server = await workspace.startServer({ embeddedTerminal: false });
    try {
      await fetch(`${server.url}/api/workbook/introduction`, { method: "POST" });
      const state = await fetch(`${server.url}/api/workbook/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId: "orientation", action: "continue" })
      }).then((response) => response.json() as any);

      recordPublicState(trace, "exact-command-visible", state);
      trace.events = await readWorkbookEvents(workspace.root);

      expect(trace).toMatchObject({
        scenarioId: "public-state",
        publicStates: [{ label: "exact-command-visible", state: expect.objectContaining({ workbook: { title: "V2 Live Evaluator Workbook" } }) }],
        terminalTranscript: [],
        reflections: [],
        editors: [],
        events: [expect.objectContaining({ type: "session_started" }), expect.objectContaining({ type: "workbook_introduction_completed" }), expect.objectContaining({ type: "block_continued" })],
        artifacts: []
      });
      const serialized = JSON.stringify(trace);
      expect(serialized).toContain("Draft the editor artifact");
      expect(serialized).toContain("editor-artifacts/evaluator-editor.txt");
      expect(serialized).not.toContain("Private editor criterion");
      expect(serialized).not.toContain("This is private tutor guidance");
      expect(serialized).not.toContain("Do not reveal an exact command");
      expect(serialized).not.toContain("Follow up until the learner");
      expect(serialized).not.toContain('"tutor"');

      expect(() => recordPublicState(trace, "leaky", { tutor: "private tutor guidance" })).toThrow(/private tutor/i);
    } finally {
      await server.close();
      await workspace.close();
      tempRoots.length = 0;
    }
  });

  it("rejects private tutor text in workbook events before they enter the trace", async () => {
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.root);
    await mkdir(resolve(workspace.root, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(resolve(workspace.root, ".tutorial/.tmp/workbook/events.jsonl"), `${JSON.stringify({
      type: "observation_verified",
      at: "2026-08-20T00:00:00.000Z",
      lessonId: "01-evaluator/01-live-session",
      blockId: "exact-command",
      source: "terminal_observer",
      summary: "This is private tutor guidance for the live evaluator's exact-command scenario.",
      terminalHtml: ""
    })}\n`);

    await expect(readWorkbookEvents(workspace.root)).rejects.toThrow(/private tutor/i);

    await workspace.close();
    tempRoots.length = 0;
  });

  it("snapshots only disposable artifacts from the evaluation workspace", async () => {
    const trace = createEmptyV2SessionTrace("artifacts");
    const workspace = await createEvaluationWorkspace();
    tempRoots.push(workspace.root);
    await mkdir(resolve(workspace.root, ".tmp"), { recursive: true });
    await mkdir(resolve(workspace.root, "editor-artifacts"), { recursive: true });
    await writeFile(resolve(workspace.root, ".tmp/evaluator-command.txt"), "command block complete\n");
    await writeFile(resolve(workspace.root, "editor-artifacts/evaluator-editor.txt"), "editor draft complete\n");

    trace.artifacts = await snapshotArtifacts(workspace.root);

    expect(trace.artifacts).toEqual([
      { path: ".tmp/evaluator-command.txt", content: "command block complete\n" },
      { path: "editor-artifacts/evaluator-editor.txt", content: "editor draft complete\n" }
    ]);
    expect(JSON.stringify(trace)).not.toContain("private tutor guidance");

    await workspace.close();
    tempRoots.length = 0;
  });
});
