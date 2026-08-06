import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ENGINE_STATE_DIRECTORY } from "../session-log.js";

const PROGRESS_NAME = "tutorial-progress.json";

/**
 * Lessons the learner finished, and lessons they jumped over by starting at
 * Part 2. Kept apart so the outline can say which is which: a skipped lesson is
 * not one they did.
 */
export interface LessonProgress {
  completed: Set<string>;
  skipped: Set<string>;
}

const ids = (value: unknown): Set<string> =>
  Array.isArray(value) ? new Set(value.filter((id): id is string => typeof id === "string")) : new Set();

/**
 * Which lessons the learner has finished, kept with the session transcript
 * rather than in the ledger.
 *
 * The ledger is curriculum and ships in the repository, so writing progress
 * into it would hand everyone who clones a tutorial that claims to be part
 * done. This belongs to one learner, so it sits in `factory/.tmp/` — the
 * engine's own corner of the learner's factory. `resetFactory` clears it along
 * with everything else, which is what starting over should mean.
 */
export class LessonProgressStore {
  readonly path: string;

  constructor(workspace: string) {
    this.path = resolve(workspace, "factory", ENGINE_STATE_DIRECTORY, PROGRESS_NAME);
  }

  /**
   * A missing file means a learner who has not started, and an unreadable one is
   * treated the same way: losing the highlight's position is a smaller failure
   * than refusing to open the tutorial at all.
   */
  async read(): Promise<LessonProgress> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { completed: new Set(), skipped: new Set() };
      throw error;
    }
    try {
      const parsed = JSON.parse(contents) as { completed?: unknown; skipped?: unknown };
      return { completed: ids(parsed?.completed), skipped: ids(parsed?.skipped) };
    } catch {
      return { completed: new Set(), skipped: new Set() };
    }
  }

  async write(progress: { completed: Iterable<string>; skipped?: Iterable<string> }): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const document = { completed: [...progress.completed], skipped: [...progress.skipped ?? []] };
    await writeFile(this.path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }

  async add(id: string): Promise<LessonProgress> {
    const progress = await this.read();
    progress.completed.add(id);
    await this.write(progress);
    return progress;
  }
}
