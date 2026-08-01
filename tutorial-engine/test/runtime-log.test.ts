import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("duplicates diagnostics to the configured local file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tutorial-log-"));
    const filePath = join(directory, "tutorial.log");
    try {
      const logger = createTutorialLogger({ write: () => {}, filePath, now: () => new Date("2026-08-01T12:34:56.789Z") });
      logger.info("Tutor session is ready.");

      await expect(readFile(filePath, "utf8")).resolves.toBe("[tutorial 2026-08-01T12:34:56.789Z] INFO Tutor session is ready.\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
