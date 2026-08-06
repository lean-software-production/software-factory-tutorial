import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PROGRESS_NAME = "tutorial-progress.json";

/**
 * Which lessons the learner has finished, kept beside the session transcript in
 * `factory/` rather than in the ledger.
 *
 * The ledger is curriculum and ships in the repository, so writing progress
 * into it would hand everyone who clones a tutorial that claims to be part
 * done. `factory/` is gitignored and already holds the learner's own work, so
 * state that belongs to one person lives there. `resetFactory` clears it along
 * with the transcript, which is what starting over should mean.
 */
export class LessonProgressStore {
  readonly path: string;

  constructor(workspace: string) {
    this.path = resolve(workspace, "factory", PROGRESS_NAME);
  }

  /**
   * The finished lesson ids. A missing file means a learner who has not started,
   * and an unreadable one is treated the same way: losing the highlight's
   * position is a smaller failure than refusing to open the tutorial at all.
   */
  async read(): Promise<Set<string>> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      const completed = (parsed as { completed?: unknown })?.completed;
      if (!Array.isArray(completed)) return new Set();
      return new Set(completed.filter((id): id is string => typeof id === "string"));
    } catch {
      return new Set();
    }
  }

  async write(completed: Iterable<string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify({ completed: [...completed] }, null, 2)}\n`, "utf8");
  }

  async add(id: string): Promise<Set<string>> {
    const completed = await this.read();
    completed.add(id);
    await this.write(completed);
    return completed;
  }
}
