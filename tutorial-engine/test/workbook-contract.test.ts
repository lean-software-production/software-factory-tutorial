import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateBlockFrontMatter,
  validateLessonFrontMatter,
  validatePartManifest,
  validateWorkbookLesson,
  validateWorkbookManifest,
} from "../src/workbook/contract.js";
import { loadWorkbook, loadWorkbookLesson, parseFrontMatter } from "../src/workbook/load.js";

let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

/**
 * Author a self-contained workbook whose every string is synthetic, so these
 * tests exercise front-matter assembly and directory-driven discovery without
 * coupling to a single authored word of the root curriculum. Two ordered
 * parts and one fully migrated lesson prove ordering and convention-based
 * block discovery.
 */
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-contract-")); dirs.push(dir);
  await writeFile(resolve(dir, "workbook.md"), ["---", "---", "# Fixture Workbook Identity", "", "Fixture introduction prose."].join("\n"));

  const alpha = resolve(dir, "lessons/02-alpha-part");
  const beta = resolve(dir, "lessons/01-beta-part");
  await mkdir(resolve(alpha, "10-first-lesson/blocks"), { recursive: true });
  await mkdir(resolve(beta, "01-beta-lesson/blocks"), { recursive: true });
  await writeFile(resolve(alpha, "part.md"), "---\n---\n# Second Part Title\n\nSecond part copy.\n");
  await writeFile(resolve(beta, "part.md"), "---\n---\n# First Part Title\n\nFirst part copy.\n");

  const migrated = resolve(alpha, "10-first-lesson");
  await writeFile(resolve(migrated, "lesson.md"), [
    "---",
    "durationMinutes: 12",
    "outcomes:",
    "  - Synthetic outcome one.",
    "  - Synthetic outcome two.",
    "blocks:",
    "  - intro",
    "  - practice",
    "  - edit",
    "  - think",
    "  - onward",
    "---",
    "# Synthetic Lesson Title",
    "",
    "Synthetic dek paragraph.",
  ].join("\n"));
  await writeFile(resolve(migrated, "blocks/intro.md"), ["---", "type: narrative", "---", "## Intro Block", "", "Synthetic narrative body."].join("\n"));
  await writeFile(resolve(migrated, "blocks/practice.md"), ["---", "type: terminal-practice", "tutor: Synthetic tutor guidance.", "---", "## Practice Block", "", "Synthetic practice body."].join("\n"));
  await writeFile(resolve(migrated, "blocks/edit.md"), ["---", "type: editor-practice", "path: factory/refactor.md", "tutor: Check one criterion.", "---", "## Edit Block", "", "Synthetic editor practice body."].join("\n"));
  await writeFile(resolve(migrated, "blocks/think.md"), ["---", "type: reflection", "tutor: Synthetic tutor guidance.", "---", "## Reflect Block", "", "Synthetic reflection question?"].join("\n"));
  await writeFile(resolve(migrated, "blocks/onward.md"), ["---", "type: narrative", "---", "## Onward Block", "", "Synthetic transition body."].join("\n"));

  const second = resolve(beta, "01-beta-lesson");
  await writeFile(resolve(second, "lesson.md"), [
    "---", "durationMinutes: 5", "outcomes:", "  - Beta outcome.", "blocks:", "  - only", "---",
    "# Beta Lesson Title", "", "Beta dek paragraph.",
  ].join("\n"));
  await writeFile(resolve(second, "blocks/only.md"), ["---", "type: narrative", "---", "## Only Block", "", "Beta body."].join("\n"));
  return dir;
}

async function writeFlatLesson(root: string, id: string, title: string, dek: string) {
  const lessonDir = resolve(root, "lessons", id);
  await mkdir(resolve(lessonDir, "blocks"), { recursive: true });
  await writeFile(resolve(lessonDir, "lesson.md"), [
    "---", "durationMinutes: 5", "outcomes:", `  - ${title} outcome.`, "blocks:", "  - only", "---",
    `# ${title}`, "", dek,
  ].join("\n"));
  await writeFile(resolve(lessonDir, "blocks/only.md"), ["---", "type: narrative", "---", "## Only Block", "", `${title} body.`].join("\n"));
}

