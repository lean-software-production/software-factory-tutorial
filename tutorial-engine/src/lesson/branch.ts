import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TutorialLogger } from "../runtime-log.js";

const run = promisify(execFile);

export const LINE_BRANCH_PREFIX = "factory-line";

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Where this session's commits go.
 *
 * From lesson 007 the line commits to the calculator, and from 008 it does so
 * unattended, up to five times a run. In the workbook launcher those commits
 * land in the session-local repository under `.tutorial/<id>/workspace/.git`,
 * not in the cloned tutorial repository. This legacy branch helper keeps any
 * one-root workspace on a discardable branch when the older server path uses it.
 *
 * One branch per session rather than one for all of them, stamped to the
 * minute: each session's work is separable, and the branch a learner was on
 * last Tuesday is still there to go back to. Two sessions inside one minute
 * share a branch, which is the same as resuming.
 */
export function lineBranchName(now = new Date()): string {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${LINE_BRANCH_PREFIX}-${stamp}`;
}

async function git(workspace: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", workspace, ...args]);
  return stdout.trim();
}

export type BranchOutcome =
  | { moved: "already-there" | "created" | "switched"; branch: string }
  | { moved: "skipped"; reason: string };

/**
 * Put the workspace on the line's branch, creating it if it is not there yet.
 *
 * Never throws. A learner whose workspace is not a repository, or is mid-rebase,
 * still gets a working tutorial: only the commit station in lesson 007 depends
 * on git at all, and failing to start over a branch would cost them everything
 * else. Uncommitted work moves across with the switch, which is what git does
 * for a switch that does not conflict.
 */
export async function ensureLineBranch(workspace: string, log: TutorialLogger, now = new Date()): Promise<BranchOutcome> {
  const branch = lineBranchName(now);
  try {
    const current = await git(workspace, "rev-parse", "--abbrev-ref", "HEAD");
    if (current === branch) return { moved: "already-there", branch };

    const exists = await git(workspace, "branch", "--list", branch);
    if (exists) {
      await git(workspace, "switch", branch);
      log.info(`Switched from ${current} to ${branch}; this session's commits go there.`);
      return { moved: "switched", branch };
    }

    // Branched from wherever the last session left off, so the calculator keeps
    // the work the line has already done to it.
    await git(workspace, "switch", "-c", branch);
    log.info(`Created ${branch} from ${current}; this session's commits go there rather than on ${current}.`);
    return { moved: "created", branch };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0]! : "git was not usable";
    log.info(`Leaving the current branch alone: ${reason}`);
    return { moved: "skipped", reason };
  }
}
