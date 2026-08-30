import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicWorkbookState } from "../../../tutorial-engine/src/workbook/public-contract.js";
import type { WorkbookTimelineRecord } from "../../../tutorial-engine/src/workbook/timeline.js";
import {
  copyAuthoredWorkbookEvalTrace,
  createEmptyAuthoredWorkbookEvalSessionTrace,
  enumerateAuthoredWorkbookEvalCitations,
  projectAuthoredWorkbookEvalTrace,
  recordAuthoredWorkbookEvalPublicState,
  snapshotAuthoredWorkbookEvalArtifacts
} from "../public-trace.js";
import { readAuthoredWorkbookTimeline } from "../internal-timeline.js";
import { AUTHORED_WORKBOOK_EVAL_MARKERS } from "../types.js";

const lessonId = "001-public-contract";

function record(event: Record<string, unknown>): WorkbookTimelineRecord {
  return { id: "raw-id", sequence: 1, at: "2026-08-29T00:00:00.000Z", ...event } as WorkbookTimelineRecord;
}

function browserPublicState(note = "Public Tutor prose can mention terminal lifecycle, terminal-command-submitted, and JSON-looking \"tutor\":."): PublicWorkbookState {
  return {
    workbook: { title: "Public workbook" },
    introduction: "Intro",
    introductionComplete: true,
    chapters: [],
    progress: {
      activeLessonId: lessonId,
      activeBlockId: "lesson--001-public-contract--terminal",
      completedLessons: [],
      blocks: [],
      reflections: {},
      reflectionConversations: {}
    },
    adapter: { note, tutor: { text: note } },
    timeline: [{ type: "message", id: "visible-message", sequence: 1, at: "public-at", lessonId, blockId: "visible", role: "assistant", source: "main_tutor", presentation: "chat", text: note }]
  } as unknown as PublicWorkbookState;
}

function publicStateWithRawPrivateTimelineEvent(): PublicWorkbookState {
  return {
    ...browserPublicState("Visible prose survives."),
    timeline: [{
      type: "lesson_jump_started",
      id: "private-raw-row",
      sequence: 2,
      at: "2026-08-29T00:00:01.000Z",
      lessonId: "private-lesson-secret",
      blockId: "private-block-secret",
      attemptId: "private-attempt-secret",
      command: "private command secret",
      privatePath: "/private/workbook/path"
    } as any]
  } as PublicWorkbookState;
}

function expectRejectsWithoutPrivateTimelineFields(action: () => unknown): void {
  try { action(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/invalid public state|public state trace entry/i);
    expect(message).not.toMatch(/private-raw-row|private-lesson-secret|private-block-secret|private-attempt-secret|private command secret|\/private\/workbook\/path/);
    return;
  }
  throw new Error("expected public trace validation to reject the private timeline record");
}

