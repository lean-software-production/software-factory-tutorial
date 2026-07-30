import { describe, expect, it } from "vitest";
import { ValidationRunner } from "../src/validation/runner.js";

describe("ValidationRunner", () => {
  it("runs an allowlisted executable without a shell", async () => {
    const runner = new ValidationRunner([{ id: "node", label: "Node", command: process.execPath, args: ["-e", "process.stdout.write('green')"] }], process.cwd());
    const result = await runner.run("node");
    expect(result.passed).toBe(true);
    expect(result.output).toBe("green");
  });

  it("preserves HOME for executable shims", async () => {
    const runner = new ValidationRunner([{ id: "home", label: "Home", command: process.execPath, args: ["-e", "if (!process.env.HOME) process.exit(1)"] }], process.cwd());
    await expect(runner.run("home")).resolves.toMatchObject({ passed: true });
  });

  it("rejects commands not in the lesson allowlist", async () => {
    const runner = new ValidationRunner([], process.cwd());
    await expect(runner.run("anything")).rejects.toThrow("not allowed");
  });
});
