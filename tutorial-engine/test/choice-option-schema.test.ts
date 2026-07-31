import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { choiceOptionSchema } from "../src/agent/tutorial-tools.js";
import { choiceIconCategories } from "../src/protocol/events.js";

describe("choice option schema", () => {
  it("requires one of the fixed icon categories", () => {
    for (const icon of choiceIconCategories) {
      expect(Check(choiceOptionSchema, { id: "next", label: "Continue", icon })).toBe(true);
    }
    expect(Check(choiceOptionSchema, { id: "next", label: "Continue" })).toBe(false);
    expect(Check(choiceOptionSchema, { id: "next", label: "Continue", icon: "custom" })).toBe(false);
  });
});
