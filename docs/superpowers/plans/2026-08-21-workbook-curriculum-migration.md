# Workbook Curriculum Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the block-authored workbook self-navigating and internally consistent while preserving its
existing lesson mechanisms.

**Architecture:** Curriculum changes remain Markdown and lesson-manifest changes; no new block type or tutor
capability is introduced. The loader continues to discover ordered directories, but assigns one monotonic
lesson number across all parts. The existing workbook UI renders that number and renders each part’s roadmap
only once.

**Tech Stack:** Markdown/YAML curriculum manifests, TypeScript, React 19, Vitest.

**Spec:** Approved bounded design in this session: course/part roadmap, handoff and capstone blocks,
`.tmp/events` consistency, glossary alignment, and global lesson numbering.

## Global Constraints

- Keep all regenerated run evidence in the line-local `.tmp/events/` directory.
- Keep tutor directions in interactive block front matter, never learner-visible Markdown.
- Keep `workbook.md` and `part.md` front matter empty.
- Do not introduce a block type or a tutor feature for curriculum framing; use existing narrative, reflection,
  and lesson-transition blocks.
- Preserve numbered directory ordering; do not hard-code the number of parts or lessons.
- Prose wraps at 100 columns.

---

### Task 1: Repair curriculum continuity and add learner framing

**Files:**
- Modify: `workbook.md`
- Modify: `lessons/01-the-validation-loop/part.md`
- Modify: `lessons/02-build-the-factory/part.md`
- Modify: `lessons/02-build-the-factory/01-join-them-into-a-line/lesson.md`
- Create: `lessons/02-build-the-factory/01-join-them-into-a-line/blocks/part-2-entry-checkpoint.md`
- Modify: `lessons/02-build-the-factory/09-oversee-the-orchestrator/lesson.md`
- Create: `lessons/02-build-the-factory/09-oversee-the-orchestrator/blocks/capstone-closure.md`
- Modify: `lessons/02-build-the-factory/01-join-them-into-a-line/blocks/key-concept.md`
- Modify: `lessons/02-build-the-factory/05-record-what-happened/blocks/implementation-order.md`
- Modify: `lessons/02-build-the-factory/05-record-what-happened/blocks/checks.md`
- Modify: `lessons/02-build-the-factory/07-ask-what-happened/blocks/implementation-order.md`
- Modify: `lessons/02-build-the-factory/08-talk-to-a-station/blocks/implementation-order.md`
- Modify: `docs/GLOSSARY.md`
- Test: `tutorial-engine/test/workbook-contract.test.ts`

**Interfaces:**
- Consumes: existing lesson-manifest `blocks` ordering and block types.
- Produces: a learner-facing roadmap, explicit Part 2 starting-state check, final closure, consistent
  `.tmp/events` paths, and glossary terms that refer to the migrated lesson files.

- [ ] **Step 1: Write failing real-curriculum contract tests.**

  Extend `workbook-contract.test.ts` to load the real workbook and assert that lesson 005 begins with
  `part-2-entry-checkpoint` of type `reflection`, lesson 013 ends with `capstone-closure` of type
  `lesson-transition`, and the learner-visible Markdown from all real blocks contains no stale
  `factory/refactor/events` or `"$line"/events` path.

- [ ] **Step 2: Run the focused test and verify that it fails.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-contract.test.ts
  ```

  Expected: FAIL because the checkpoint and capstone blocks are not listed and stale event paths remain.

- [ ] **Step 3: Add the framing and checkpoint content.**

  Expand the workbook and two part documents with concise route maps. Add a reflection block named
  `part-2-entry-checkpoint` before the lesson 005 key concept. Its learner text must ask the learner to
  verify either their Part 1 files or the seeded Part 2 start; its private tutor text must accept either
  state and name the required `factory/` artefacts. Add a `capstone-closure` lesson-transition block after
  lesson 013’s pressure test that summarises the factory, record, operator role, and one next experiment.

- [ ] **Step 4: Correct shared curriculum contracts.**

  Use `factory/refactor/.tmp/events/` in root-level examples and `"$line"/.tmp/events/` inside
  `factory/ask.sh` and `factory/watch.sh`. Change lesson 005’s first factory definition to the canonical
  form: software containing one or more assembly lines and their orchestrator(s), the unit built, deployed,
  and operated. Update the glossary links to `lessons/`, add **record** introduced in lesson 009 and
  **operator** introduced in lesson 013, and make the factory definition match the canonical wording.

- [ ] **Step 5: Run the focused test and verify that it passes.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-contract.test.ts
  ```

  Expected: PASS.

