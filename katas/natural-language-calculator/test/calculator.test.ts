import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateSpokenExpression,
  formatAnswer,
  runCli,
} from "../src/index.js";

describe("spoken expressions", () => {
  it("evaluates every prefix operation", () => {
    expect(evaluateSpokenExpression("add four and nine")).toBe(13);
    expect(evaluateSpokenExpression("subtract two from ten")).toBe(8);
    expect(evaluateSpokenExpression("multiply three by six")).toBe(18);
    expect(evaluateSpokenExpression("divide twelve by four")).toBe(3);
  });

  it("evaluates parenthesised expressions", () => {
    expect(
      evaluateSpokenExpression("divide ( multiply twelve by three ) by six"),
    ).toBe(6);
    expect(
      evaluateSpokenExpression("subtract five from ( add three and nine )"),
    ).toBe(7);
  });

  it("accepts both digit tokens and number words", () => {
    expect(evaluateSpokenExpression("add 7 and eight")).toBe(15);
    expect(evaluateSpokenExpression("multiply 12 by zero")).toBe(0);
  });

  it("rejects malformed expressions", () => {
    expect(() => evaluateSpokenExpression("add four beside nine")).toThrow();
    expect(() => evaluateSpokenExpression("divide nine by zero")).toThrow();
    expect(() => evaluateSpokenExpression("multiply thirteen by two")).toThrow();
    expect(() => evaluateSpokenExpression("add ( one and two")).toThrow();
  });
});

describe("the command-line boundary", () => {
  it("formats a successful result", () => {
    expect(formatAnswer(13)).toBe("Result: 13");

    const written: string[] = [];
    const errors: string[] = [];
    expect(runCli(["add", "four", "and", "nine"], written.push.bind(written), errors.push.bind(errors))).toBe(0);
    expect(written).toEqual(["Result: 13"]);
    expect(errors).toEqual([]);
  });

  it("returns an error status for a bad expression", () => {
    const written: string[] = [];
    const errors: string[] = [];
    expect(runCli(["add", "four", "beside", "nine"], written.push.bind(written), errors.push.bind(errors))).toBe(1);
    expect(written).toEqual([]);
    expect(errors).toEqual(["Unable to calculate that expression."]);
  });

  it("exits non-zero when run as a program with invalid input", () => {
    const cli = resolve(process.cwd(), "src/cli.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, "divide", "nine", "by", "zero"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unable to calculate that expression.");
  });
});
