# Task 4 report — final integration coverage and verification

## Commit

- `tutorial-engine: add final v2 workbook coverage`

The only intended code/test change is:

- `tutorial-engine/test/workbook-contract.test.ts`

## Coverage audit

Existing coverage already protected these v2 behaviours:

- Private tutor data stays out of public workbook state:
  `tutorial-engine/test/workbook-server.test.ts` asserts terminal and reflection tutor strings are
  passed to adapters but do not appear in JSON state.
- Embedded terminal is the normal server path:
  `tutorial-engine/test/workbook-server.test.ts` covers the default server path with embedded
  terminal enabled, and rejects non-loopback startup.
- Embedded terminal is the only UI path:
  `tutorial-engine/test/workbook-ui.test.tsx` rejects the old external-terminal fallback copy and
  verifies command insertion only for authored shell fences.
- Ordered all-block progression:
  `tutorial-engine/test/workbook-events.test.ts` sequences every listed block, including narrative,
  terminal practice, reflection, and transition blocks.
- No-task Continue and scroll handling:
  `tutorial-engine/test/workbook-server.test.ts` covers server-side `continue` on active narrative
  and transition blocks. `tutorial-engine/web-workbook/src/workbook-ui.tsx` sends the same
  `continue` action from both the button and the scroll sentinel, and UI tests assert the sentinel
  is only present for active no-task blocks.
- Multi-lesson UI isolation:
  `tutorial-engine/test/workbook-ui.test.tsx` covers duplicate block IDs across completed and active
  lessons, including narrative continuation controls and frozen terminal rendering.
- New Markdown manifest fixtures:
  workbook server and contract tests now author `workbook.md`, `part.md`, `lesson.md`, and block
  Markdown files directly. The workbook/server/UI tests no longer assume `hero.md`, `opening.md`,
  `lesson.yaml`, `required`, or authored terminal modes.

Gap found and fixed:

- The real workbook loaded during a learner session was not directly protected as a 13-lesson rail.
  I added a focused regression test that loads the repository root and asserts the title, exact
  ordered lesson IDs, and that every chapter has a migrated `lesson` object.

Browser smoke audit:

- `tutorial-engine/test/browser-smoke.mts` exercises the older shared browser SSE choice UI under
  `dist/web`, not the workbook Markdown manifest UI under `dist/web-workbook`. It has no stale
  workbook contract assumptions, so I did not change it.

## Focused test added

Command:

```sh
cd tutorial-engine && npm run test -- workbook-contract.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests  28 passed (28)
```

## Required verification

Command:

```sh
cd tutorial-engine && npm run check
```

Result:

```text
Test Files  23 passed (23)
Tests  172 passed (172)
```

Command:

```sh
cd tutorial-engine && npm run build
```

Result: passed. `build:server`, `build:web`, and `build:web:workbook` all completed. Vite emitted
its existing large-chunk warnings for both browser bundles.

Command:

```sh
cd tutorial-engine && npm run browser:smoke
```

Result: failed because optional browser tooling is absent:

```text
Browser smoke is optional. Install its prerequisite with `npm install --no-save -D playwright`, then `npx playwright install chromium`.
npm error Lifecycle script `browser:smoke` failed with error:
npm error code 1
npm error path /Users/matt/git/lean-software-production/software-factory-tutorial/tutorial-engine
npm error workspace @lean-software-production/tutorial-engine@0.1.0
npm error location /Users/matt/git/lean-software-production/software-factory-tutorial/tutorial-engine
npm error command failed
npm error command sh -c tsx test/browser-smoke.mts
```

Command:

```sh
npm run check
```

Result: failed at the known unrelated eval harness type error before reaching tutorial-engine or
calculator workspace checks:

```text
evals/harness/session.ts(264,37): error TS2345: Argument of type '{ lesson: LessonDefinition; workspace: string; webRoot: string; progress: ProgressItem[]; }' is not assignable to parameter of type 'LocalServerOptions'.
  Property 'resetLearnerArtifacts' is missing in type '{ lesson: LessonDefinition; workspace: string; webRoot: string; progress: ProgressItem[]; }' but required in type 'LocalServerOptions'.
```

Command:

```sh
git diff --check
```

Result: passed with no output.

Markdown prose line audit:

- Checked added Markdown lines in the current diff, ignoring fenced blocks.
- No added Markdown prose line exceeded 100 columns before this report was written.
- This report is manually wrapped below 100 columns outside fenced command/output blocks.

## Concerns

- `npm run browser:smoke` cannot provide browser coverage in this checkout until Playwright and its
  Chromium browser are installed.
- Root `npm run check` is still blocked by the unrelated eval harness type error at
  `evals/harness/session.ts:264`.
- `.superpowers/sdd/2026-08-20-v2-tutor-markdown-manifests-plan/task-3-report.md` was already
  modified when Task 4 began. I left it unstaged and unchanged.
