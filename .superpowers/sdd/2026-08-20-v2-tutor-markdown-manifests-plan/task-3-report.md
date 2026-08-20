# Task 3 report — full curriculum Markdown manifest migration

## Commit

- `b17f33e` — Migrate workbook lessons to Markdown manifests

## Files migrated

- Preserved and included the prior lesson 001 migration:
  - `lessons/01-the-validation-loop/01-run-an-agent-headlessly/lesson.md`
  - `lessons/01-the-validation-loop/01-run-an-agent-headlessly/blocks/*.md`
  - Deleted obsolete `hero.md`, `opening.md`, and `lesson.yaml`.
- Migrated lessons 002–013 to the v2 contract:
  - Each lesson directory now has `lesson.md` with `durationMinutes`, concrete `outcomes`, and an ordered `blocks` list.
  - Each lesson block now lives in `blocks/<id>.md` with `type` frontmatter, exactly one H2, and learner-facing Markdown body.
  - Removed all remaining lesson `hero.md` files.
- Migrated `workbook.md` to empty YAML frontmatter plus H1 title.
- Migrated both part manifests:
  - `lessons/01-the-validation-loop/part.md`
  - `lessons/02-build-the-factory/part.md`
- Included the existing plan file in the task commit:
  - `docs/plans/2026-08-20-v2-tutor-markdown-manifests-plan.md`

## Content preservation decisions

- Used `docs/specs/002` through `docs/specs/013` as the source of the old authored lesson prose,
  because the remaining lesson directories only contained `hero.md` titles.
- Kept each spec section as a block so no instructional prose, command, check, pressure test, or
  advanced note was discarded.
- Used `Key concept` and other explanatory sections as narrative blocks.
- Used `Implementation order` as terminal-practice blocks with private tutor guidance that names the
  intended task, expected observations, acceptable variants, clues, and the reason for the exercise.
- Used `Checks` as reflection blocks with private tutor guidance that names acceptable answer
  criteria and follow-up cues.
- Used `Pressure test` and `End of Part 1` as lesson-transition blocks.
- Preserved learner-visible commands, shell snippets, diagrams, and questions in Markdown bodies
  rather than frontmatter.
- Kept Part 1 source paths and lesson 005 `mv` commands unchanged, so `docs/seeds/part-2/` did not
  need content changes.

## Validation and tests

Before migration, focused loader/seed tests passed against the partial state:

```sh
cd tutorial-engine
npm run test -- --run test/workbook-contract.test.ts test/lesson-load.test.ts test/seed.test.ts
```

Result: 3 files passed, 41 tests passed.

After migration:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial
npx tsx -e "import { loadWorkbook } from './tutorial-engine/src/workbook/load.ts'; (async()=>{const wb=await loadWorkbook(process.cwd()); if(wb.chapters.length!==13) throw new Error('expected 13 chapters'); console.log(JSON.stringify({title: wb.identity.title, chapters: wb.chapters.length}));})()"
```

Result: loaded the real workbook with title `Software Factory Tutorial` and 13 chapters.

```sh
cd tutorial-engine
npm run test -- --run test/workbook-contract.test.ts test/lesson-load.test.ts test/seed.test.ts
```

Result: 3 files passed, 41 tests passed.

```sh
cd tutorial-engine
npm run check
```

Result: TypeScript check and all tutorial-engine tests passed: 23 files passed, 168 tests passed.

```sh
git diff --check
```

Result: no whitespace errors.

```sh
npm run check
```

Result: failed before reaching the migrated curriculum checks, at `npm run check:eval` with an
existing TypeScript compile error in `evals/harness/session.ts`: the call at line 264 does not supply
required `resetLearnerArtifacts` for `LocalServerOptions`.

## Concerns

- Full root `npm run check` is blocked by the unrelated eval harness TypeScript error above. I did not
  change TypeScript behavior because this task was scoped to content migration unless the loader
  exposed a genuine defect.
- The migrated lesson blocks preserve the spec prose and add private tutor guidance, but they have not
  been manually learner-tested in the workbook UI.
