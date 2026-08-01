import { appendFile, readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseTutorialEvent, type TutorialEvent } from "./protocol/events.js";

const SESSION_LOG_NAME = "tutorial-session.jsonl";

/**
 * Append-only browser transcript storage. It deliberately records protocol events,
 * rather than Pi's internal session, so a stopped tool call is never revived.
 */
export class TutorialSessionLog {
  readonly path: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(workspace: string) {
    this.path = resolve(workspace, "factory", SESSION_LOG_NAME);
  }

  async exists(): Promise<boolean> {
    try {
      const contents = await readFile(this.path, "utf8");
      return contents.trim().length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read(): Promise<TutorialEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: TutorialEvent[] = [];
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const event = parseTutorialEvent(line);
        if (event.type === "snapshot") throw new Error("Snapshots are not transcript events.");
        events.push(event);
      } catch (error) {
        throw new Error(`Could not read saved tutorial session at line ${index + 1}: ${error instanceof Error ? error.message : "invalid event"}`);
      }
    }
    return events;
  }

  append(event: TutorialEvent): void {
    if (event.type === "snapshot" || event.type === "session-state") return;
    this.#writes = this.#writes.then(async () => {
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async clear(): Promise<void> {
    await this.flush();
    await rm(this.path, { force: true });
  }

  async flush(): Promise<void> {
    await this.#writes;
  }
}

/** Remove learner artifacts, leaving the repository's placeholder file intact. */
export async function resetFactory(workspace: string): Promise<void> {
  const factory = resolve(workspace, "factory");
  const entries = await readdir(factory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name !== ".gitkeep")
    .map((entry) => rm(resolve(factory, entry.name), { recursive: entry.isDirectory(), force: true })));
}