async function flatFixture(workbookFrontMatter = "---\n---") {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-flat-contract-")); dirs.push(dir);
  await writeFile(resolve(dir, "workbook.md"), [workbookFrontMatter, "# Flat Fixture Workbook", "", "Flat fixture introduction."].join("\n"));
  await writeFlatLesson(dir, "002-second-lesson", "Second Flat Lesson", "Second flat dek.");
  await writeFlatLesson(dir, "001-first-lesson", "First Flat Lesson", "First flat dek.");
  return dir;
}

function flatPartsManifest(partId = "part-one", lessons = ["001-first-lesson", "002-second-lesson"]) {
  return [
    "---",
    "parts:",
    `  - id: ${partId}`,
    "    lessons:",
    ...lessons.map((lesson) => `      - ${lesson}`),
    "---",
  ].join("\n");
}

async function writePartDocument(root: string, id: string, title = "Part One Title", body = "Part one copy.") {
  await mkdir(resolve(root, "parts"), { recursive: true });
  await writeFile(resolve(root, "parts", `${id}.md`), ["---", "---", `# ${title}`, "", body].join("\n"));
}

/** Rewrite the fixture's alpha lesson.md (lessonNumber 2), keeping everything but its dek/introduction. */
function alphaLessonMd(dek: string, introduction = "") {
  return [
    "---",
    "durationMinutes: 12",
    "outcomes:",
    "  - Synthetic outcome one.",
    "  - Synthetic outcome two.",
    "blocks:",
    "  - intro",
    "  - practice",
    "  - edit",
    "  - think",
    "  - onward",
    "---",
    "# Synthetic Lesson Title",
    "",
    dek,
    ...(introduction ? ["", introduction] : []),
  ].join("\n");
}

/** Rewrite the fixture's beta lesson.md (lessonNumber 1), keeping everything but its dek/introduction. */
function betaLessonMd(dek: string, introduction = "") {
  return [
    "---", "durationMinutes: 5", "outcomes:", "  - Beta outcome.", "blocks:", "  - only", "---",
    "# Beta Lesson Title", "", dek,
    ...(introduction ? ["", introduction] : []),
  ].join("\n");
}

/** Rewrite the fixture's alpha intro.md block, keeping everything but its body. */
function introBlockMd(markdown: string) {
  return ["---", "type: narrative", "---", "## Intro Block", "", markdown].join("\n");
}

/** Resolve a promise and return its rejection message, or fail the test if it does not reject. */
async function messageFrom(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("expected the promise to reject");
}

