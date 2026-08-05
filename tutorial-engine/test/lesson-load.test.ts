import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLesson } from "../src/lesson/load.js";

const fixture = fileURLToPath(new URL("./fixtures/sample-lesson", import.meta.url));
const tutorialRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("loadLesson", () => {
  it("groups lesson rows under the part heading that precedes them", async () => {
    const loaded = await loadLesson(fixture);
    expect(loaded.definition.title).toBe("Fixture tutorial");
    expect(loaded.workspace).toBe(fixture);
    expect(loaded.definition.validationCommands).toEqual([]);
    expect(loaded.progress).toEqual([
      { id: "orientation", label: "Orientation", state: "done" },
      { id: "001", label: "Fixture step", state: "current", part: "Part 1 — First part" },
      { id: "002", label: "Second fixture step", state: "upcoming", part: "Part 2 — Second part" },
    ]);
  });

  it("ignores a header row whatever its first column is called", async () => {
    const loaded = await loadLesson(fixture);
    expect(loaded.progress.some((item) => item.label === "Goal")).toBe(false);
    expect(loaded.progress.some((item) => item.id === "Lesson")).toBe(false);
  });

  it("loads the repository tutorial regardless of how many lesson rows its ledger contains", async () => {
    const loaded = await loadLesson(tutorialRoot);
    expect(loaded.definition.title).toBe("Software factory tutorial 🏭");
    expect(loaded.definition.validationCommands).toEqual([]);
    expect(loaded.progress[0]).toEqual({ id: "orientation", label: "Orientation", state: "done" });
    expect(loaded.progress.length).toBeGreaterThan(1);
    expect(loaded.progress.filter((item) => item.state === "current")).toHaveLength(1);
    expect(loaded.progress.slice(1).every((item) => item.id.length > 0 && item.label.length > 0)).toBe(true);
  });

  it("groups the repository's own two-part ledger under the headings the sidebar renders", async () => {
    // The fixture proves the parser; this proves the real ledger still feeds it
    // what it expects. A row that lands with no part renders above both
    // headings, which is the failure this catches and the fixture cannot.
    const lessons = (await loadLesson(tutorialRoot)).progress.slice(1);
    expect(lessons.every((item) => item.part !== undefined)).toBe(true);
    const byPart = [...new Set(lessons.map((item) => item.part))];
    expect(byPart).toEqual(["Part 1 — The validation loop", "Part 2 — Build the factory"]);
    expect(lessons.filter((item) => item.part === byPart[0]).map((item) => item.id))
      .toEqual(["001", "002", "003", "004"]);
    expect(lessons.filter((item) => item.part === byPart[1]).map((item) => item.id))
      .toEqual(["005", "006", "007", "008", "009", "010", "011", "012", "013"]);
  });
});
