import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TERMINAL_COMMAND_BYTES, validateTerminalEvidence, type TerminalEvidence } from "../src/workbook/terminal-evidence.js";
import { CURRENT_WORKBOOK_SESSION_FORMAT_VERSION, UnsupportedWorkbookSessionError, WorkbookTimeline, workbookSessionFormatRecord } from "../src/workbook/timeline.js";

let directories: string[] = [];
const LEGACY_EVIDENCE_REFERENCE_KEY = "evidence" + "Ref";

async function workspace(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "workbook-timeline-"));
  directories.push(directory);
  return directory;
}

async function writeTimelineLog(timeline: WorkbookTimeline, rows: unknown[]): Promise<void> {
  await mkdir(resolve(timeline.eventPath, ".."), { recursive: true });
  await writeFile(timeline.eventPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

async function writeCurrentTimelineLog(timeline: WorkbookTimeline, rows: unknown[]): Promise<void> {
  await writeTimelineLog(timeline, [workbookSessionFormatRecord(), ...rows]);
}

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

describe("WorkbookTimeline", () => {
  it("initializes the current format before reading a new empty session", async () => {
    const timeline = new WorkbookTimeline(await workspace());

    await expect(timeline.read()).resolves.toEqual([]);

    const contents = await readFile(timeline.eventPath, "utf8");
    expect(contents).toBe(`${JSON.stringify(workbookSessionFormatRecord())}\n`);
  });

  it("serializes current-format initialization through concurrent appends", async () => {
    const timeline = new WorkbookTimeline(await workspace());

    const [first, second] = await Promise.all([
      timeline.append({ type: "session_started" }),
      timeline.append({ type: "workbook_introduction_completed" }),
    ]);

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(await timeline.read()).toEqual([first, second]);
    const rows = (await readFile(timeline.eventPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    expect(rows).toEqual([workbookSessionFormatRecord(), first, second]);
  });

  it("persists an appended record after the current format before publishing it to subscribers", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    const published: Array<{ id: string; sequence: number }> = [];
    let pathAtPublication = "";
    let fileAtPublication = "";
    let observedPublication!: () => void;
    const publicationObserved = new Promise<void>((resolve) => { observedPublication = resolve; });

    timeline.subscribe((record) => {
      published.push({ id: record.id, sequence: record.sequence });
      pathAtPublication = timeline.eventPath;
      void readFile(timeline.eventPath, "utf8").then((contents) => {
        fileAtPublication = contents;
        observedPublication();
      });
    });

    const record = await timeline.append({ type: "session_started" });
    await publicationObserved;

    expect(record.sequence).toBe(1);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(published).toEqual([{ id: record.id, sequence: 1 }]);
    expect(pathAtPublication).toContain(".tutorial/.tmp/workbook/events.jsonl");
    expect(fileAtPublication.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      workbookSessionFormatRecord(),
      record,
    ]);
    expect(await timeline.read()).toEqual([record]);
  });

  it("appends terminal lifecycle records without terminal output", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    const record = await timeline.append({
      type: "terminal-command-submitted",
      attemptId: "attempt-1",
      lessonId: "lesson-1",
      blockId: "block-1",
      command: "npm test",
      terminalSessionId: "terminal-session-1",
    });

    expect(record).toMatchObject({ type: "terminal-command-submitted", command: "npm test" });
    expect(LEGACY_EVIDENCE_REFERENCE_KEY in record).toBe(false);
    expect(await timeline.read()).toEqual([record]);
  });

  it("round-trips validated inline terminal evidence without duplicate command or exit status fields", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    const evidence: TerminalEvidence = {
      kind: "finished",
      command: "npm test",
      interactions: [{ kind: "input", data: "npm test\r" }, { kind: "output", data: "PASS\n" }],
      exitStatus: 0,
      transcriptSnapshot: { label: "Command-local terminal transcript at command completion", transcript: "PASS\n", truncated: false },
    };

    const record = await timeline.append({ type: "terminal-command-finished", attemptId: "attempt-1", evidence });
    evidence.interactions[1]!.data = "mutated";
    evidence.transcriptSnapshot!.transcript = "mutated";

    expect(record).toEqual(expect.objectContaining({ type: "terminal-command-finished", attemptId: "attempt-1", evidence: validateTerminalEvidence({
      kind: "finished",
      command: "npm test",
      interactions: [{ kind: "input", data: "npm test\r" }, { kind: "output", data: "PASS\n" }],
      exitStatus: 0,
      transcriptSnapshot: { label: "Command-local terminal transcript at command completion", transcript: "PASS\n", truncated: false },
    }) }));
    expect(record).not.toHaveProperty("exitStatus");
    expect(record).not.toHaveProperty(LEGACY_EVIDENCE_REFERENCE_KEY);
    expect(await timeline.read()).toEqual([record]);
  });

  it("rejects untrusted current logs with malformed inline terminal evidence", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    await writeCurrentTimelineLog(timeline, [
      { type: "terminal-command-finished", id: "finished", sequence: 1, at: "2026-08-21T00:00:00.000Z", attemptId: "attempt-1", evidence: { kind: "finished", command: "x".repeat(MAX_TERMINAL_COMMAND_BYTES + 1), interactions: [], exitStatus: 0 } },
    ]);

    await expect(timeline.read()).rejects.toThrow(/Terminal evidence command is invalid/);
  });

  it("rejects legacy evidence-reference terminal lifecycle rows in current logs", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    await writeCurrentTimelineLog(timeline, [
      { type: "terminal-command-finished", id: "finished", sequence: 1, at: "2026-08-21T00:00:00.000Z", attemptId: "attempt-1", exitStatus: 0, [LEGACY_EVIDENCE_REFERENCE_KEY]: "old-ref" },
      { type: "terminal-review-requested", id: "request", sequence: 2, at: "2026-08-21T00:00:01.000Z", attemptId: "attempt-1", lessonId: "lesson", blockId: "block", [LEGACY_EVIDENCE_REFERENCE_KEY]: "old-ref", requestId: "request-1", mode: "automatic", callNumber: 1 },
    ]);

    await expect(timeline.read()).rejects.toThrow(/terminal-command-finished fields are invalid/);
  });

  it("persists a browser-safe terminal snapshot separately from private command evidence", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    const record = await timeline.append({
      type: "terminal-transcript-snapshotted",
      attemptId: "attempt-1",
      lessonId: "lesson-1",
      blockId: "lesson-1--terminal",
      transcript: "sanitized learner-visible output\n",
    });

    expect(record).toMatchObject({ type: "terminal-transcript-snapshotted", lessonId: "lesson-1", blockId: "lesson-1--terminal", transcript: "sanitized learner-visible output\n" });
    expect(JSON.stringify(record)).not.toMatch(/command|evidence|rubric|handoff|secret/i);
    expect(await timeline.read()).toEqual([record]);
  });

  it("rejects an existing empty log before projecting", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    await mkdir(resolve(timeline.eventPath, ".."), { recursive: true });
    await writeFile(timeline.eventPath, "", "utf8");

    await expect(timeline.read()).rejects.toThrow(UnsupportedWorkbookSessionError);
    await expect(timeline.read()).rejects.toThrow(/unsupported workbook session format.*start fresh/i);
  });

  it("rejects a versionless existing log before parsing records", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    await writeTimelineLog(timeline, [
      { type: "session_started", id: "old-session", sequence: 1, at: "2026-08-21T00:00:00.000Z" },
    ]);

    await expect(timeline.read()).rejects.toThrow(UnsupportedWorkbookSessionError);
    await expect(timeline.read()).rejects.toThrow(/unsupported workbook session format.*start fresh/i);
  });

  it("rejects older and newer format versions before parsing records", async () => {
    const older = new WorkbookTimeline(await workspace());
    await writeTimelineLog(older, [
      { type: "workbook-session-format", version: CURRENT_WORKBOOK_SESSION_FORMAT_VERSION - 1 },
      { type: "session_started", id: "old-session", sequence: 1, at: "2026-08-21T00:00:00.000Z" },
    ]);
    await expect(older.read()).rejects.toThrow(/format version 0.*current version 1.*start fresh/i);

    const newer = new WorkbookTimeline(await workspace());
    await writeTimelineLog(newer, [
      { type: "workbook-session-format", version: CURRENT_WORKBOOK_SESSION_FORMAT_VERSION + 1 },
      { type: "session_started", id: "future-session", sequence: 1, at: "2026-08-21T00:00:00.000Z" },
    ]);
    await expect(newer.read()).rejects.toThrow(/format version 2.*current version 1.*start fresh/i);
  });

  it("rejects old Practice Coach handoff events as unsupported current-session content", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    await writeCurrentTimelineLog(timeline, [
      { type: "terminal-coach-handoff-recorded", id: "legacy-handoff", sequence: 1, at: "2026-08-23T00:00:00.000Z", attemptId: "attempt", outcome: "ready", text: "Legacy private handoff." },
    ]);

    await expect(timeline.read()).rejects.toThrow(UnsupportedWorkbookSessionError);
    await expect(timeline.read()).rejects.toThrow(/terminal-coach-handoff-recorded.*start fresh/i);
  });

  it("still reports malformed current rows as invalid JSONL events with physical line numbers", async () => {
    const timeline = new WorkbookTimeline(await workspace());
    await mkdir(resolve(timeline.eventPath, ".."), { recursive: true });
    await writeFile(timeline.eventPath, [
      JSON.stringify(workbookSessionFormatRecord()),
      "",
      "not-json",
      "",
    ].join("\n"), "utf8");

    await expect(timeline.read()).rejects.toThrow(/events\.jsonl:3: invalid JSONL event/i);
  });
});
