import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ensureLineBranch, lineBranchName, LINE_BRANCH_PREFIX } from "../src/lesson/branch.js";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", ["-C", cwd, ...args]);
const head = async (cwd: string) => (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();

const log = { info: () => {}, error: () => {} } as never;

// A fixed clock, so the branch under test is the branch asserted on.
const session = new Date(2026, 7, 6, 10, 15);
const branch = lineBranchName(session);
const ensure = (workspace: string, at = session) => ensureLineBranch(workspace, log, at);

async function repository(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "branch-"));
  await git(workspace, "init", "-q", "-b", "main");
  await git(workspace, "config", "user.email", "test@example.com");
  await git(workspace, "config", "user.name", "Test");
  await writeFile(join(workspace, "file.txt"), "one\n", "utf8");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-qm", "first");
  return workspace;
}

describe("lineBranchName", () => {
  it("stamps the session so each one is separable and last week's is still there", () => {
    expect(lineBranchName(new Date(2026, 7, 6, 10, 15))).toBe(`${LINE_BRANCH_PREFIX}-2026-08-06-1015`);
    expect(lineBranchName(new Date(2026, 0, 2, 9, 5))).toBe(`${LINE_BRANCH_PREFIX}-2026-01-02-0905`);
  });

  it("gives two sessions on the same day different branches", () => {
    expect(lineBranchName(new Date(2026, 7, 6, 10, 15)))
      .not.toBe(lineBranchName(new Date(2026, 7, 6, 16, 40)));
  });
});

describe("ensureLineBranch", () => {
  it("moves the learner off the branch they cloned, so the line's commits land elsewhere", async () => {
    const workspace = await repository();

    expect(await ensure(workspace)).toEqual({ moved: "created", branch: branch });
    expect(await head(workspace)).toBe(branch);
  });

  it("returns to the existing branch on a later session rather than failing to recreate it", async () => {
    const workspace = await repository();
    await ensure(workspace);
    await git(workspace, "switch", "-q", "main");

    expect(await ensure(workspace)).toEqual({ moved: "switched", branch: branch });
    expect(await head(workspace)).toBe(branch);
  });

  it("does nothing when the learner is already there", async () => {
    const workspace = await repository();
    await ensure(workspace);

    expect(await ensure(workspace)).toEqual({ moved: "already-there", branch: branch });
  });

  it("carries uncommitted work across, so a session never strands the learner's edits", async () => {
    const workspace = await repository();
    await writeFile(join(workspace, "file.txt"), "edited\n", "utf8");

    await ensure(workspace);

    expect(await head(workspace)).toBe(branch);
    const status = (await git(workspace, "status", "--porcelain")).stdout;
    expect(status).toContain("file.txt");
  });

  it("opens the tutorial anyway when the workspace is not a repository", async () => {
    // Only lesson 007's commit station needs git. Refusing to start would cost
    // the learner every other lesson to protect one.
    const workspace = await mkdtemp(join(tmpdir(), "no-git-"));

    const outcome = await ensure(workspace);

    expect(outcome.moved).toBe("skipped");
  });
});
