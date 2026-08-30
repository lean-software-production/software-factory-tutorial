import { execFile } from "node:child_process";
import { chmod, cp, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkbook } from "../../../tutorial-engine/src/workbook/load.js";
import type { TutorDecision } from "../../../tutorial-engine/src/workbook/tutor.js";
import { RecordingMainTutor } from "../../../tutorial-engine/test/support/fake-tutors.js";
import { createAuthoredCurriculumSliceWorkspace, sha256File, type AuthoredCurriculumSliceSelection, type AuthoredEvaluatorPrerequisite, type AuthoredSliceProvenanceEntry } from "../workspace.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const sourceTutorialRoot = resolve(import.meta.dirname, "../../../tutorial");
const twoLessonKeyConceptSlice: AuthoredCurriculumSliceSelection = {
  parts: [{
    id: "validation-loop",
    lessons: [
      { id: "003-build-a-validator", blocks: ["key-concept"] },
      { id: "004-feed-the-findings-back", blocks: ["key-concept"] }
    ]
  }]
};

const tetrisPrimerSlice: AuthoredCurriculumSliceSelection = {
  parts: [{
    id: "what-is-a-factory",
    lessons: [{ id: "tetris" }]
  }]
};

const exactTetrisSpec = `# Tetris

Build a game of Tetris that runs in the terminal.

Start it with:

    npm start

Keep the complete game display within 24 terminal rows, including the board, score, controls,
borders, and game-over messages.

You may install packages if they help you render or control the terminal display.
`;

class AuthoredSliceFakeTutor extends RecordingMainTutor {
  protected override defaultReply = "Public fake tutor reply.";
  protected override blockSummaryFor = (blockId: string) => `Public summary for ${blockId}.`;
  protected override lessonSummaryFor = (lessonId: string) => `Public lesson summary for ${lessonId}.`;
  protected override async decide(): Promise<TutorDecision> { return { outcome: "accepted", message: "Accepted by deterministic fake tutor." }; }
}

afterEach(async () => {
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
  tempRoots.length = 0;
});

function frontMatterBody(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const closing = lines.indexOf("---", 1);
  if (lines[0] !== "---" || closing < 0) throw new Error("test fixture expected front matter");
  return lines.slice(closing + 1).join("\n");
}

async function makeSourceCopy(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "authored-source-copy-"));
  tempRoots.push(root);
  const tutorial = resolve(root, "tutorial");
  await cp(sourceTutorialRoot, tutorial, { recursive: true });
  return tutorial;
}

async function expectStartServerRejectedByPrerequisite(prerequisite: AuthoredEvaluatorPrerequisite, message: RegExp, sourceRoot = sourceTutorialRoot): Promise<void> {
  const workspace = await createAuthoredCurriculumSliceWorkspace({
    sourceTutorialRoot: sourceRoot,
    selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
    prerequisites: [prerequisite]
  });
  tempRoots.push(workspace.repositoryRoot);

  await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() })).rejects.toThrow(message);
  await workspace.close().catch(() => undefined);
  await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
}

async function materializedCurriculumEntries(root: string): Promise<{ kind: "file" | "directory"; relativePath: string }[]> {
  const entries: { kind: "file" | "directory"; relativePath: string }[] = [{ kind: "directory", relativePath: "." }];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".tutorial", ".tmp", "node_modules", ".git", ".DS_Store"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      const relativePath = path.slice(root.length + 1).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        entries.push({ kind: "directory", relativePath });
        await visit(path);
      } else if (entry.isFile()) {
        entries.push({ kind: "file", relativePath });
      }
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.kind.localeCompare(right.kind));
}

function provenanceEntryFor(entries: readonly AuthoredSliceProvenanceEntry[], kind: "file" | "directory", materializedRelativePath: string): AuthoredSliceProvenanceEntry | undefined {
  return entries.find((entry) => entry.kind === kind && entry.materializedRelativePath === materializedRelativePath);
}