describe("workbook lesson contract", () => {
  it("assembles a lesson from authored Markdown with stable ordered blocks", async () => {
    const dir = await fixture();
    const lesson = await loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "02-alpha-part/10-first-lesson");
    expect(lesson.id).toBe("02-alpha-part/10-first-lesson");
    expect(lesson.title).toBe("Synthetic Lesson Title");
    expect(lesson.dek).toBe("Synthetic dek paragraph.");
    expect(lesson.introduction).toBe("");
    expect(lesson.durationMinutes).toBe(12);
    expect(lesson.outcomes).toEqual(["Synthetic outcome one.", "Synthetic outcome two."]);
    expect(lesson.blocks.map((block) => [block.id, block.type, block.title])).toEqual([
      ["intro", "narrative", "Intro Block"],
      ["practice", "terminal-practice", "Practice Block"],
      ["edit", "editor-practice", "Edit Block"],
      ["think", "reflection", "Reflect Block"],
      ["onward", "narrative", "Onward Block"],
    ]);
    const intro = lesson.blocks[0];
    if (intro?.type !== "narrative") throw new Error("intro must be narrative");
    expect(intro.markdown).toBe("Synthetic narrative body.");
    const practice = lesson.blocks[1];
    if (practice?.type !== "terminal-practice") throw new Error("practice must be terminal-practice");
    expect(practice.tutor).toBe("Synthetic tutor guidance.");
    expect(practice.markdown).toBe("Synthetic practice body.");
    const edit = lesson.blocks[2];
    if (edit?.type !== "editor-practice") throw new Error("edit must be editor-practice");
    expect(edit.path).toBe("factory/refactor.md");
    expect(edit.tutor).toBe("Check one criterion.");
    expect(edit.markdown).toBe("Synthetic editor practice body.");
    // The private tutor field never appears on narrative blocks.
    expect((intro as any).tutor).toBeUndefined();
    expect((lesson.blocks[4] as any).tutor).toBeUndefined();
  });

  it("does not fall back to legacy nested part directories when no flat lessons exist", async () => {
    const dir = await fixture();
    const loaded = await loadWorkbook(dir);
    expect(loaded.chapters).toEqual([]);
  });

  it("discovers flat lessons in numeric directory order and leaves part fields absent when workbook parts are absent", async () => {
    const dir = await flatFixture();
    const loaded = await loadWorkbook(dir);

    expect(loaded.chapters.map((chapter) => [chapter.id, chapter.title, chapter.lessonNumber])).toEqual([
      ["001-first-lesson", "First Flat Lesson", 1],
      ["002-second-lesson", "Second Flat Lesson", 2],
    ]);
    expect(loaded.chapters.map((chapter) => ({ part: chapter.part, partMarkdown: chapter.partMarkdown, partNumber: chapter.partNumber }))).toEqual([
      { part: undefined, partMarkdown: undefined, partNumber: undefined },
      { part: undefined, partMarkdown: undefined, partNumber: undefined },
    ]);
  });

  it("loads workbook-declared flat parts from parts/<id>.md and orders lessons by the manifest", async () => {
    const dir = await flatFixture(flatPartsManifest("part-one", ["002-second-lesson", "001-first-lesson"]));
    await writePartDocument(dir, "part-one", "Part One Title", "Part one copy.");

    const loaded = await loadWorkbook(dir);

    expect(loaded.chapters.map((chapter) => [chapter.id, chapter.part, chapter.partNumber, chapter.partMarkdown])).toEqual([
      ["002-second-lesson", "Part One Title", 1, "Part one copy."],
      ["001-first-lesson", "Part One Title", 1, "Part one copy."],
    ]);
  });

  it("validates workbook-declared flat parts against lessons on disk", async () => {
    const cases: Array<[string, string, string | undefined]> = [
      ["unknown", flatPartsManifest("part-one", ["001-first-lesson", "999-missing-lesson", "002-second-lesson"]), undefined],
      ["duplicate", flatPartsManifest("part-one", ["001-first-lesson", "001-first-lesson"]), undefined],
      ["omitted", flatPartsManifest("part-one", ["001-first-lesson"]), undefined],
      ["missing part", flatPartsManifest("part-one"), undefined],
      ["malformed part", flatPartsManifest("Bad Part"), undefined],
      ["malformed lesson", flatPartsManifest("part-one", ["001-first-lesson", "Bad Lesson"]), undefined],
    ];

    for (const [label, manifest] of cases) {
      const dir = await flatFixture(manifest);
      if (label !== "missing part" && label !== "malformed part") await writePartDocument(dir, "part-one");
      const message = await messageFrom(loadWorkbook(dir));
      expect(message, label).toMatch(new RegExp(label === "missing part" ? "missing" : label === "omitted" ? "omit" : label.split(" ")[0]!, "i"));
    }
  });

  it("resolves a canonical lesson reference in a lesson dek, introduction, and block to a standard Markdown link", async () => {
    const dir = await flatFixture();
    const token = "[[lesson:001-first-lesson]]";
    await writeFile(resolve(dir, "lessons/002-second-lesson/lesson.md"), betaLessonMd(token, `Intro refers back to ${token}.`));
    await writeFile(resolve(dir, "lessons/002-second-lesson/blocks/only.md"), introBlockMd(token));

    const workbook = await loadWorkbook(dir);
    const chapter = workbook.chapters.find((c) => c.id === "002-second-lesson");
    const expected = "[Lesson 1: First Flat Lesson](#lesson-001-first-lesson)";
    expect(chapter?.lesson.dek).toBe(expected);
    expect(chapter?.lesson.introduction).toBe(`Intro refers back to ${expected}.`);
    expect(chapter?.lesson.blocks[0]?.markdown).toBe(expected);
  });

  it("rejects an unknown lesson reference in an introduction, naming its source file and the canonical syntax", async () => {
    const dir = await flatFixture();
    await writeFile(resolve(dir, "lessons/002-second-lesson/lesson.md"), betaLessonMd("Second flat dek.", "[[lesson:999-missing-lesson]]"));
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/unknown lesson reference/i);
    expect(message).toContain("lessons/002-second-lesson/lesson.md");
    expect(message).toContain("[[lesson:<flat-id>]]");
  });

  it("rejects an empty lesson reference, naming its source file and the canonical syntax", async () => {
    const dir = await flatFixture();
    await writeFile(resolve(dir, "lessons/002-second-lesson/lesson.md"), betaLessonMd("[[lesson:]]"));
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/empty lesson reference/i);
    expect(message).toContain("lessons/002-second-lesson/lesson.md");
    expect(message).toContain("[[lesson:<flat-id>]]");
  });

  it("rejects a malformed lesson reference, naming its source file and the canonical syntax", async () => {
    const dir = await flatFixture();
    await writeFile(resolve(dir, "lessons/002-second-lesson/lesson.md"), betaLessonMd("[[lesson:Not Valid Id]]"));
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/malformed lesson reference/i);
    expect(message).toContain("lessons/002-second-lesson/lesson.md");
    expect(message).toContain("[[lesson:<flat-id>]]");
  });

  it("rejects an unterminated lesson reference, naming its source file and the canonical syntax", async () => {
    const dir = await flatFixture();
    await writeFile(resolve(dir, "lessons/002-second-lesson/lesson.md"), betaLessonMd("[[lesson:001-first-lesson"));
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/unterminated lesson reference/i);
    expect(message).toContain("lessons/002-second-lesson/lesson.md");
    expect(message).toContain("[[lesson:<flat-id>]]");
  });

  it("rejects a lesson reference to its own lesson", async () => {
    const dir = await flatFixture();
    await writeFile(resolve(dir, "lessons/002-second-lesson/lesson.md"), betaLessonMd("[[lesson:002-second-lesson]]"));
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/refers to its own lesson/i);
    expect(message).toContain("lessons/002-second-lesson/lesson.md");
    expect(message).toContain("[[lesson:<flat-id>]]");
  });

  it("rejects a lesson reference to a later (forward) lesson", async () => {
    const dir = await flatFixture();
    await writeFile(resolve(dir, "lessons/001-first-lesson/lesson.md"), betaLessonMd("[[lesson:002-second-lesson]]"));
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/refers to a later lesson/i);
    expect(message).toContain("lessons/001-first-lesson/lesson.md");
    expect(message).toContain("[[lesson:<flat-id>]]");
  });

  it("rejects every lesson reference token in workbook.md", async () => {
    const dir = await flatFixture();
    await writeFile(resolve(dir, "workbook.md"), [
      "---", "---", "# Fixture Workbook Identity", "",
      "Fixture introduction referencing [[lesson:001-first-lesson]].",
    ].join("\n"));
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/workbook\.md may not contain a lesson reference/i);
    expect(message).toContain("workbook.md");
    expect(message).toContain("[[lesson:<flat-id>]]");
  });

  it("rejects a part's own first lesson but lets a later part resolve an earlier part's lesson", async () => {
    const manifest = [
      "---",
      "parts:",
      "  - id: first-part",
      "    lessons:",
      "      - 001-first-lesson",
      "  - id: second-part",
      "    lessons:",
      "      - 002-second-lesson",
      "---",
    ].join("\n");
    const dir = await flatFixture(manifest);
    await writePartDocument(dir, "first-part", "First Part", "First part copy referencing [[lesson:001-first-lesson]].");
    await writePartDocument(dir, "second-part", "Second Part", "Second part copy.");
    const rejectMessage = await messageFrom(loadWorkbook(dir));
    expect(rejectMessage).toMatch(/must name a lesson before this part's first lesson/i);
    expect(rejectMessage).toContain("parts/first-part.md");
    expect(rejectMessage).toContain("[[lesson:<flat-id>]]");

    await writePartDocument(dir, "first-part", "First Part", "First part copy.");
    await writePartDocument(dir, "second-part", "Second Part", "Second part copy referencing [[lesson:001-first-lesson]].");
    const workbook = await loadWorkbook(dir);
    const chapter = workbook.chapters.find((c) => c.id === "002-second-lesson");
    expect(chapter?.partMarkdown).toBe(
      "Second part copy referencing [Lesson 1: First Flat Lesson](#lesson-001-first-lesson).");
  });

  it("rejects a malformed lesson reference in a flat part document, naming the parts file itself", async () => {
    const dir = await flatFixture(flatPartsManifest());
    await writePartDocument(dir, "part-one", "Part One Title", "[[lesson:]]");
    const message = await messageFrom(loadWorkbook(dir));
    expect(message).toMatch(/empty lesson reference/i);
    expect(message).toContain(resolve(dir, "parts/part-one.md"));
  });

  it("parses front matter and requires it even when empty", () => {
    expect(parseFrontMatter("---\ntitle: X\n---\nbody text")).toEqual({ data: { title: "X" }, body: "body text" });
    expect(parseFrontMatter("---\n---\nbody text")).toEqual({ data: {}, body: "body text" });
    expect(() => parseFrontMatter("no front matter")).toThrow(/front matter/i);
  });

  it("rejects a lesson without exactly one H1 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "---",
      "No heading at all, just a dek paragraph.",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/exactly one H1/i);
  });

  it("rejects a lesson with two H1 title headings", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "---",
      "# First Title", "", "Dek.", "", "# Second Title",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/exactly one H1/i);
  });

  it("rejects lesson prose before its H1 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "  - practice", "  - think", "  - onward", "---",
      "This prose appears before the title and must not become the dek.", "", "# Title",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/content before the H1 title/i);
  });

  it("extracts Markdown-rich lesson introduction after the dek paragraph", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), alphaLessonMd(
      "Dek paragraph.",
      ["Intro paragraph with **Markdown**.", "", "- Keep this list.", "- And this item.", "", "```sh", "echo hi", "```"].join("\n"),
    ));
    const loaded = await loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id");
    expect(loaded.dek).toBe("Dek paragraph.");
    expect(loaded.introduction).toBe("Intro paragraph with **Markdown**.\n\n- Keep this list.\n- And this item.\n\n```sh\necho hi\n```");
  });

  it("rejects a block without exactly one H2 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/blocks/intro.md"), ["---", "type: narrative", "---", "# Wrong Level", "", "Body."].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/exactly one H2/i);
  });

  it("rejects block prose before its H2 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/blocks/intro.md"), ["---", "type: narrative", "---", "Body before title.", "", "## Intro", "", "Body after title."].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/content before the H2 title/i);
  });

  it("rejects a lesson.md that lists a block file which does not exist", async () => {
    const dir = await fixture();
    const lessonDir = resolve(dir, "lessons/02-alpha-part/10-first-lesson");
    // Remove the other authored block files so the only mismatch under test is the missing one.
    await Promise.all(["practice", "edit", "think", "onward"].map((id) => unlink(resolve(lessonDir, `blocks/${id}.md`))));
    await writeFile(resolve(lessonDir, "lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "  - missing-block", "---",
      "# Title", "", "Dek.",
    ].join("\n"));
    await expect(loadWorkbookLesson(lessonDir, "id")).rejects.toThrow(/missing-block/);
  });

  it("rejects a lesson.md that duplicates a block id", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "  - intro", "---",
      "# Title", "", "Dek.",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/more than once|duplicate/i);
  });

  it("rejects a blocks/ directory that contains a file unlisted in front matter", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/blocks/extra.md"), ["---", "type: narrative", "---", "## Extra", "", "Body."].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/extra/);
  });

  it("rejects a lesson.md that is missing entirely", async () => {
    const dir = await fixture();
    const empty = resolve(dir, "lessons/02-alpha-part/20-empty-lesson");
    await mkdir(resolve(empty, "blocks"), { recursive: true });
    await expect(loadWorkbookLesson(empty, "id")).rejects.toThrow();
  });

  it("reports location-specific errors for malformed lesson front matter", () => {
    let message = "";
    try { validateLessonFrontMatter({ durationMinutes: "twelve", outcomes: [], blocks: [], extra: true }, "lessons/x/lesson.md"); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toMatch(/lessons\/x\/lesson\.md: unknown front matter field "extra"/);
    expect(message).toMatch(/lessons\/x\/lesson\.md: durationMinutes must be a positive number/);
    expect(message).toMatch(/lessons\/x\/lesson\.md: outcomes must be a non-empty list/);
    expect(message).toMatch(/lessons\/x\/lesson\.md: blocks must be a non-empty ordered list/);
  });

  it("rejects an outcomes list containing a non-string or empty entry", () => {
    expect(() => validateLessonFrontMatter({ durationMinutes: 5, outcomes: ["Fine.", ""], blocks: ["a"] }, "lesson.md")).toThrow(/outcomes/);
    expect(() => validateLessonFrontMatter({ durationMinutes: 5, outcomes: ["Fine.", 4], blocks: ["a"] }, "lesson.md")).toThrow(/outcomes/);
  });

  it("rejects malformed block ids", () => {
    expect(() => validateLessonFrontMatter({ durationMinutes: 5, outcomes: ["X"], blocks: ["Bad Id!"] }, "lesson.md")).toThrow(/blocks/);
  });

  it("requires a non-empty tutor field for terminal-practice, reflection, and editor-practice blocks", () => {
    expect(() => validateBlockFrontMatter({ type: "terminal-practice" }, "blocks/x.md")).toThrow(/tutor/);
    expect(() => validateBlockFrontMatter({ type: "reflection", tutor: "   " }, "blocks/x.md")).toThrow(/tutor/);
    expect(() => validateBlockFrontMatter({ type: "editor-practice", path: "factory/refactor.md" }, "blocks/edit.md")).toThrow(/tutor/);
    expect(validateBlockFrontMatter({ type: "terminal-practice", tutor: "Do X." }, "blocks/x.md")).toEqual({ type: "terminal-practice", tutor: "Do X." });
  });

  it("accepts editor-practice path and private tutor front matter", () => {
    expect(validateBlockFrontMatter(
      { type: "editor-practice", path: "factory/refactor.md", tutor: "Check one criterion." },
      "blocks/edit.md",
    )).toEqual({ type: "editor-practice", path: "factory/refactor.md", tutor: "Check one criterion." });
  });

  it("requires a non-empty path for editor-practice blocks", () => {
    expect(() => validateBlockFrontMatter(
      { type: "editor-practice", tutor: "Check it." }, "blocks/edit.md",
    )).toThrow(/path/);
    expect(() => validateBlockFrontMatter(
      { type: "editor-practice", path: "   ", tutor: "Check it." }, "blocks/edit.md",
    )).toThrow(/path/);
  });

  it("rejects a path field on non-editor-practice blocks", () => {
    expect(() => validateBlockFrontMatter({ type: "narrative", path: "factory/x.md" }, "blocks/x.md")).toThrow(/path/);
    expect(() => validateBlockFrontMatter({ type: "terminal-practice", path: "factory/x.md", tutor: "Do X." }, "blocks/x.md")).toThrow(/path/);
    expect(() => validateBlockFrontMatter({ type: "reflection", path: "factory/x.md", tutor: "Think." }, "blocks/x.md")).toThrow(/path/);
  });

  it("rejects a tutor field on narrative blocks", () => {
    expect(() => validateBlockFrontMatter({ type: "narrative", tutor: "Not allowed." }, "blocks/x.md")).toThrow(/tutor/);
  });

  it("rejects an unsupported block type", () => {
    expect(() => validateBlockFrontMatter({ type: "mystery" }, "blocks/x.md")).toThrow(/type/);
    expect(() => validateBlockFrontMatter({ type: "lesson-transition" }, "blocks/x.md")).toThrow(/type/);
  });

  it("rejects unknown front matter fields on blocks", () => {
    expect(() => validateBlockFrontMatter({ type: "narrative", command: "echo hi" }, "blocks/x.md")).toThrow(/unknown front matter field "command"/);
  });

  it("accepts workbook parts front matter and keeps part document front matter empty", () => {
    expect(validateWorkbookManifest({}, "workbook.md")).toEqual({});
    expect(validateWorkbookManifest({ parts: [{ id: "part-one", lessons: ["001-first-lesson"] }] }, "workbook.md")).toEqual({ parts: [{ id: "part-one", lessons: ["001-first-lesson"] }] });
    expect(() => validateWorkbookManifest({ title: "X" }, "workbook.md")).toThrow(/unknown front matter field "title"/);
    expect(() => validateWorkbookManifest({ parts: [{ id: "Bad Part", lessons: ["001-first-lesson"] }] }, "workbook.md")).toThrow(/malformed|lowercase-hyphenated/);
    expect(validatePartManifest({}, "parts/x.md")).toEqual({});
    expect(() => validatePartManifest({ order: 1 }, "parts/x.md")).toThrow(/unknown front matter field "order"/);
  });

  it("requires an assembled lesson introduction string while allowing it to be empty", () => {
    expect(validateWorkbookLesson({
      id: "x", title: "Title", dek: "Dek", introduction: "", durationMinutes: 5, outcomes: ["Outcome."],
      blocks: [{ id: "a", type: "narrative", title: "A", markdown: "Body" }],
    }, "lesson").introduction).toBe("");
    expect(() => validateWorkbookLesson({
      id: "x", title: "Title", dek: "Dek", durationMinutes: 5, outcomes: ["Outcome."],
      blocks: [{ id: "a", type: "narrative", title: "A", markdown: "Body" }],
    }, "lesson")).toThrow(/introduction/);
    expect(() => validateWorkbookLesson({
      id: "x", title: "Title", dek: "Dek", introduction: 42, durationMinutes: 5, outcomes: ["Outcome."],
      blocks: [{ id: "a", type: "narrative", title: "A", markdown: "Body" }],
    }, "lesson")).toThrow(/introduction/);
  });

  it("reports location-specific errors for a malformed assembled lesson", () => {
    expect(() => validateWorkbookLesson({
      id: "x",
      title: "Title",
      dek: "Dek",
      introduction: "",
      durationMinutes: 5,
      outcomes: ["Outcome."],
      blocks: [
        { id: "dup", type: "terminal-practice", title: "One", markdown: "Body" },
        { id: "dup", type: "mystery", title: "Two", markdown: "Body" },
      ],
    }, "lesson"))
      .toThrow(/lesson\.blocks\[0\]\.tutor is required[\s\S]*lesson\.blocks\[1\]\.id must be unique[\s\S]*lesson\.blocks\[1\]\.type is unsupported/);
  });

  it("rejects an invalid or non-positive duration on the assembled lesson", () => {
    expect(() => validateWorkbookLesson({
      id: "x", title: "Title", dek: "Dek", introduction: "", durationMinutes: 0, outcomes: ["Outcome."],
      blocks: [{ id: "a", type: "narrative", title: "A", markdown: "Body" }],
    }, "lesson")).toThrow(/durationMinutes/);
  });
});
