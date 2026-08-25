# Canonical Lesson References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let workbook authors reference an earlier lesson by its canonical directory ID and render a
validated Markdown link with that lesson’s current global number and title.

**Architecture:** A pure workbook module owns reference scanning, target validation, and the shared DOM anchor
algorithm. `loadWorkbook()` resolves authored tokens only after it has discovered and globally numbered every
chapter; ReactMarkdown receives ordinary Markdown links. The UI imports the same anchor helper, so resolved
hrefs and rendered targets cannot drift.

**Tech Stack:** TypeScript, React 19, ReactMarkdown, Vitest.

**Spec:** Approved design in this session: `[[lesson:<part-directory>/<lesson-directory>]]`, canonical IDs,
loader-time resolution, and earlier-lesson-only links.

## Global Constraints

- Support only the exact initial syntax `[[lesson:<part-directory>/<lesson-directory>]]`.
- Do not add a new block type, client-side Markdown plugin, or dependency.
- Resolve references before learner Markdown reaches ReactMarkdown.
- Render labels as `Lesson N: Title`, using the loaded global ordinal and current lesson title.
- Use the same anchor helper for loader hrefs and UI lesson IDs.
- A lesson dek or block may reference only a strictly earlier lesson.
- `workbook.md` may not contain a lesson reference; `part.md` may refer only to a lesson before that part’s
  first lesson.
- Preserve the `loadWorkbookLesson()` public behavior for standalone lesson loading.

---

### Task 1: Add validated loader-time canonical references

**Files:**
- Create: `tutorial-engine/src/workbook/lesson-links.ts`
- Modify: `tutorial-engine/src/workbook/load.ts`
- Modify: `tutorial-engine/test/workbook-contract.test.ts`

**Interfaces:**
- Produces: `lessonElementId(lessonId: string): string`, `lessonAnchorHref(lessonId: string): string`, and a
  pure reference resolver which maps a valid canonical token to standard Markdown.
- Consumes: ordered `WorkbookChapter` values with their global `lessonNumber`, title, and canonical ID.

- [ ] **Step 1: Write failing reference-resolution tests.**

  Extend the synthetic workbook fixture so a second lesson dek and block can contain
  `[[lesson:01-beta-part/01-beta-lesson]]`. Assert that `loadWorkbook()` returns exact standard Markdown:

  ```ts
  "[Lesson 1: Beta Lesson Title](#lesson-01-beta-part-01-beta-lesson)"
  ```

  Add separate rejection tests for unknown, empty, malformed, unterminated, self, and forward tokens. Assert
  that every source-location failure names its authored file and the canonical syntax. Test that `workbook.md`
  rejects every token; test that Part 1 rejects its own first lesson while Part 2 may resolve a Part 1 target.
  Finally, assert the real workbook has no unresolved `[[lesson:` token in public introduction, part Markdown,
  lesson dek, or block Markdown.

- [ ] **Step 2: Run the contract test and verify expected failures.**

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-contract.test.ts
  ```

  Expected: the new fixture cases return literal tokens or lack location-aware failures because no resolver
  exists.

- [ ] **Step 3: Implement the pure link module and resolver.**

  In `lesson-links.ts`, define the anchor sanitizer and `lessonElementId()`/`lessonAnchorHref()`. Define a
  catalog keyed by canonical chapter ID. Scan all `[[lesson:...]]` candidates, reject malformed syntax with
  the expected form, and reject unknown IDs with their source path. Resolve valid targets to escaped ordinary
  Markdown link labels. Encode the allowed-reference policy in the resolver context rather than in React UI.

- [ ] **Step 4: Resolve only from `loadWorkbook()`.**

  Keep `loadWorkbookLesson()` raw and standalone. In `loadWorkbook()`, first load and flatten all chapters,
  assign their global numbers, build the catalog, then resolve `workbook.md`, each part document, each lesson
  dek, and each block’s learner Markdown with source paths and the appropriate earlier-target policy. Validate
  the resolved blocks/lessons before returning them.

- [ ] **Step 5: Run the focused contract suite and commit.**

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-contract.test.ts
  git add tutorial-engine/src/workbook/lesson-links.ts tutorial-engine/src/workbook/load.ts \
    tutorial-engine/test/workbook-contract.test.ts
  git commit -m "feat: resolve canonical workbook lesson references"
  ```

### Task 2: Share lesson anchors with the workbook UI

**Files:**
- Modify: `tutorial-engine/web-workbook/src/workbook-ui.tsx`
- Modify: `tutorial-engine/test/workbook-ui.test.tsx`

**Interfaces:**
- Consumes: `lessonElementId()` from `lesson-links.ts` and resolved standard Markdown links from the loader.
- Produces: rendered lesson IDs exactly matching loader-created hrefs.

- [ ] **Step 1: Write a failing anchor-parity UI test.**

  Render a lesson with ID `part/lesson-one` and Markdown containing a resolved link to it. Assert the link is
  `href="#lesson-part-lesson-one"` and the corresponding `LessonView` article header uses
  `id="lesson-part-lesson-one"`. Import the expected helper rather than duplicating sanitization logic.

- [ ] **Step 2: Run the UI test and verify it fails.**

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-ui.test.tsx
  ```

  Expected: the UI does not yet export/use the shared anchor helper in the tested path.

- [ ] **Step 3: Replace local anchor generation with the shared helper.**

  Remove the duplicate local `domSafe`/`lessonElementId` implementation from `workbook-ui.tsx`, import the
  helper, and retain local block-anchor generation by composing the shared lesson anchor. Do not alter
  navigation behavior or ReactMarkdown itself.

- [ ] **Step 4: Run focused tests and commit.**

  ```sh
  npm run --workspace=tutorial-engine test -- workbook-contract.test.ts workbook-ui.test.tsx
  git add tutorial-engine/web-workbook/src/workbook-ui.tsx tutorial-engine/test/workbook-ui.test.tsx
  git commit -m "feat: share workbook lesson anchors"
  ```

### Task 3: Verify the reference contract end to end

**Files:**
- Modify only if focused verification exposes a defect in Tasks 1–2.

- [ ] **Step 1: Run the tutorial-engine check.**

  ```sh
  npm run --workspace=tutorial-engine check
  ```

- [ ] **Step 2: Run repository checks and the production workbook build.**

  ```sh
  npm run check
  npm run --workspace=tutorial-engine build:web:workbook
  ```

  Expected: all commands exit 0.