describe("authored curriculum slice materialization", () => {
  it("materializes the Tetris primer with its exact workspace fixture and practice blocks", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      tempParent: tmpdir(),
      selection: tetrisPrimerSlice
    });
    tempRoots.push(workspace.repositoryRoot);

    const loaded = await loadWorkbook(workspace.root);
    expect(loaded.chapters.map((chapter) => chapter.id)).toEqual(["tetris"]);
    expect(loaded.chapters[0]?.lesson.workspace).toBe("tetris");
    expect(loaded.chapters[0]?.lesson.blocks.map((block) => ({
      id: block.id,
      type: block.type,
      path: "path" in block ? block.path : undefined
    }))).toEqual([
      { id: "read-the-spec", type: "editor-practice", path: "spec.md" },
      { id: "write-worker-prompt", type: "editor-practice", path: "prompt.md" },
      { id: "write-the-loop", type: "editor-practice", path: "ralph.sh" },
      { id: "run-the-factory", type: "terminal-practice", path: undefined }
    ]);

    expect(await readFile(resolve(workspace.root, "workspaces/tetris/spec.md"), "utf8"))
      .toBe(exactTetrisSpec);
    expect((await materializedCurriculumEntries(workspace.root))
      .filter((entry) => entry.relativePath === "workspaces/tetris" || entry.relativePath.startsWith("workspaces/tetris/")))
      .toEqual([
        { kind: "directory", relativePath: "workspaces/tetris" },
        { kind: "file", relativePath: "workspaces/tetris/spec.md" }
      ]);
    expect(workspace.provenance.files.find((entry) => entry.materializedRelativePath === "workspaces/tetris/spec.md"))
      .toMatchObject({ exact: true, sourceRelativePath: "workspaces/tetris/spec.md" });

    const workerPrompt = await readFile(
      resolve(workspace.root, "lessons/tetris/blocks/write-worker-prompt.md"),
      "utf8"
    );
    expect(workerPrompt).toMatch(/checks? must return on (?:their|its) own/i);
    expect(workerPrompt).toMatch(/do not start the game/i);
    expect(workerPrompt).toMatch(/non-interactive check/i);

    const terminalBlock = await readFile(
      resolve(workspace.root, "lessons/tetris/blocks/run-the-factory.md"),
      "utf8"
    );
    for (const marker of expectedTetrisPassMarkers()) expect(terminalBlock).toContain(marker);
    expect(terminalBlock).toMatch(/returned to the prompt/i);
    expect(terminalBlock).not.toMatch(/playable|perfect/i);

    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });

  it("keeps authored-workbook evaluator ownership at the repository root without a public runner yet", async () => {
    const packageJson = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../package.json"), "utf8")) as { scripts: Record<string, string> };
    const engineTsconfig = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../tutorial-engine/evals/tsconfig.json"), "utf8")) as { include: string[] };

    expect(packageJson.scripts["eval:workbook"]).toBeUndefined();
    expect(packageJson.scripts["check:eval:workbook"]).toBe("tsc -p evals/workbook/tsconfig.json");
    expect(packageJson.scripts["test:eval:workbook"]).toBe("vitest run evals/workbook/test/*.test.ts");
    expect(packageJson.scripts.check).not.toContain("check:eval:workbook");
    expect(packageJson.scripts.check).not.toContain("test:eval:workbook");
    expect(engineTsconfig.include).not.toContain("authored/**/*.ts");
    await expect(stat(resolve(import.meta.dirname, "../run.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(import.meta.dirname, "../../../tutorial-engine/evals/authored"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies selected authored lesson and block IDs with provenance while excluding unrelated lessons", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({ tempParent: tmpdir(), selection: twoLessonKeyConceptSlice });
    tempRoots.push(workspace.repositoryRoot);

    const loaded = await loadWorkbook(workspace.root);
    expect(loaded.identity.title).toBe("Software Factory Tutorial");
    expect(loaded.chapters.map((chapter) => chapter.id)).toEqual(["003-build-a-validator", "004-feed-the-findings-back"]);
    expect(loaded.chapters.map((chapter) => chapter.partId)).toEqual(["validation-loop", "validation-loop"]);
    expect(loaded.chapters.map((chapter) => chapter.lesson.blocks.map((block) => block.id))).toEqual([["key-concept"], ["key-concept"]]);

    await expect(stat(resolve(workspace.root, "lessons/002-build-a-doer"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(workspace.root, "lessons/003-build-a-validator/blocks/implementation-order.md"))).rejects.toMatchObject({ code: "ENOENT" });

    expect(workspace.provenance.roots.sourceTutorialRoot).toMatchObject({ path: workspace.sourceTutorialRoot, internal: true, reportable: false });
    expect(workspace.provenance.roots.materializedRoot).toMatchObject({ path: workspace.root, internal: true, reportable: false });
    for (const entry of workspace.provenance.files) {
      const source = resolve(workspace.sourceTutorialRoot, entry.sourceRelativePath);
      const materialized = resolve(workspace.root, entry.materializedRelativePath);
      expect(entry.kind).toBe("file");
      expect(entry.internal).toBe(false);
      expect(entry.reportable).toBe(true);
      expect(entry.sourceSha256).toBe(await sha256File(source));
      expect(entry.materializedSha256).toBe(await sha256File(materialized));
      expect(entry.sourceMode).toBe((await stat(source)).mode.toString(8).slice(-4));
      expect(entry.materializedMode).toBe((await stat(materialized)).mode.toString(8).slice(-4));
      if (entry.exact) {
        expect(await readFile(materialized)).toEqual(await readFile(source));
        expect(entry.materializedSha256).toBe(entry.sourceSha256);
      } else {
        expect(entry.materializedSha256).not.toBe(entry.sourceSha256);
      }
    }
    for (const materialized of await materializedCurriculumEntries(workspace.root)) {
      const entry = provenanceEntryFor(workspace.provenance.entries, materialized.kind, materialized.relativePath);
      expect(entry, `missing provenance for ${materialized.kind} ${materialized.relativePath}`).toBeDefined();
      expect(entry).toMatchObject({ kind: materialized.kind, materializedRelativePath: materialized.relativePath, internal: false, reportable: true });
    }

    const sourceLesson004 = await readFile(resolve(workspace.sourceTutorialRoot, "lessons/004-feed-the-findings-back/lesson.md"), "utf8");
    const copiedLesson004 = await readFile(resolve(workspace.root, "lessons/004-feed-the-findings-back/lesson.md"), "utf8");
    expect(frontMatterBody(copiedLesson004)).toBe(frontMatterBody(sourceLesson004));

    expect(workspace.provenance.files.find((entry) => entry.materializedRelativePath === "workbook.md")).toMatchObject({ exact: false, note: "front matter narrowed to selected authored parts and lessons" });
    expect(workspace.provenance.files.find((entry) => entry.materializedRelativePath === "parts/validation-loop.md")).toMatchObject({ exact: false, note: "part heading ordinal adjusted so the isolated slice satisfies the workbook loader invariant" });
    expect(workspace.provenance.files.find((entry) => entry.materializedRelativePath === "lessons/003-build-a-validator/lesson.md")).toMatchObject({ exact: false, note: "lesson front matter narrowed to selected authored blocks" });
    expect(workspace.provenance.files.find((entry) => entry.materializedRelativePath === "lessons/004-feed-the-findings-back/lesson.md")).toMatchObject({ exact: false, note: "lesson front matter narrowed to selected authored blocks" });
    expect(frontMatterBody(await readFile(resolve(workspace.root, "workbook.md"), "utf8"))).toBe(frontMatterBody(await readFile(resolve(workspace.sourceTutorialRoot, "workbook.md"), "utf8")));
    expect(await readFile(resolve(workspace.root, "parts/validation-loop.md"), "utf8")).toContain("In this part, we'll run our validation loop in slow-motion");

    const sourceBlock = resolve(workspace.sourceTutorialRoot, "lessons/003-build-a-validator/blocks/key-concept.md");
    const copiedBlock = resolve(workspace.root, "lessons/003-build-a-validator/blocks/key-concept.md");
    const originalBlockCopy = await readFile(copiedBlock, "utf8");
    await writeFile(copiedBlock, "mutated disposable copy\n");
    expect(await readFile(sourceBlock, "utf8")).toContain("A **validator** is the agent");
    expect(await readFile(sourceBlock, "utf8")).not.toContain("mutated disposable copy");
    await writeFile(copiedBlock, originalBlockCopy);

    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });

  it("records unchanged generated manifests as exact when an explicit selection does not alter bytes", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept", "implementation-order", "advanced-substitute-another-validator", "checks", "pressure-test"] }] }] }
    });
    tempRoots.push(workspace.repositoryRoot);

    const lessonEntry = workspace.provenance.files.find((entry) => entry.materializedRelativePath === "lessons/003-build-a-validator/lesson.md");
    expect(lessonEntry).toMatchObject({ exact: true });
    expect(lessonEntry).not.toHaveProperty("note");
    expect(await readFile(resolve(workspace.root, "lessons/003-build-a-validator/lesson.md"))).toEqual(await readFile(resolve(workspace.sourceTutorialRoot, "lessons/003-build-a-validator/lesson.md")));

    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });

  it("skips generated workspace state including populated node_modules without provenance", async () => {
    const source = await makeSourceCopy();
    await mkdir(resolve(source, "workspaces/refactor-line/factory/.tmp"), { recursive: true });
    await mkdir(resolve(source, "workspaces/refactor-line/factory/.tutorial/session"), { recursive: true });
    await mkdir(resolve(source, "workspaces/refactor-line/factory/node_modules/pkg"), { recursive: true });
    await mkdir(resolve(source, "workspaces/refactor-line/factory/.git/objects"), { recursive: true });
    await writeFile(resolve(source, "workspaces/refactor-line/factory/.tmp/private-progress.txt"), "do not copy\n");
    await writeFile(resolve(source, "workspaces/refactor-line/factory/.tutorial/session/state.json"), "{}\n");
    await writeFile(resolve(source, "workspaces/refactor-line/factory/node_modules/pkg/index.js"), "do not copy deps\n");
    await writeFile(resolve(source, "workspaces/refactor-line/factory/.git/config"), "do not copy vcs\n");
    await writeFile(resolve(source, "workspaces/refactor-line/factory/.DS_Store"), "metadata\n");

    const workspace = await createAuthoredCurriculumSliceWorkspace({ sourceTutorialRoot: source, selection: twoLessonKeyConceptSlice });
    tempRoots.push(workspace.repositoryRoot);

    const materializedPaths = workspace.provenance.entries.map((entry) => entry.materializedRelativePath);
    for (const generated of [".tmp", ".tutorial", "node_modules", ".git", ".DS_Store"]) {
      expect(materializedPaths.some((path) => path.split("/").includes(generated))).toBe(false);
    }
    await expect(stat(resolve(workspace.root, "workspaces/refactor-line/factory/.tmp/private-progress.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(workspace.root, "workspaces/refactor-line/factory/.tutorial/session/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(workspace.root, "workspaces/refactor-line/factory/node_modules/pkg/index.js"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(workspace.root, "workspaces/refactor-line/factory/.git/config"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(workspace.root, "workspaces/refactor-line/factory/.DS_Store"))).rejects.toMatchObject({ code: "ENOENT" });

    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves selected workspace empty directories and permission modes with typed directory provenance", async () => {
    const source = await makeSourceCopy();
    await mkdir(resolve(source, "workspaces/refactor-line/factory/empty-mode-dir"), { recursive: true });
    await chmod(resolve(source, "workspaces/refactor-line/factory/empty-mode-dir"), 0o750);
    await chmod(resolve(source, "workspaces/refactor-line/factory/refactor.md"), 0o744);

    const workspace = await createAuthoredCurriculumSliceWorkspace({ sourceTutorialRoot: source, selection: twoLessonKeyConceptSlice });
    tempRoots.push(workspace.repositoryRoot);

    const copiedDir = resolve(workspace.root, "workspaces/refactor-line/factory/empty-mode-dir");
    const copiedFile = resolve(workspace.root, "workspaces/refactor-line/factory/refactor.md");
    await expect(readdir(copiedDir)).resolves.toEqual([]);
    expect((await stat(copiedDir)).mode.toString(8).slice(-4)).toBe("0750");
    expect((await stat(copiedFile)).mode.toString(8).slice(-4)).toBe("0744");
    expect(provenanceEntryFor(workspace.provenance.entries, "directory", "workspaces/refactor-line/factory/empty-mode-dir")).toMatchObject({ kind: "directory", sourceMode: "0750", materializedMode: "0750", exact: true });
    expect(provenanceEntryFor(workspace.provenance.entries, "file", "workspaces/refactor-line/factory/refactor.md")).toMatchObject({ kind: "file", sourceMode: "0744", materializedMode: "0744", exact: true });

    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects same-mode selected workspace empty directory replacement before invoking the server", async () => {
    const source = await makeSourceCopy();
    const sourceDirectory = resolve(source, "workspaces/refactor-line/factory/empty-identity-dir");
    const outsideTarget = resolve(dirname(source), "outside-empty-identity-target");
    await mkdir(sourceDirectory, { recursive: true });
    await chmod(sourceDirectory, 0o750);
    await mkdir(outsideTarget, { recursive: true });
    await writeFile(resolve(outsideTarget, "sentinel.txt"), "outside unchanged\n");
    const sourceBefore = await stat(sourceDirectory);
    const outsideBefore = await stat(outsideTarget);
    let serverInvoked = false;

    const workspace = await createAuthoredCurriculumSliceWorkspace({
      sourceTutorialRoot: source,
      selection: twoLessonKeyConceptSlice,
      dependencies: { startWorkbookServer: async () => { serverInvoked = true; return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} }; } },
      prerequisites: [{
        id: "same-mode-empty-directory-replacement",
        description: "Deletes and recreates an empty selected workspace directory with the same mode.",
        async apply({ contentRoot }) {
          const destination = resolve(contentRoot, "workspaces/refactor-line/factory/empty-identity-dir");
          const mode = (await stat(destination)).mode & 0o7777;
          await rm(destination, { recursive: true });
          await mkdir(destination);
          await chmod(destination, mode);
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() })).rejects.toThrow(/mutated the disposable curriculum content/);
    expect(serverInvoked).toBe(false);
    await workspace.close().catch(() => undefined);
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);

    const sourceAfter = await stat(sourceDirectory);
    expect({ dev: sourceAfter.dev, ino: sourceAfter.ino, mode: sourceAfter.mode & 0o7777 }).toEqual({ dev: sourceBefore.dev, ino: sourceBefore.ino, mode: sourceBefore.mode & 0o7777 });
    const outsideAfter = await stat(outsideTarget);
    expect({ dev: outsideAfter.dev, ino: outsideAfter.ino, mode: outsideAfter.mode & 0o7777 }).toEqual({ dev: outsideBefore.dev, ino: outsideBefore.ino, mode: outsideBefore.mode & 0o7777 });
    expect(await readFile(resolve(outsideTarget, "sentinel.txt"), "utf8")).toBe("outside unchanged\n");
  });

  it("ignores excluded generated directory creation and removal without parent nlink false positives", async () => {
    const source = await makeSourceCopy();
    const sourceParent = resolve(source, "workspaces/refactor-line/factory");
    await mkdir(resolve(sourceParent, "node_modules/pkg"), { recursive: true });
    let serverInvoked = false;

    const workspace = await createAuthoredCurriculumSliceWorkspace({
      sourceTutorialRoot: source,
      selection: twoLessonKeyConceptSlice,
      dependencies: { startWorkbookServer: async () => { serverInvoked = true; return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} }; } },
      prerequisites: [{
        id: "generated-directory-link-count-noise",
        description: "Creates and removes only generated directory state that is excluded from guarded manifests.",
        async apply({ contentRoot }) {
          await rm(resolve(sourceParent, "node_modules"), { recursive: true, force: true });
          await mkdir(resolve(sourceParent, ".tmp"), { recursive: true });
          await mkdir(resolve(contentRoot, "workspaces/refactor-line/factory/.tutorial/session"), { recursive: true });
          await mkdir(resolve(contentRoot, "workspaces/refactor-line/factory/.git/objects"), { recursive: true });
          await mkdir(resolve(contentRoot, "workspaces/refactor-line/factory/node_modules/pkg"), { recursive: true });
          await mkdir(resolve(contentRoot, "workspaces/refactor-line/factory/.tmp"), { recursive: true });
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    const server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() });
    expect(serverInvoked).toBe(true);
    await server.close();
    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);
  });

  it("rejects selected authored source files with hardlink aliases before materialization", async () => {
    const source = await makeSourceCopy();
    const selectedBlock = resolve(source, "lessons/003-build-a-validator/blocks/key-concept.md");
    const outsideAlias = resolve(dirname(source), "outside-key-concept-alias.md");
    const originalBytes = await readFile(selectedBlock);
    await link(selectedBlock, outsideAlias);

    await expect(createAuthoredCurriculumSliceWorkspace({ sourceTutorialRoot: source, selection: twoLessonKeyConceptSlice })).rejects.toThrow(/hardlink(?:ed file| aliases).*key-concept/);
    expect(await readFile(selectedBlock)).toEqual(originalBytes);
    expect(await readFile(outsideAlias)).toEqual(originalBytes);
  });

  it("rejects same-content hardlink swaps in disposable curriculum before invoking the server", async () => {
    const source = await makeSourceCopy();
    const originalSource = await readFile(resolve(source, "lessons/003-build-a-validator/blocks/key-concept.md"));
    const outsideTarget = resolve(dirname(source), "outside-hardlink-target.md");
    await writeFile(outsideTarget, originalSource);
    let serverInvoked = false;

    const workspace = await createAuthoredCurriculumSliceWorkspace({
      sourceTutorialRoot: source,
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      dependencies: { startWorkbookServer: async () => { serverInvoked = true; return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} }; } },
      prerequisites: [{
        id: "hardlink-disposable-curriculum",
        description: "Replaces curriculum with an outside hardlink that preserves bytes and mode.",
        async apply({ contentRoot }) {
          const destination = resolve(contentRoot, "lessons/003-build-a-validator/blocks/key-concept.md");
          await chmod(outsideTarget, (await stat(destination)).mode & 0o7777);
          await rm(destination);
          await link(outsideTarget, destination);
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() })).rejects.toThrow(/hardlinked file|mutated the disposable curriculum content/);
    expect(serverInvoked).toBe(false);
    await workspace.close().catch(() => undefined);
    expect(await readFile(outsideTarget)).toEqual(originalSource);
    await expect(stat(outsideTarget)).resolves.toBeDefined();
  });

  it("rejects disposable curriculum hardlinks to source before invoking the server without changing source bytes", async () => {
    const source = await makeSourceCopy();
    const selectedSource = resolve(source, "lessons/003-build-a-validator/blocks/key-concept.md");
    const originalSource = await readFile(selectedSource);
    let serverInvoked = false;

    const workspace = await createAuthoredCurriculumSliceWorkspace({
      sourceTutorialRoot: source,
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      dependencies: { startWorkbookServer: async () => { serverInvoked = true; return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} }; } },
      prerequisites: [{
        id: "hardlink-disposable-to-source",
        description: "Replaces disposable curriculum with a hardlink to immutable source.",
        async apply({ contentRoot }) {
          const destination = resolve(contentRoot, "lessons/003-build-a-validator/blocks/key-concept.md");
          await rm(destination);
          await link(selectedSource, destination);
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() })).rejects.toThrow(/hardlinked file|immutable authored source tutorial|disposable curriculum content/);
    expect(serverInvoked).toBe(false);
    await workspace.close().catch(() => undefined);
    expect(await readFile(selectedSource)).toEqual(originalSource);
  });

  it("rejects selected source path replacement between validation and materialization without mutating the outside replacement", async () => {
    const source = await makeSourceCopy();
    const relativePath = "lessons/003-build-a-validator/blocks/key-concept.md";
    const selectedSource = resolve(source, relativePath);
    const originalBytes = await readFile(selectedSource);
    const outsideReplacement = resolve(dirname(source), "outside-race-replacement.md");
    await writeFile(outsideReplacement, originalBytes);
    await chmod(outsideReplacement, (await stat(selectedSource)).mode & 0o7777);
    let replaced = false;

    await expect(createAuthoredCurriculumSliceWorkspace({
      sourceTutorialRoot: source,
      selection: twoLessonKeyConceptSlice,
      dependencies: {
        async beforeSourceFileOpen(openedRelativePath) {
          if (openedRelativePath !== relativePath || replaced) return;
          replaced = true;
          await rm(selectedSource);
          await link(outsideReplacement, selectedSource);
        }
      }
    })).rejects.toThrow(/changed before materialization|hardlink aliases/);

    expect(replaced).toBe(true);
    expect(await readFile(outsideReplacement)).toEqual(originalBytes);
    await expect(stat(outsideReplacement)).resolves.toBeDefined();
  });

  it("rejects selected parts supplied out of authored source order", async () => {
    await expect(createAuthoredCurriculumSliceWorkspace({
      selection: {
        parts: [
          { id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] },
          { id: "what-is-a-factory", lessons: [{ id: "what-is-a-factory" }] }
        ]
      }
    })).rejects.toThrow(/parts must be supplied in authored source order/);
  });

  it("rejects selected lessons supplied out of authored source order", async () => {
    await expect(createAuthoredCurriculumSliceWorkspace({
      selection: { parts: [{ id: "validation-loop", lessons: [
        { id: "004-feed-the-findings-back", blocks: ["key-concept"] },
        { id: "003-build-a-validator", blocks: ["key-concept"] }
      ] }] }
    })).rejects.toThrow(/lessons for part 'validation-loop' must be supplied in authored source order/);
  });

  it("rejects symlink escapes for derived selected source files", async () => {
    const source = await makeSourceCopy();
    const outside = resolve(dirname(source), "outside-part.md");
    await writeFile(outside, "---\n---\n# Part 2 — Outside\n\nescape\n");
    await rm(resolve(source, "parts/validation-loop.md"));
    await symlink(outside, resolve(source, "parts/validation-loop.md"));

    await expect(createAuthoredCurriculumSliceWorkspace({ sourceTutorialRoot: source, selection: twoLessonKeyConceptSlice })).rejects.toThrow(/symlink.*parts\/validation-loop\.md/);
  });

  it("rejects symlink escapes for selected workspace roots", async () => {
    const source = await makeSourceCopy();
    const outside = resolve(dirname(source), "outside-workspace");
    await mkdir(outside, { recursive: true });
    await rm(resolve(source, "workspaces/refactor-line"), { recursive: true, force: true });
    await symlink(outside, resolve(source, "workspaces/refactor-line"));

    await expect(createAuthoredCurriculumSliceWorkspace({ sourceTutorialRoot: source, selection: twoLessonKeyConceptSlice })).rejects.toThrow(/symlink.*workspaces\/refactor-line/);
  });

  it("starts fresh normal sessions under the disposable tutorial state and progresses Lesson 003 into Lesson 004", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      tempParent: tmpdir(),
      selection: twoLessonKeyConceptSlice,
      prerequisites: [{
        id: "deterministic-session-note",
        description: "Write an evaluator-owned note in the live lesson workspace only.",
        async apply({ session }) {
          await mkdir(resolve(session.workspaceRoots["refactor-line"]!, "factory/.tmp"), { recursive: true });
          await writeFile(resolve(session.workspaceRoots["refactor-line"]!, "factory/.tmp/evaluator-prerequisite.txt"), "session-local prerequisite\n");
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    const server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() }, { session: { id: "authored-slice-one" } });
    try {
      const post = async (path: string, body?: unknown): Promise<any> => {
        const response = await fetch(`${server.url}${path}`, { method: "POST", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
        expect(response.ok).toBe(true);
        const json = await response.json() as any;
        return "state" in json ? json.state : json;
      };

      let state = await post("/api/workbook/introduction");
      while (state.currentBlock?.origin === "structural") state = await post("/api/workbook/complete-block", { blockId: state.progress.activeBlockId });
      expect(state.progress.activeLessonId).toBe("003-build-a-validator");
      expect(state.progress.activeBlockId).toBe("lesson--003-build-a-validator--key-concept");

      state = await post("/api/workbook/events", { blockId: state.progress.activeBlockId, action: "continue" });
      while (state.currentBlock?.origin === "structural") state = await post("/api/workbook/complete-block", { blockId: state.progress.activeBlockId });
      expect(state.progress.activeLessonId).toBe("004-feed-the-findings-back");
      expect(state.progress.activeBlockId).toBe("lesson--004-feed-the-findings-back--key-concept");

      expect(workspace.sessions).toHaveLength(1);
      const session = workspace.latestSession();
      expect(session.sessionRoot).toBe(resolve(await realpath(workspace.root), ".tutorial/authored-slice-one"));
      expect(session.contentRoot).toBe(await realpath(workspace.root));
      expect(session.workspaceRoots["refactor-line"]).toBe(resolve(session.sessionRoot, "workspaces/refactor-line"));
      expect(session.runtimeProvision?.mounts).toHaveLength(1);
      expect(session.runtimeProvision?.mounts[0]).toMatchObject({ workspaceTarget: "node_modules", readonly: true });
      expect(session.runtimeProvision?.mounts[0]?.hostSource).toBe(await realpath(resolve(import.meta.dirname, "../../../node_modules")));
      await expect(readdir(resolve(session.workspaceRoots["refactor-line"]!, "node_modules"))).resolves.toEqual([]);
      expect(await readFile(resolve(session.workspaceRoots["refactor-line"]!, ".gitignore"), "utf8")).toContain("node_modules/\n");
      await expect(stat(resolve(session.sessionRoot, "workbook/events.jsonl"))).resolves.toBeDefined();
      await expect(stat(resolve(workspace.root, "workbook/events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(resolve(session.workspaceRoots["refactor-line"]!, "factory/.tmp/evaluator-prerequisite.txt"))).resolves.toBeDefined();
      await expect(stat(resolve(workspace.root, "workspaces/refactor-line/factory/.tmp/evaluator-prerequisite.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await workspace.close();
      tempRoots.length = 0;
    }
  });

  it("allows generated source/session/dependency state during prerequisites while still rejecting authored source changes", async () => {
    const source = await makeSourceCopy();
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      sourceTutorialRoot: source,
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      prerequisites: [{
        id: "generated-state",
        description: "Writes only ignored generated state in source and session workspaces.",
        async apply({ session }) {
          await mkdir(resolve(source, ".tutorial/session"), { recursive: true });
          await mkdir(resolve(source, "workspaces/refactor-line/factory/.tmp"), { recursive: true });
          await mkdir(resolve(source, "workspaces/refactor-line/factory/node_modules/pkg"), { recursive: true });
          await mkdir(resolve(source, "workspaces/refactor-line/factory/.git"), { recursive: true });
          await writeFile(resolve(source, ".tutorial/session/events.jsonl"), "ignored\n");
          await writeFile(resolve(source, "workspaces/refactor-line/factory/.tmp/progress.txt"), "ignored\n");
          await writeFile(resolve(source, "workspaces/refactor-line/factory/node_modules/pkg/index.js"), "ignored\n");
          await writeFile(resolve(source, "workspaces/refactor-line/factory/.git/config"), "ignored\n");
          await writeFile(resolve(source, "workspaces/refactor-line/factory/.DS_Store"), "ignored\n");
          await mkdir(resolve(session.workspaceRoots["refactor-line"]!, "factory/.tmp"), { recursive: true });
          await writeFile(resolve(session.workspaceRoots["refactor-line"]!, "factory/.tmp/prereq.txt"), "session-local\n");
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    const server = await workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() });
    await server.close();
    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.splice(tempRoots.indexOf(workspace.repositoryRoot), 1);

    await expectStartServerRejectedByPrerequisite({
      id: "bad-unrelated-source-write",
      description: "Mutates unrelated authored curriculum outside the selected slice.",
      async apply() {
        await writeFile(resolve(source, "lessons/002-build-a-doer/blocks/key-concept.md"), "mutated unrelated source\n");
      }
    }, /mutated the immutable authored source tutorial/, source);
  });

  it("passes the trusted node_modules runtime provision into disposable workbook servers", async () => {
    let capturedSession: any;
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      dependencies: {
        startWorkbookServer: async (options) => {
          capturedSession = options.session;
          return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} };
        }
      }
    });
    tempRoots.push(workspace.repositoryRoot);

    await workspace.startServer({ mainTutor: new AuthoredSliceFakeTutor() });

    expect(capturedSession.runtimeProvision?.mounts).toHaveLength(1);
    expect(capturedSession.runtimeProvision.mounts[0]).toMatchObject({ workspaceTarget: "node_modules", readonly: true });
    expect(await readdir(resolve(capturedSession.workspaceRoots["refactor-line"], "node_modules"))).toEqual([]);
    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });

  it("rejects evaluator prerequisites that mutate disposable curriculum content", async () => {
    await expectStartServerRejectedByPrerequisite({
      id: "bad-curriculum-write",
      description: "Incorrectly writes outside .tutorial.",
      async apply({ contentRoot }) {
        await writeFile(resolve(contentRoot, "lessons/003-build-a-validator/blocks/key-concept.md"), "mutated curriculum\n");
      }
    }, /mutated the disposable curriculum content/);
  });

  it("rejects evaluator prerequisites that alter source curriculum captured outside the context, even when they throw", async () => {
    const source = await makeSourceCopy();
    await expectStartServerRejectedByPrerequisite({
      id: "bad-source-write",
      description: "Incorrectly writes to the immutable authored source root captured by closure.",
      async apply() {
        await writeFile(resolve(source, "lessons/003-build-a-validator/blocks/key-concept.md"), "mutated source\n");
        throw new Error("prerequisite exploded after mutating source");
      }
    }, /mutated the immutable authored source tutorial/, source);
  });

  it("rejects symlinks introduced anywhere in learner workspaces during prerequisites and taints later starts", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      prerequisites: [{
        id: "bad-session-symlink",
        description: "Adds a symlink to a learner workspace.",
        async apply({ session }) {
          await symlink(resolve(session.workspaceRoots["refactor-line"]!, "factory/refactor.md"), resolve(session.workspaceRoots["refactor-line"]!, "factory/refactor-link.md"));
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() }, { session: { id: "bad-symlink-one" } })).rejects.toThrow(/Session learner workspace .* symlink/);
    await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() }, { session: { id: "bad-symlink-two" } })).rejects.toThrow(/Session learner workspace .* symlink/);
    await workspace.close();
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });

  it("rejects hardlink aliases to sourced content introduced in learner workspaces during prerequisites", async () => {
    const source = await makeSourceCopy();
    await expectStartServerRejectedByPrerequisite({
      id: "bad-hardlink",
      description: "Hardlinks a source file into the learner workspace.",
      async apply({ session }) {
        await link(resolve(source, "workspaces/refactor-line/factory/refactor.md"), resolve(session.workspaceRoots["refactor-line"]!, "factory/source-hardlink.md"));
      }
    }, /hardlink alias outside internal \.git/, source);
  });

  it("rejects evaluator prerequisites that add empty directories to curriculum", async () => {
    await expectStartServerRejectedByPrerequisite({
      id: "bad-empty-dir",
      description: "Incorrectly adds an empty directory to curriculum.",
      async apply({ contentRoot }) {
        await mkdir(resolve(contentRoot, "lessons/003-build-a-validator/empty-dir"));
      }
    }, /mutated the disposable curriculum content/);
  });

  it("rejects evaluator prerequisites that add symlinks to curriculum", async () => {
    await expectStartServerRejectedByPrerequisite({
      id: "bad-symlink",
      description: "Incorrectly adds a symlink to curriculum.",
      async apply({ contentRoot }) {
        await symlink(resolve(contentRoot, "workbook.md"), resolve(contentRoot, "lessons/003-build-a-validator/link.md"));
      }
    }, /Structural manifest refuses symlink/);
  });

  it("rejects evaluator prerequisites that add unsupported nodes to curriculum", async () => {
    await expectStartServerRejectedByPrerequisite({
      id: "bad-fifo",
      description: "Incorrectly adds an unsupported filesystem node to curriculum.",
      async apply({ contentRoot }) {
        await execFileAsync("mkfifo", [resolve(contentRoot, "lessons/003-build-a-validator/fifo")]);
      }
    }, /Structural manifest refuses unsupported filesystem node/);
  });

  it("rejects evaluator prerequisites that change curriculum file modes", async () => {
    await expectStartServerRejectedByPrerequisite({
      id: "bad-chmod",
      description: "Incorrectly changes curriculum file modes.",
      async apply({ contentRoot }) {
        await chmod(resolve(contentRoot, "lessons/003-build-a-validator/blocks/key-concept.md"), 0o755);
      }
    }, /mutated the disposable curriculum content/);
  });

  it("rejects evaluator prerequisites that change curriculum root directory mode", async () => {
    await expectStartServerRejectedByPrerequisite({
      id: "bad-root-chmod",
      description: "Incorrectly changes the curriculum root directory mode.",
      async apply({ contentRoot }) {
        await chmod(contentRoot, 0o700);
      }
    }, /mutated the disposable curriculum content/);
  });

  it("does not reset the disposable curriculum baseline after a rejected prerequisite mutation", async () => {
    let firstRun = true;
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      prerequisites: [{
        id: "bad-first-run-write",
        description: "Mutates curriculum only on the first attempted start.",
        async apply({ contentRoot }) {
          if (!firstRun) return;
          firstRun = false;
          await writeFile(resolve(contentRoot, "lessons/003-build-a-validator/blocks/key-concept.md"), "mutated once\n");
        }
      }]
    });
    tempRoots.push(workspace.repositoryRoot);

    await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() }, { session: { id: "bad-one" } })).rejects.toThrow(/mutated the disposable curriculum content/);
    await expect(workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() }, { session: { id: "bad-two" } })).rejects.toThrow(/mutated the disposable curriculum content/);
    await workspace.close().catch(() => undefined);
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });

  it("detects server-time curriculum mutations during cleanup while still deleting release workspaces", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      dependencies: {
        startWorkbookServer: async (options) => {
          await writeFile(resolve(options.target, "lessons/003-build-a-validator/blocks/key-concept.md"), "mutated after start\n");
          return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} };
        }
      }
    });
    tempRoots.push(workspace.repositoryRoot);
    await workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() });

    await expect(workspace.close()).rejects.toThrow(/Failed to clean authored curriculum slice workspace/);
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;
  });

  it("keeps diagnostics for post-run mutations when requested", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      keepWorkspace: true,
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      dependencies: {
        startWorkbookServer: async (options) => {
          await writeFile(resolve(options.target, "lessons/003-build-a-validator/blocks/key-concept.md"), "mutated after start\n");
          return { url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => {} };
        }
      }
    });
    tempRoots.push(workspace.repositoryRoot);
    await workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() });

    await expect(workspace.close()).rejects.toThrow(/Failed to clean authored curriculum slice workspace/);
    await expect(stat(workspace.repositoryRoot)).resolves.toBeDefined();
    expect(await readFile(resolve(workspace.repositoryRoot, "cleanup-failure.txt"), "utf8")).toContain("Evaluator run mutated the disposable curriculum content");
  });

  it("removes disposable repositories by default even when server close fails and preserves diagnostics only when kept", async () => {
    const closeFailure = new Error("fake close failed");
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      dependencies: { startWorkbookServer: async () => ({ url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => { throw closeFailure; } }) }
    });
    tempRoots.push(workspace.repositoryRoot);
    await workspace.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() });

    await expect(workspace.close()).rejects.toThrow(/Failed to clean authored curriculum slice workspace/);
    await expect(stat(workspace.repositoryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    tempRoots.length = 0;

    const kept = await createAuthoredCurriculumSliceWorkspace({
      keepWorkspace: true,
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] },
      dependencies: { startWorkbookServer: async () => ({ url: "http://127.0.0.1:1", port: 1, host: "127.0.0.1", close: async () => { throw closeFailure; } }) }
    });
    tempRoots.push(kept.repositoryRoot);
    await kept.startServer({ embeddedTerminal: false, mainTutor: new AuthoredSliceFakeTutor() });
    await expect(kept.close()).rejects.toThrow(/Failed to clean authored curriculum slice workspace/);
    await expect(stat(kept.repositoryRoot)).resolves.toBeDefined();
    expect(await readFile(resolve(kept.repositoryRoot, "cleanup-failure.txt"), "utf8")).toContain("fake close failed");
  });

  it("can deliberately keep a disposable authored workspace for local diagnostics", async () => {
    const workspace = await createAuthoredCurriculumSliceWorkspace({
      keepWorkspace: true,
      selection: { parts: [{ id: "validation-loop", lessons: [{ id: "003-build-a-validator", blocks: ["key-concept"] }] }] }
    });
    tempRoots.push(workspace.repositoryRoot);

    await workspace.close();

    await expect(stat(workspace.repositoryRoot)).resolves.toBeDefined();
  });
});

function expectedTetrisPassMarkers(): string[] {
  return [1, 2, 3, 4, 5].flatMap((pass) => [
    `Pass ${pass}/5: starting`,
    `Pass ${pass}/5: done`
  ]);
}
