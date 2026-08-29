import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbookTimeline } from "../src/workbook/timeline.js";

let directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "workbook-timeline-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  directories = [];
});

describe("WorkbookTimeline", () => {
  it("persists an appended record before publishing it to subscribers", async () => {
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
    expect(fileAtPublication).toContain(`"id":"${record.id}"`);
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
    expect("evidenceRef" in record).toBe(false);
    expect(await timeline.read()).toEqual([record]);
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
    expect(JSON.stringify(record)).not.toMatch(/command|evidenceRef|rubric|handoff|secret/i);
    expect(await timeline.read()).toEqual([record]);
  });

  it("assigns deterministic IDs to pre-timeline workflow rows", async () => {
    const directory = await workspace();
    const timeline = new WorkbookTimeline(directory);
    await mkdir(resolve(directory, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(timeline.eventPath, [
      JSON.stringify({ type: "session_started", at: "2026-08-21T00:00:00.000Z" }),
      JSON.stringify({ type: "workbook_introduction_completed", at: "2026-08-21T00:00:01.000Z" }),
      ""
    ].join("\n"));

    const records = await timeline.read();

    expect(records.map(({ id, sequence }) => [id, sequence])).toEqual([["legacy:1", 1], ["legacy:2", 2]]);
    expect((await timeline.append({ type: "session_started" })).sequence).toBe(3);
  });

  it("normalizes legacy tutor message sources to main tutor", async () => {
    const directory = await workspace();
    const timeline = new WorkbookTimeline(directory);
    await mkdir(resolve(directory, ".tutorial/.tmp/workbook"), { recursive: true });
    await writeFile(timeline.eventPath, `${JSON.stringify({
      type: "message",
      lessonId: "lesson",
      blockId: "intro",
      role: "assistant",
      source: "tutor",
      presentation: "chat",
      text: "Legacy tutor reply"
    })}\n`);

    await expect(timeline.read()).resolves.toMatchObject([{ type: "message", source: "main_tutor" }]);
  });


});
