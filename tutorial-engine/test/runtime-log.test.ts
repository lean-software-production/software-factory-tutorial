import { describe, expect, it } from "vitest";
import { createTutorialLogger } from "../src/runtime-log.js";

describe("createTutorialLogger", () => {
  it("writes timestamped lifecycle messages to its configured output", () => {
    const lines: string[] = [];
    const logger = createTutorialLogger({
      write: (line) => { lines.push(line); },
      now: () => new Date("2026-08-01T12:34:56.789Z")
    });

    logger.info("Pi started responding.");

    expect(lines).toEqual(["[tutorial 2026-08-01T12:34:56.789Z] INFO Pi started responding.\n"]);
  });

  it("keeps error diagnostics on one terminal line", () => {
    const lines: string[] = [];
    const logger = createTutorialLogger({ write: (line) => { lines.push(line); }, now: () => new Date("2026-08-01T12:34:56.789Z") });

    logger.error("Pi request failed", new Error("provider unavailable\ntry again"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ERROR Pi request failed: Error: provider unavailable | try again");
    expect(lines[0]).not.toMatch(/\n.*\n/);
  });
});
