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
