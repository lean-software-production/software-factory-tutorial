import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLesson } from "../src/lesson/load.js";

const fixture = fileURLToPath(new URL("./fixtures/sample-lesson", import.meta.url));
const tutorialRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("loadLesson", () => {
  it("loads a tutorial directory from its README and ledger", async () => {
    const loaded = await loadLesson(fixture);
    expect(loaded.definition.title).toBe("Fixture tutorial");
    expect(loaded.workspace).toBe(fixture);
    expect(loaded.definition.validationCommands).toEqual([]);
    expect(loaded.progress).toEqual([
      { id: "orientation", label: "Orientation", state: "done" },
      { id: "001", label: "Fixture step", state: "current" },
    ]);
  });

  it("loads the repository tutorial and its current iteration", async () => {
    const loaded = await loadLesson(tutorialRoot);
    expect(loaded.definition.title).toBe("Software factory tutorial 🏭");
    expect(loaded.definition.validationCommands).toEqual([]);
    expect(loaded.progress).toMatchObject([
      { id: "orientation", state: "done" },
      { id: "001", state: "current" },
      { id: "002", state: "upcoming" },
    ]);
  });
});
