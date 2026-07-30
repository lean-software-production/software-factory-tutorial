import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLesson } from "../src/lesson/load.js";

const fixture = fileURLToPath(new URL("./fixtures/sample-lesson", import.meta.url));
const calculatorKata = fileURLToPath(new URL("../../katas/natural-language-calculator", import.meta.url));

describe("loadLesson", () => {
  it("loads a TypeScript default export and resolves its workspace", async () => {
    const loaded = await loadLesson(fixture);
    expect(loaded.definition.title).toBe("Fixture lesson");
    expect(loaded.workspace).toBe(fixture);
    expect(loaded.definition.validationCommands[0]?.id).toBe("check");
  });

  it("loads the bundled natural-language calculator lesson", async () => {
    const loaded = await loadLesson(calculatorKata);
    expect(loaded.definition.validationCommands[0]?.command).toBe("npm");
    expect(loaded.definition.validationCommands[0]?.args).toEqual(["test"]);
  });
});
