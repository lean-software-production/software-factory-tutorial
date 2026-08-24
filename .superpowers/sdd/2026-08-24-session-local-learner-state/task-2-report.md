# Task 2 report: split workbook runtime roots

## Summary

Finished the workbook runtime split so authored content, session state, learner workspace actions, and terminal dependency mounts use separate roots supplied by the Task 1 session descriptor.

## Systematic debugging note

Focused reproduction command run first:

```text
npm run --workspace=tutorial-engine test -- workbook-block-tutor.test.ts
```

Result on the handed-off diff: passed, 10 tests. The prior focused failure was not reproducible in this worktree state. I read the focused output, `workspace-boundary.ts`, `workbook-block-tutor.test.ts`, and `workbook/block-tutor.ts`, then compared the old one-root fixture (content and learner paths identical) with the new multi-root contract (authored content root plus separate learner workspace).

Root-cause hypothesis: the interrupted overlay tried to compensate for Pi/tool absolute paths by rewriting arbitrary paths by suffix and by bypassing `WorkspaceBoundary.resolve()`. That hid the real root split: in a one-root fixture every path belonged to one boundary, but in a multi-root fixture authored paths and learner paths need an explicit root decision before the existing symlink/path-escape checks run. The suffix rewrite could also turn an outside absolute path containing `factory/` into an in-workspace path instead of rejecting it.

Smallest fix applied: replace suffix/path rewriting with an explicit overlay decision:

- relative or authored-absolute `factory/` and `calculator/` paths resolve through the learner boundary;
- other relative/authored paths resolve through the authored-content boundary;
- learner-absolute paths resolve through the learner boundary;
- all other absolute paths are rejected;
- final resolution delegates to `WorkspaceBoundary.resolve()` so symlink and escape checks remain authoritative.

## What changed

- Added a `WorkbookRuntimeDescriptor` to the workbook server options and resolve it into:
  - `contentRoot` for workbook loading and tutor prompt/session cwd;
  - `sessionRoot` for timeline and attempt state;
  - `workspaceRoot` for editor promotion, draft reads, terminal cwd, and block-tutor learner overlay;
  - `dependencyRoot` for terminal read-only root dependency mounts.
- Added session-root constructors for workbook timeline and attempt storage while preserving the legacy one-root constructor.
- Added `tutorialSessionStatePath()` for state paths that are already rooted at `.tutorial/<session-id>`.
- Extended Part 2 seeding to read seeds from authored content and write into the learner workspace.
- Updated block-tutor file tools to read authored content and learner workspace through a read-only overlay without exposing write/edit/move.
- Updated terminal Docker arguments so `/workspace` is the learner workspace mounted read-only, `factory/`, `calculator/`, and the session-local `.git` are writable overlays, and root `node_modules`, `package.json`, and `package-lock.json` are mounted read-only when available. Dependency `.git` is refused/not mounted.
- Added focused tests for session-root server state/editor writes, terminal learner cwd/local Git, read-only authored/learner block-tutor overlay rejection, and read-only dependency mounts.

## Verification

```text
npm run --workspace=tutorial-engine test -- workbook-block-tutor.test.ts
# passed, 10 tests

npm run --workspace=tutorial-engine check
# passed, 40 files / 342 tests
```

## Self-review

Reviewed the changed root wiring against Task 1's contract. Authored roots are used for loading prompts/content and are not passed as editor/terminal workspaces. Session state is under `.tutorial/<id>`. The terminal does not mount dependency/root `.git`; it mounts only the session workspace `.git` when present. The block-tutor overlay now rejects arbitrary outside absolute paths and symlinks by delegating final resolution to `WorkspaceBoundary`.

## Concerns

Task 3 still needs to expose session creation/resume on the launch CLI and documentation. Legacy pre-session mode remains available for existing tests and still writes `.tutorial/.tmp` by design until Task 3 migrates launch behavior.

## Follow-up: split-root block-tutor `find` overlay fix

### Focused issue reproduced

I first added the focused regression around the interrupted `find` edit and ran the block-tutor test file before changing the implementation. The in-progress edit was still returning the SDK/built-in `find` tool instead of the overlay-aware implementation, so the focused call failed inside the built-in tool:

```text
$ npm run --workspace=tutorial-engine test -- workbook-block-tutor.test.ts

> @lean-software-production/tutorial-engine@0.1.0 test
> vitest run --root . workbook-block-tutor.test.ts

 RUN  v4.1.10 /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/session-local-learner-state/tutorial-engine

[tutorial 2026-08-24T18:00:30.462Z] INFO Block tutor tool audit: read ok (factory/answer.md; mutation=false).
[tutorial 2026-08-24T18:00:30.464Z] INFO Block tutor tool audit: find error (factory; mutation=false).
 ❯ test/workbook-block-tutor.test.ts (10 tests | 1 failed) 47ms
     × can read authored content and learner workspace through the same read-only tool boundary 9ms

 FAIL  test/workbook-block-tutor.test.ts > FastWorkbookBlockTutor > can read authored content and learner workspace through the same read-only tool boundary
TypeError: Cannot read properties of undefined (reading 'includes')
 ❯ ../../../node_modules/@earendil-works/pi-coding-agent/src/core/tools/find.ts:253:18

 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

### Fix

Replaced the handed-off duplicate/built-in `find` wiring with one minimal overlay-aware `find` tool. It resolves `factory/` and `calculator/` through the learner boundary, authored paths through the content boundary, merges learner overlay roots into a root find, skips stale authored overlay-root contents, and continues to reject absolute/root escapes through the existing `WorkspaceBoundary.resolve()` path checks. The tool keeps the same read-only audit logging shape as the other block-tutor tools.

### Regression coverage

Extended `workbook-block-tutor.test.ts` so the split-root fixture contains an authored-only stale `factory/authored-stale.md` and a learner-only current `factory/learner-only.md`. The test now asserts:

- `find { path: "factory" }` returns `factory/learner-only.md`;
- root `find {}` also returns the learner overlay file;
- neither result returns `authored-stale.md`;
- `find` rejects an absolute outside `factory` path.

### Verification output

```text
$ npm run --workspace=tutorial-engine test -- workbook-block-tutor.test.ts

> @lean-software-production/tutorial-engine@0.1.0 test
> vitest run --root . workbook-block-tutor.test.ts

 RUN  v4.1.10 /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/session-local-learner-state/tutorial-engine

[tutorial 2026-08-24T18:01:30.208Z] INFO Block tutor tool audit: find ok (factory; mutation=false).
[tutorial 2026-08-24T18:01:30.210Z] INFO Block tutor tool audit: find ok (.; mutation=false).
[tutorial 2026-08-24T18:01:30.210Z] INFO Block tutor tool audit: find rejected (/var/folders/xp/6wywttgn3rv5_q7cq8jbm37w0000gn/T/workbook-block-outside-factory-v5P8ek/factory; mutation=false).

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

```text
$ npm run --workspace=tutorial-engine check

> @lean-software-production/tutorial-engine@0.1.0 check
> tsc --noEmit && npm run test

> @lean-software-production/tutorial-engine@0.1.0 test
> vitest run --root .

 Test Files  40 passed (40)
      Tests  342 passed (342)
```
