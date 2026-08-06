import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { currentSpecPath, loadLesson, readProgress } from "../src/lesson/load.js";

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
      { id: "001", label: "Fixture step", state: "current", part: "Part 1 — First part", spec: "001.md" },
      { id: "002", label: "Second fixture step", state: "upcoming", part: "Part 2 — Second part", spec: "002.md" },
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

const ledger = [
  "# Lessons",
  "",
  "## Part 1 — First part",
  "",
  "| Lesson | Goal |",
  "| --- | --- |",
  "| [001](001-first.md) | First step |",
  "| [002](002-second.md) | Second step |",
  ""
].join("\n");

describe("readProgress", () => {
  it("takes the outline's shape from the ledger and its state from the finished set", () => {
    const states = (completed: string[]) =>
      readProgress(ledger, new Set(completed)).slice(1).map((item) => [item.id, item.state]);

    expect(states([])).toEqual([["001", "current"], ["002", "upcoming"]]);
    expect(states(["001"])).toEqual([["001", "done"], ["002", "current"]]);
    expect(states(["001", "002"])).toEqual([["001", "done"], ["002", "done"]]);
  });

  it("leaves an earlier unfinished lesson current rather than skipping to the gap", () => {
    // A ledger row can only be finished through the tool, but a hand-edited
    // progress file should not be able to strand the learner past a lesson
    // they have not done.
    expect(readProgress(ledger, new Set(["002"])).slice(1).map((item) => [item.id, item.state]))
      .toEqual([["001", "current"], ["002", "done"]]);
  });

  it("reads state only from the finished set, even if a status column reappears", () => {
    // The ledger used to carry a Status cell. Should one come back, it must not
    // be able to claim a lesson is done: the curriculum ships to everyone, and
    // only factory/ knows about this learner.
    const withStatus = ledger
      .replace("| Lesson | Goal |", "| Lesson | Goal | Status |")
      .replace("| --- | --- |", "| --- | --- | --- |")
      .replace("| [001](001-first.md) | First step |", "| [001](001-first.md) | First step | Done |");

    expect(readProgress(withStatus).slice(1).map((item) => [item.id, item.state]))
      .toEqual([["001", "current"], ["002", "upcoming"]]);
  });

  it("skips header and separator rows, which carry no specification link", () => {
    expect(readProgress(ledger).slice(1).map((item) => item.id)).toEqual(["001", "002"]);
  });

  it("carries each lesson's specification filename for routing the tutor", () => {
    expect(currentSpecPath(readProgress(ledger))).toBe("docs/specs/001-first.md");
    expect(currentSpecPath(readProgress(ledger, new Set(["001"])))).toBe("docs/specs/002-second.md");
    expect(currentSpecPath(readProgress(ledger, new Set(["001", "002"])))).toBeUndefined();
  });
});
