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

  it("persists block tutor support records in sequence order", async () => {
    const timeline = new WorkbookTimeline(await workspace());

    const briefing = await timeline.append({
      type: "block_tutor_briefed",
      lessonId: "lesson",
      blockId: "editor",
      text: "Coach this block by asking for the learner's edited script.",
      coveredThroughId: "message-7"
    });
    const readiness = await timeline.append({
      type: "block_tutor_readiness",
      lessonId: "lesson",
      blockId: "editor",
      attemptId: "attempt-3",
      readiness: "likely_ready",
      text: "The learner's third attempt satisfies the block goal."
    });

    expect(briefing).toMatchObject({ type: "block_tutor_briefed", sequence: 1, lessonId: "lesson", blockId: "editor", coveredThroughId: "message-7" });
    expect(readiness).toMatchObject({ type: "block_tutor_readiness", sequence: 2, lessonId: "lesson", blockId: "editor", attemptId: "attempt-3", readiness: "likely_ready" });
    expect(briefing.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(readiness.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(readiness.id).not.toBe(briefing.id);

    const jsonl = await readFile(timeline.eventPath, "utf8");
    expect(jsonl.trim().split("\n").map((line) => JSON.parse(line))).toMatchObject([
      { id: briefing.id, sequence: 1, type: "block_tutor_briefed", text: "Coach this block by asking for the learner's edited script." },
      { id: readiness.id, sequence: 2, type: "block_tutor_readiness", text: "The learner's third attempt satisfies the block goal." }
    ]);
    expect(await timeline.read()).toEqual([briefing, readiness]);
  });
});
