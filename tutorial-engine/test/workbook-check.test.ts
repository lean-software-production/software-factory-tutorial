import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runWorkbookCheck } from "../src/workbook/check.js";
import type { LoadedWorkbook } from "../src/workbook/load.js";

// This test file lives at tutorial-engine/test/workbook-check.test.ts; the
// repository root (where workbook.md is authored) is two levels up from it.
const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

function chapter(partNumber: number | undefined): LoadedWorkbook["chapters"][number] {
  return {
    id: `lesson-${partNumber ?? "x"}`,
    title: "A lesson",
    partNumber,
    lessonNumber: 1,
    lesson: { id: "lesson", title: "A lesson", dek: "", durationMinutes: 1, outcomes: [], blocks: [] },
  };
}

describe("workbook check", () => {
  it("prints the title, lesson count, and part count and exits zero for a valid workbook", async () => {
    const load = vi.fn(async (target: string): Promise<LoadedWorkbook> => {
      expect(target).toBe("/tmp/workbook");
      return {
        workspace: "/tmp/workbook",
        identity: { title: "Refactoring Workbook" },
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
    expect(message).toContain("Refactoring Workbook");
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

    expect(exitCode).not.toBe(0);
    expect(writeLine).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining("workbook.md must have exactly one H1 title heading"));
  });

  it("defaults the target to the repository root when none is given, regardless of cwd", async () => {
    const load = vi.fn(async (target: string): Promise<LoadedWorkbook> => {
      expect(target).toBe(REPOSITORY_ROOT);
      return { workspace: target, identity: { title: "Untitled" }, introduction: "", chapters: [] };
    });

    const exitCode = await runWorkbookCheck([], { load, writeLine: vi.fn(), writeError: vi.fn() });

    expect(exitCode).toBe(0);
  });

  it("still honors an explicit target argument instead of the repository root default", async () => {
    const load = vi.fn(async (target: string): Promise<LoadedWorkbook> => {
      expect(target).toBe("/tmp/some-other-workbook");
      return { workspace: target, identity: { title: "Untitled" }, introduction: "", chapters: [] };
    });

    const exitCode = await runWorkbookCheck(["/tmp/some-other-workbook"], { load, writeLine: vi.fn(), writeError: vi.fn() });

    expect(exitCode).toBe(0);
  });
});
