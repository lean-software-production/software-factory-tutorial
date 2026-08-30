import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_WORKBOOK_SESSION_FORMAT_VERSION, UnsupportedWorkbookSessionError, workbookSessionFormatRecord } from "../../../tutorial-engine/src/workbook/timeline.js";
import { readAuthoredWorkbookTimeline } from "../internal-timeline.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("authored workbook internal timeline reader", () => {
  it("accepts the current format header and normalizes only subsequent event rows", async () => {
    const root = await sessionRoot();
    const event = timelineRecord({ type: "workbook_introduction_completed" }, 1);
    await writeRows(root, [workbookSessionFormatRecord(), event]);

    await expect(readAuthoredWorkbookTimeline(root)).resolves.toEqual([event]);
  });

  it("accepts a header-only current timeline as an empty event list", async () => {
    const root = await sessionRoot();
    await writeRows(root, [workbookSessionFormatRecord()]);

    await expect(readAuthoredWorkbookTimeline(root)).resolves.toEqual([]);
  });

  it("requires an existing current header instead of initializing or accepting versionless logs", async () => {
    const absentParent = await sessionRoot({ withWorkbookDirectory: false });
    await expect(readAuthoredWorkbookTimeline(absentParent)).rejects.toThrow(UnsupportedWorkbookSessionError);
    await expect(readAuthoredWorkbookTimeline(absentParent)).rejects.toThrow(/start fresh/i);

    const absentFile = await sessionRoot();
    await expect(readAuthoredWorkbookTimeline(absentFile)).rejects.toThrow(UnsupportedWorkbookSessionError);

    const versionless = await sessionRoot();
    await writeRows(versionless, [timelineRecord({ type: "workbook_introduction_completed" }, 1)]);
    await expect(readAuthoredWorkbookTimeline(versionless)).rejects.toThrow(UnsupportedWorkbookSessionError);
  });

  it("rejects older and newer authored timeline headers with start-fresh guidance", async () => {
    const oldHeader = await sessionRoot();
    await writeRows(oldHeader, [{ type: "workbook-session-format", version: CURRENT_WORKBOOK_SESSION_FORMAT_VERSION - 1 }]);
    await expect(readAuthoredWorkbookTimeline(oldHeader)).rejects.toThrow(/format version 0.*current version 1.*start fresh/i);

    const newHeader = await sessionRoot();
    await writeRows(newHeader, [{ type: "workbook-session-format", version: CURRENT_WORKBOOK_SESSION_FORMAT_VERSION + 1 }]);
    await expect(readAuthoredWorkbookTimeline(newHeader)).rejects.toThrow(/format version 2.*current version 1.*start fresh/i);
  });

  it("propagates old Practice Coach timeline rows as unsupported workbook sessions", async () => {
    const root = await sessionRoot();
    await writeRows(root, [
      workbookSessionFormatRecord(),
      timelineRecord({ type: "terminal-coach-handoff-recorded", attemptId: "attempt", outcome: "ready", text: "Legacy private handoff." }, 1),
    ]);

    await expect(readAuthoredWorkbookTimeline(root)).rejects.toThrow(UnsupportedWorkbookSessionError);
    await expect(readAuthoredWorkbookTimeline(root)).rejects.toThrow(/terminal-coach-handoff-recorded.*start fresh/i);
  });

  it("keeps physical line numbers when reporting malformed current event rows after blanks", async () => {
    const root = await sessionRoot();
    await writeRaw(root, `${JSON.stringify(workbookSessionFormatRecord())}\n\n{not-json with private-snippet}\n`);

    await expect(readAuthoredWorkbookTimeline(root)).rejects.toThrow("workbook/events.jsonl:3: invalid timeline event.");
    await expect(readAuthoredWorkbookTimeline(root)).rejects.not.toThrow(root);
    await expect(readAuthoredWorkbookTimeline(root)).rejects.not.toThrow(/private-snippet/);
  });
});

async function sessionRoot(options: { withWorkbookDirectory?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "authored-internal-timeline-"));
  tempRoots.push(root);
  if (options.withWorkbookDirectory !== false) await mkdir(join(root, "workbook"), { recursive: true });
  return root;
}

async function writeRows(root: string, rows: readonly unknown[]): Promise<void> {
  await writeRaw(root, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function writeRaw(root: string, text: string): Promise<void> {
  await mkdir(resolve(root, "workbook"), { recursive: true });
  await writeFile(resolve(root, "workbook/events.jsonl"), text, "utf8");
}

function timelineRecord(event: Record<string, unknown>, sequence: number) {
  return {
    ...event,
    id: `test-event-${sequence}`,
    sequence,
    at: new Date(Date.UTC(2026, 7, 30, 0, 0, sequence)).toISOString(),
  };
}
