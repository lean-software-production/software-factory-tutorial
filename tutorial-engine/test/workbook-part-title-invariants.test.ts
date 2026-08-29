import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkbook } from "../src/workbook/load.js";

async function write(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function workbookFixture(partTitle: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workbook-parts-"));
  await write(resolve(root, "workbook.md"), `---
parts:
  - id: first
    lessons:
      - first-lesson
  - id: second
    lessons:
      - second-lesson
---

# Workbook

Intro.
`);
  await write(resolve(root, "parts/first.md"), `---
---

# Part 1 — First

Start here.
`);
  await write(resolve(root, "parts/second.md"), `---
---

# ${partTitle}

Continue here.
`);

  for (const lessonId of ["first-lesson", "second-lesson"]) {
    await write(resolve(root, `lessons/${lessonId}/lesson.md`), `---
durationMinutes: 5
blocks:
  - read
---

# ${lessonId}

A short dek.
`);
    await write(resolve(root, `lessons/${lessonId}/blocks/read.md`), `---
type: narrative
---

## Read

Read this.
`);
  }

  return root;
}

describe("authored workbook part title invariants", () => {
  it("rejects an explicit Part N heading that disagrees with workbook.md order", async () => {
    const root = await workbookFixture("Part 3 — Second");

    await expect(loadWorkbook(root)).rejects.toThrow(
      /parts\/second\.md: H1 says "Part 3", but .*workbook\.md lists this part at position 2/,
    );
  });

  it("allows part headings without explicit numbering", async () => {
    const root = await workbookFixture("The validation loop");

    const loaded = await loadWorkbook(root);

    expect(loaded.chapters.map((chapter) => [chapter.part, chapter.partNumber])).toEqual([
      ["Part 1 — First", 1],
      ["The validation loop", 2],
    ]);
  });
});