describe("authored workbook public eval trace projection", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  it("declares root-owned workbook eval markers", () => {
    expect(AUTHORED_WORKBOOK_EVAL_MARKERS).toEqual({ namespace: "root/workbook", owner: "root", suite: "workbook", schemaVersion: 1 });
  });

  it("preserves complete browser-public workbook states without vocabulary or key-name bans", () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("public-state-vocabulary");
    const state = browserPublicState();
    trace.publicStates.push({ label: "visible", state });

    const projected = projectAuthoredWorkbookEvalTrace(trace);

    expect(projected.publicStates).toEqual([{ label: "visible", state }]);
    expect(JSON.stringify(projected)).toContain("terminal lifecycle");
    expect(JSON.stringify(projected)).toContain("terminal-command-submitted");
    expect(JSON.stringify(projected)).toContain('"tutor"');
  });

  it("rejects malformed plain objects instead of accepting unknown public state inputs", () => {
    expect(() => copyAuthoredWorkbookEvalTrace({
      scenarioId: "malformed-state",
      publicStates: [{ label: "bad", state: { progress: { activeBlockId: "missing-browser-contract" } } }],
      terminalTranscript: [],
      reflections: [],
      editors: [],
      progressionEvents: [],
      artifacts: []
    })).toThrow(/Invalid public state trace entry/);
  });

  it("rejects raw private lesson jump events embedded in direct public state records", () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("raw-public-state-direct");

    expectRejectsWithoutPrivateTimelineFields(() => recordAuthoredWorkbookEvalPublicState(trace, "raw", publicStateWithRawPrivateTimelineEvent()));
    expect(trace.publicStates).toEqual([]);
  });

  it("rejects raw private lesson jump events embedded in copied public state records", () => {
    expectRejectsWithoutPrivateTimelineFields(() => copyAuthoredWorkbookEvalTrace({
      scenarioId: "raw-public-state-copy",
      publicStates: [{ label: "raw", state: publicStateWithRawPrivateTimelineEvent() }],
      terminalTranscript: [],
      reflections: [],
      editors: [],
      progressionEvents: [],
      artifacts: []
    }));
  });

  it("rejects raw private lesson jump events embedded in mixed in-memory traces", () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("raw-public-state-mixed");
    trace.publicStates.push({ label: "raw", state: publicStateWithRawPrivateTimelineEvent() });
    trace.internalEvents.push(record({ type: "workbook_introduction_completed" }));

    expectRejectsWithoutPrivateTimelineFields(() => projectAuthoredWorkbookEvalTrace(trace));
  });

  it("fails hard when authored eval setup uses a lesson jump anywhere", () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("no-jumps");
    trace.internalEvents.push(record({ type: "lesson_jump_started", lessonId: "jump-secret" }));

    expect(() => projectAuthoredWorkbookEvalTrace(trace)).toThrow(/forbids lesson jumps/);
    expect(() => copyAuthoredWorkbookEvalTrace({
      scenarioId: "public-copy",
      publicStates: [],
      terminalTranscript: [],
      reflections: [],
      editors: [],
      progressionEvents: [{ type: "lesson_jump_started", lessonId: "not-dropped" }],
      artifacts: []
    })).toThrow(/lesson_jump_started/);
    expect(() => copyAuthoredWorkbookEvalTrace({
      scenarioId: "mixed-copy",
      publicStates: [],
      terminalTranscript: [],
      reflections: [],
      editors: [],
      progressionEvents: [],
      artifacts: [],
      internalEvents: [{ type: "lesson_jump_started", lessonId: "mixed-secret" }]
    })).toThrow(/lesson_jump_started/);
    expect(() => copyAuthoredWorkbookEvalTrace({
      events: [{ type: "lesson_jump_started", lessonId: "top-level-secret" }]
    })).toThrow(/lesson_jump_started found in events/);
    expect(() => copyAuthoredWorkbookEvalTrace({
      scenarioId: "mixed-events-copy",
      publicStates: [],
      terminalTranscript: [],
      reflections: [],
      editors: [],
      progressionEvents: [],
      artifacts: [],
      events: [{ type: "lesson_jump_started", lessonId: "mixed-top-level-secret" }]
    })).toThrow(/lesson_jump_started found in events/);
    const copied = copyAuthoredWorkbookEvalTrace({
      scenarioId: "copied-source",
      publicStates: [],
      terminalTranscript: [],
      reflections: [],
      editors: [],
      progressionEvents: [],
      artifacts: []
    });
    expect(() => copyAuthoredWorkbookEvalTrace({
      ...copied,
      events: [{ type: "lesson_jump_started", lessonId: "copied-top-level-secret" }]
    })).toThrow(/lesson_jump_started found in events/);
  });

  it("keeps raw workbook events only in memory and projects progression facts by explicit allowlist", () => {
    const trace = createEmptyAuthoredWorkbookEvalSessionTrace("progression-privacy");
    trace.publicStates.push({ label: "visible", state: browserPublicState() });
    trace.internalEvents.push(
      record({ type: "terminal-command-submitted", attemptId: "attempt-command-secret", lessonId, blockId: "terminal", command: "echo command-secret", terminalSessionId: "terminal-session-secret" }),
      record({ type: "terminal-command-finished", attemptId: "attempt-finished-secret", exitStatus: 0, evidenceRef: "private-evidence-secret" }),
      record({ type: "terminal-review-requested", attemptId: "attempt-review-secret", lessonId, blockId: "terminal", evidenceRef: "review-evidence-secret", requestId: "request-secret", mode: "automatic", callNumber: 1 }),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-feedback-secret", text: "private-feedback-secret" }),
      record({ type: "attempt_accepted", lessonId, blockId: "terminal", attemptId: "attempt-accepted-secret", version: 7, kind: "terminal", summary: "private-summary-secret", rubric: { private: "rubric-secret" }, path: "/private/session/path" }),
      record({ type: "block_completed", lessonId, blockId: "terminal", response: "private-response-secret" }),
      record({ type: "future_internal_event", lessonId, blockId: "terminal", token: "future-secret" })
    );

    const projected = projectAuthoredWorkbookEvalTrace(trace);

    expect(trace.internalEvents).toHaveLength(7);
    expect(projected).not.toHaveProperty("internalEvents");
    expect(projected).not.toHaveProperty("events");
    expect(projected.progressionEvents).toEqual([
      { type: "attempt_accepted", lessonId, blockId: "terminal", kind: "terminal" },
      { type: "block_completed", lessonId, blockId: "terminal" }
    ]);
    const serialized = JSON.stringify({ projected });
    for (const secret of ["attempt-command-secret", "command-secret", "terminal-session-secret", "attempt-finished-secret", "private-evidence-secret", "attempt-review-secret", "review-evidence-secret", "request-secret", "attempt-feedback-secret", "private-feedback-secret", "attempt-accepted-secret", "private-summary-secret", "rubric-secret", "/private/session/path", "private-response-secret", "future-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("rebuilds public traces by channel and deduplicates citable learner-visible evidence", () => {
    const unsafeTrace = {
      scenarioId: "copy-privacy",
      publicStates: [
        { label: "first", state: browserPublicState("same visible state"), extra: "public-state-extra-secret" },
        { label: "second", state: browserPublicState("same visible state"), extra: "second-public-state-extra-secret" }
      ],
      terminalTranscript: [
        { blockId: "terminal", direction: "output", text: "visible output", at: "terminal-at-secret", credentials: { token: "terminal-token-secret" } },
        { blockId: "terminal", direction: "output", text: "visible output", at: "duplicate-at-secret" }
      ],
      reflections: [{ blockId: "reflection", role: "tutor", text: "Visible reply mentioning Private editor criterion as public prose.", at: "reflection-at-secret", lifecycleDetails: { text: "reflection-lifecycle-secret" } }],
      editors: [{ blockId: "editor", revision: 1, status: "feedback", feedback: "Visible feedback", path: "/private/editor/path", rubric: { text: "editor-rubric-secret" } }],
      progressionEvents: [{ type: "attempt_accepted", lessonId, blockId: "terminal", kind: "terminal", attemptId: "progression-attempt-secret", path: "/private/progression/path", lifecycleDetails: { text: "progression-lifecycle-secret" } }],
      artifacts: [{ path: "factory/.tmp/public.txt", content: "Visible artifact can mention terminal lifecycle.", credentials: "artifact-credential-secret" }],
      internalEvents: [{ type: "terminal-command-submitted", attemptId: "top-level-internal-secret" }],
      events: [{ type: "terminal-feedback-recorded", attemptId: "top-level-events-attempt-secret", text: "top-level-events-secret" }],
      credentials: { token: "top-level-token-secret" },
      paths: { session: "/private/top-level/path" },
      terminalLifecycle: { text: "top-level-lifecycle-secret" }
    };

    const copied = copyAuthoredWorkbookEvalTrace(unsafeTrace);
    const citations = enumerateAuthoredWorkbookEvalCitations(copied);

    expect(copied).toEqual({
      scenarioId: "copy-privacy",
      publicStates: [
        { label: "first", state: browserPublicState("same visible state") },
        { label: "second", state: browserPublicState("same visible state") }
      ],
      terminalTranscript: [
        { blockId: "terminal", direction: "output", text: "visible output" },
        { blockId: "terminal", direction: "output", text: "visible output" }
      ],
      reflections: [{ blockId: "reflection", role: "tutor", text: "Visible reply mentioning Private editor criterion as public prose." }],
      editors: [{ blockId: "editor", revision: 1, status: "feedback", feedback: "Visible feedback" }],
      progressionEvents: [{ type: "attempt_accepted", lessonId, blockId: "terminal", kind: "terminal" }],
      artifacts: [{ path: "factory/.tmp/public.txt", content: "Visible artifact can mention terminal lifecycle." }]
    });
    expect(citations.map((citation) => citation.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(citations.filter((citation) => citation.kind === "publicState")).toHaveLength(1);
    expect(citations.filter((citation) => citation.kind === "terminalTranscript")).toHaveLength(1);
    expect(JSON.stringify(citations)).not.toContain("Visible artifact can mention terminal lifecycle.");
    const serialized = JSON.stringify({ copied, citations });
    expect(serialized).toContain("terminal lifecycle");
    expect(serialized).toContain("Private editor criterion");
    for (const secret of ["public-state-extra-secret", "second-public-state-extra-secret", "terminal-at-secret", "terminal-token-secret", "duplicate-at-secret", "reflection-at-secret", "reflection-lifecycle-secret", "/private/editor/path", "editor-rubric-secret", "progression-attempt-secret", "/private/progression/path", "progression-lifecycle-secret", "artifact-credential-secret", "top-level-internal-secret", "top-level-events-secret", "top-level-token-secret", "/private/top-level/path", "top-level-lifecycle-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("sanitizes raw timeline reader errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-eval-timeline-"));
    tempRoots.push(root);
    await mkdir(resolve(root, "workbook"), { recursive: true });
    await writeFile(resolve(root, "workbook/events.jsonl"), "{not-json with private-snippet}\n", "utf8");

    await expect(readAuthoredWorkbookTimeline(root)).rejects.toThrow("workbook/events.jsonl:1: invalid timeline event.");
    await expect(readAuthoredWorkbookTimeline(root)).rejects.not.toThrow(root);
    await expect(readAuthoredWorkbookTimeline(root)).rejects.not.toThrow(/private-snippet/);
  });

  it("captures only explicit exact artifact files and refuses traversal, directories, symlinks, and bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-eval-artifacts-"));
    tempRoots.push(root);
    await mkdir(resolve(root, "factory/.tmp"), { recursive: true });
    await writeFile(resolve(root, "public.txt"), "public artifact\n", "utf8");
    await writeFile(resolve(root, "large.txt"), "x".repeat(12), "utf8");
    await mkdir(resolve(root, "factory/.tmp/events"), { recursive: true });
    await writeFile(resolve(root, "workbook/events.jsonl"), "private workbook event secret\n", "utf8").catch(async () => { await mkdir(resolve(root, "workbook"), { recursive: true }); await writeFile(resolve(root, "workbook/events.jsonl"), "private workbook event secret\n", "utf8"); });
    await writeFile(resolve(root, "factory/.tmp/events/1-do.jsonl"), "private do event secret\n", "utf8");
    await writeFile(resolve(root, "factory/.tmp/events/readme.txt"), "private events dir secret\n", "utf8");
    await writeFile(resolve(root, "factory/.tmp/findings.json"), "private findings secret\n", "utf8");
    await writeFile(resolve(root, "factory/.tmp/evidence.log"), "private evidence secret\n", "utf8");
    await writeFile(resolve(root, "factory/.tmp/worker.log"), "private log secret\n", "utf8");
    await writeFile(resolve(root, "factory/.tmp/commit-message.txt"), "private commit message secret\n", "utf8");
    await writeFile(resolve(root, "factory/.tmp/rpc-steering.json"), "private rpc steering secret\n", "utf8");
    await symlink(resolve(root, "public.txt"), resolve(root, "link.txt"));

    await expect(snapshotAuthoredWorkbookEvalArtifacts(root, undefined as any)).rejects.toThrow(/explicit exact relative file allowlist/i);
    await expect(snapshotAuthoredWorkbookEvalArtifacts(root, { files: [".."] })).rejects.toThrow(/relative artifact file/i);
    await expect(snapshotAuthoredWorkbookEvalArtifacts(root, { files: ["factory/.tmp"] })).rejects.toThrow(/not an ordinary file/i);
    await expect(snapshotAuthoredWorkbookEvalArtifacts(root, { files: ["link.txt"] })).rejects.toThrow(/not an ordinary file/i);
    await expect(snapshotAuthoredWorkbookEvalArtifacts(root, { files: ["large.txt"], maxFileBytes: 4 })).rejects.toThrow(/too large/i);
    await expect(snapshotAuthoredWorkbookEvalArtifacts(root, { files: ["public.txt"], maxFiles: 0 })).rejects.toThrow(/too many files/i);

    const snapshots = await snapshotAuthoredWorkbookEvalArtifacts(root, { files: ["public.txt"], maxFileBytes: 1024, maxTotalBytes: 1024, maxFiles: 1 });
    expect(snapshots).toEqual([{ path: "public.txt", content: "public artifact\n" }]);
    const serialized = JSON.stringify(snapshots);
    for (const secret of ["private workbook event secret", "private do event secret", "private events dir secret", "private findings secret", "private evidence secret", "private log secret", "private commit message secret", "private rpc steering secret"]) {
      expect(serialized).not.toContain(secret);
    }

    for (const path of ["workbook/events.jsonl", "nested/workbook/events.jsonl", "Workbook/Events.JSONL", "factory/.tmp/events/1-do.jsonl", "factory/.tmp/events/readme.txt", "factory/.tmp/Events/1-Do.JSONL"]) {
      await expect(snapshotAuthoredWorkbookEvalArtifacts(root, { files: [path], maxFileBytes: 1024, maxTotalBytes: 1024, maxFiles: 1 }), path).rejects.toThrow(/Raw workbook or station event files/);
    }
  });
});
