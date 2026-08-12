import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { tutorialStatePath } from "./tutorial-state.js";
import { isTranscriptEvent, parseTutorialEvent, type TutorialEvent } from "./protocol/events.js";

const SESSION_LOG_NAME = "tutorial-session.jsonl";


/**
 * Append-only browser transcript storage. It deliberately records protocol events,
 * rather than Pi's internal session, so a stopped tool call is never revived.
 */
export class TutorialSessionLog {
  readonly path: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(workspace: string) {
    this.path = tutorialStatePath(workspace, SESSION_LOG_NAME);
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
    if (!isTranscriptEvent(event)) return;
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
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

/** Clear generic tutor state without touching curriculum-owned learner work. */
export async function resetTutorialState(workspace: string): Promise<void> {
  await rm(tutorialStatePath(workspace), { recursive: true, force: true });
}
