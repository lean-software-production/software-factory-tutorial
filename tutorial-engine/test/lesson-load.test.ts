import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLesson } from "../src/lesson/load.js";

const fixture = fileURLToPath(new URL("./fixtures/sample-lesson", import.meta.url));
const tutorial = fileURLToPath(new URL("../../tutorial.ts", import.meta.url));

describe("loadLesson", () => {
  it("loads a TypeScript default export and resolves its workspace", async () => {
    const loaded = await loadLesson(fixture);
    expect(loaded.definition.title).toBe("Fixture lesson");
    expect(loaded.workspace).toBe(fixture);
    expect(loaded.definition.validationCommands[0]?.id).toBe("check");
    expect(loaded.progress).toEqual([
      { id: "orientation", label: "Orientation", state: "done" },
      { id: "001", label: "Fixture step", state: "current" },
    ]);
  });

  it("loads the repository tutorial and its current iteration", async () => {
    const loaded = await loadLesson(tutorial);
    expect(loaded.definition.validationCommands).toEqual([]);
    expect(loaded.progress.at(-1)).toMatchObject({ id: "001", state: "current" });
  });
});
