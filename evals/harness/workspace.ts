import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { ArtifactState, CanonicalPatch } from "../scenarios/lesson-001/scenarios.js";

const excludedNames = new Set([".git", "node_modules", "dist", ".env", ".env.local"]);

/** Copy the learner artifact, not the trusted engine or developer credentials. */
export async function createWorkspace(repositoryRoot: string, scenarioId: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `tutorial-eval-${scenarioId}-`));
  await cp(repositoryRoot, workspace, {
    recursive: true,
    filter(source) {
      const name = basename(source);
      const fromRoot = relative(repositoryRoot, source).split("/");
      if (excludedNames.has(name) || name === ".npmrc" || name === "auth.json" || /^(credentials|secrets?)(\.|$)/i.test(name) || /\.(pem|key|p12)$/i.test(name) || name.startsWith(".env.")) return false;
      if (fromRoot[0] === "evals" && fromRoot[1] === "reports") return false;
      // Factory artifacts are learner output and are ignored in the repository.
      if (fromRoot[0] === "factory" && name !== ".gitkeep") return false;
      return true;
    }
  });
  return workspace;
}

export async function applyPatch(workspace: string, files: Record<string, string | null>): Promise<void> {
  await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const target = join(workspace, path);
    // A null deletes: a lesson that moves its artefacts has to be able to say
    // that the old path is gone, not merely that the new one has arrived.
    if (content === null) { await rm(target, { force: true }); return; }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }));
}

/**
 * Put what earlier lessons left behind into the workspace before the session
 * starts. `createWorkspace` copies no `factory/` file, so without this a lesson
 * that builds on Part 1 would ask its learner to extend, or move, nothing.
 */
export async function seedWorkspace(workspace: string, seed: Record<string, string> | undefined): Promise<void> {
  if (seed) await applyPatch(workspace, seed);
}

function matches(pattern: RegExp, content: string): boolean {
  // Canonical expectations must be reusable across a snapshot and a precondition.
  return new RegExp(pattern.source, pattern.flags).test(content);
}

/** Check file-specific state without treating a healthy file as proof of a defect elsewhere. */
export function matchesArtifactState(files: Record<string, string | null>, expected: ArtifactState): boolean {
  return Object.entries(expected).every(([path, expectation]) => {
    // A null is the same absence a patch's null writes: the file is not there.
    const exists = Object.hasOwn(files, path) && files[path] !== null;
    if (expectation.exists !== undefined && expectation.exists !== exists) return false;
    if (!exists) return !expectation.contains?.length && !expectation.excludes?.length;
    const content = files[path] ?? "";
    return (expectation.contains ?? []).every((pattern) => matches(pattern, content))
      && (expectation.excludes ?? []).every((pattern) => !matches(pattern, content));
  });
}

async function readArtifactState(workspace: string, expected: ArtifactState): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.keys(expected).map(async (path) => {
    try { return [path, await readFile(join(workspace, path), "utf8")] as const; }
    catch { return undefined; }
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
}

/** Apply one declared learner edit only after its scenario-specific precondition holds. */
export async function applyCanonicalPatch(workspace: string, patch: CanonicalPatch): Promise<void> {
  const before = await readArtifactState(workspace, patch.preconditions);
  if (!matchesArtifactState(before, patch.preconditions)) throw new Error(`Canonical patch '${patch.name}' precondition did not match the workspace.`);
  await applyPatch(workspace, patch.files);
  const after = await readArtifactState(workspace, patch.expectedState);
  if (!matchesArtifactState(after, patch.expectedState)) throw new Error(`Canonical patch '${patch.name}' did not produce its expected state.`);
}

/** Make `lesson` the first Todo row in the copied learner workspace, never in the source checkout. */
export async function activateLesson(workspace: string, lesson: string): Promise<void> {
  const ledgerPath = join(workspace, "docs/specs/README.md");
  const ledger = await readFile(ledgerPath, "utf8");
  let found = false;
  const rewritten = ledger.split(/(\r?\n)/).map((line) => {
    const cells = line.split("|");
    const id = cells[1]?.trim().match(/\[([^\]]+)\]/)?.[1];
    if (!id) return line;
    if (id === lesson) {
      found = true;
      cells[cells.length - 2] = " Todo ";
    } else if (!found) {
      cells[cells.length - 2] = " Done ";
    } else {
      cells[cells.length - 2] = " Todo ";
    }
    return cells.join("|");
  }).join("");
  if (!found) throw new Error(`Lesson '${lesson}' is not present in the workspace ledger.`);
  await writeFile(ledgerPath, rewritten, "utf8");
}

export async function snapshot(workspace: string, label: string, destination: string): Promise<Record<string, string>> {
  // Part 1 leaves flat `factory/refactor-*` files; lesson 005 moves the whole
  // line into `factory/refactor/`, so both shapes are captured.
  const paths = [
    "refactor.md", "refactor-do.sh", "refactor-quality-before.txt",
    "refactor-validate.md", "refactor-validate.sh", "refactor-validate-findings.txt",
    "refactor/refactor.md", "refactor/validate.md", "refactor/success.md", "refactor/repair.md",
    "refactor/do.sh", "refactor/validate.sh", "refactor/run.sh",
    "refactor/quality-before.txt", "refactor/validate-findings.txt"
  ];
  const factory = join(workspace, "factory");
  const files: Record<string, string> = {};
  for (const file of paths) {
    try { files[`factory/${file}`] = await readFile(join(factory, file), "utf8"); } catch { /* absent is evidence too */ }
  }
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, `${label}.json`), JSON.stringify(files, null, 2));
  return files;
}

export async function cleanupWorkspace(workspace: string, keep: boolean): Promise<void> {
  if (!keep) await rm(workspace, { recursive: true, force: true });
}

/** Keep provider credentials in Pi's user configuration, not in evaluator env. */
export function scrubProcessEnvironment(): () => void {
  const original = { ...process.env };
  const keep = new Set(["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "NO_COLOR", "CI"]);
  for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  };
}