- [ ] **Step 6: Commit the curriculum changes.**

  ```sh
  git add workbook.md lessons docs/GLOSSARY.md tutorial-engine/test/workbook-contract.test.ts
  git commit -m "docs: complete workbook curriculum framing"
  ```

### Task 2: Render global lesson numbers and part roadmaps once

**Files:**
- Modify: `tutorial-engine/src/workbook/load.ts`
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx`
- Modify: `tutorial-engine/test/workbook-contract.test.ts`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Interfaces:**
- Consumes: numerically ordered part and lesson directories.
- Produces: `WorkbookChapter.lessonNumber` as a one-based global position and visible `Lesson N` labels in
  the rail and lesson header; a part introduction appears before only its first lesson.

- [ ] **Step 1: Write failing loader and UI tests.**

  In `workbook-contract.test.ts`, make the two-part synthetic fixture assert lesson numbers `[1, 2]` in
  directory order. In `workbook-ui.test.tsx`, create two `Chapter` fixtures from separate parts and assert
  that the rail includes `Lesson 1` and `Lesson 2`, the lesson header includes `Lesson 1`, and rendering the
  application-level emerged chapters produces each part roadmap once rather than once per lesson.

- [ ] **Step 2: Run the focused tests and verify that they fail.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-contract.test.ts workbook-ui.test.tsx
  ```

  Expected: FAIL because numbering resets in each part, labels are absent, and part content repeats.

- [ ] **Step 3: Implement the smallest loader and UI changes.**

  In `loadWorkbook()`, flatten the ordered part lesson groups and assign `lessonNumber` with the flattened
  index plus one. In `LessonRail`, prefix visible lesson titles with `Lesson {chapter.lessonNumber}:`.
  In `LessonView`, add a visible eyebrow such as `Lesson {chapter.lessonNumber}` above the H1. In `App`, use
  the emerged-chapter array index to render `PartChapter` only when that chapter’s `part` differs from the
  previous emerged chapter’s part.

- [ ] **Step 4: Run the focused tests and verify that they pass.**

  Run:

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-contract.test.ts workbook-ui.test.tsx
  ```

  Expected: PASS.

- [ ] **Step 5: Commit the workbook presentation changes.**

  ```sh
  git add tutorial-engine/src/workbook/load.ts tutorial-engine/web-workbook/src/workbook-ui.tsx \
    tutorial-engine/test/workbook-contract.test.ts tutorial-engine/test/workbook-ui.test.tsx
  git commit -m "feat: show global workbook lesson numbers"
  ```

### Task 3: Verify the integrated workbook

**Files:**
- Modify only if focused verification exposes a defect in Tasks 1–2.

**Interfaces:**
- Consumes: the migrated curriculum manifests and global lesson presentation.
- Produces: a type-checked, built, and fully tested workbook.

- [ ] **Step 1: Run the full tutorial-engine suite.**

  ```sh
  npm run --workspace=tutorial-engine check
  ```

  Expected: PASS.

- [ ] **Step 2: Run the repository check.**

  ```sh
  npm run check
  ```

  Expected: PASS.

- [ ] **Step 3: Build the workbook production bundle.**

  ```sh
  npm run --workspace=tutorial-engine build:web:workbook
  ```

  Expected: exit 0.
