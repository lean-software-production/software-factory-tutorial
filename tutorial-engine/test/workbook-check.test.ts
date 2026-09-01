import { describe, expect, it, vi } from "vitest";
import { runWorkbookCheck } from "../src/workbook/check.js";
import type { LoadedWorkbook } from "../src/workbook/load.js";

function chapter(partNumber: number | undefined): LoadedWorkbook["chapters"][number] {
  return {
    id: `lesson-${partNumber ?? "x"}`,
    title: "A lesson",
    partNumber,
    lessonNumber: 1,
    lesson: { id: "lesson", title: "A lesson", dek: "", introduction: "", durationMinutes: 1, outcomes: [], blocks: [] },
  };
}

describe("workbook check", () => {
  it("prints the title, lesson count, and part count and exits zero for a valid workbook", async () => {
    const load = vi.fn(async (target: string): Promise<LoadedWorkbook> => {
      expect(target).toBe("/tmp/workbook");
      return {
        workspace: "/tmp/workbook",
        identity: { title: "Synthetic Workbook" },
        introduction: "",
        chapters: [chapter(1), chapter(1), chapter(2)],
      };
    });
    const writeLine = vi.fn();
    const writeError = vi.fn();

    const exitCode = await runWorkbookCheck(["/tmp/workbook"], { load, writeLine, writeError });

    expect(exitCode).toBe(0);
    expect(writeError).not.toHaveBeenCalled();
    expect(writeLine).toHaveBeenCalledOnce();
    const [message] = writeLine.mock.calls[0]!;
    expect(message).toContain("Synthetic Workbook");
    expect(message).toContain("3");
    expect(message).toContain("2");
  });

  it("prints the loader's error and exits nonzero for an invalid workbook", async () => {
    const load = vi.fn(async () => {
      throw new Error("workbook.md must have exactly one H1 title heading");
    });
    const writeLine = vi.fn();
    const writeError = vi.fn();

    const exitCode = await runWorkbookCheck(["/tmp/broken-workbook"], { load, writeLine, writeError });

    expect(exitCode).toBe(1);
    expect(writeLine).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("workbook.md must have exactly one H1 title heading"));
  });

  it("requires exactly one workbook target argument", async () => {
    const load = vi.fn();
    const writeLine = vi.fn();
    const writeError = vi.fn();

    await expect(runWorkbookCheck([], { load, writeLine, writeError })).resolves.toBe(2);
    await expect(runWorkbookCheck(["/tmp/workbook", "/tmp/other"], { load, writeLine, writeError })).resolves.toBe(2);

    expect(load).not.toHaveBeenCalled();
    expect(writeLine).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(2);
    expect(writeError).toHaveBeenCalledWith("Usage: npm run check:workbook -- /path/to/workbook");
  });
});
