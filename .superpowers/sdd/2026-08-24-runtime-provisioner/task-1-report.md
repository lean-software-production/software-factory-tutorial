# Task 1 Report: Generalize runtime mounts

## Status
Completed.

Task 1 asked for runtime-provisioner types at the workbook launch boundary, generic terminal support for validated safe relative read-only mount targets, no default runtime dependencies, session materialization of declared empty mount points with Git ignores, replacement of hard-coded `node_modules`/package manifest mounts, and tests covering no-profile behavior, a safe mount profile, unsafe targets, and writable mounts.

## Implementation Summary

### Runtime provision model
- Added `tutorial-engine/src/workbook/runtime-provision.ts`.
- Defined the launch-boundary profile/declaration types:
  - `RuntimeProvisionProfile`
  - `RuntimeProvisionMountDeclaration`
  - `RuntimeProvisionInput`
- Defined trusted/runtime-internal types:
  - `SafeWorkspaceRelativePath`
  - `TrustedRuntimeMount`
  - `TrustedRuntimeProvision`
- Added `NO_RUNTIME_PROVISION` as the dependency-free default.
- Added `assertSafeWorkspaceMountTarget()` and `trustRuntimeProvision()` validation.
- Validation rejects:
  - absolute or drive-prefixed targets
  - empty, `.` or `..` segments
  - `.git` / `.git/...` targets
  - duplicate or nested/conflicting targets
  - missing/non-directory/non-absolute host sources
  - any mount declaration that is not explicitly `readonly: true`

### Session materialization
- Extended `CreateTutorialSessionOptions` with `runtimeProvision`.
- Extended `TutorialSessionPaths` with optional trusted `runtimeProvision`.
- `SessionWorkspaceManager.createSession()` now trusts runtime provision input, creates each declared workspace mount target as an empty directory, and adds the target to the learner workspace `.gitignore`.
- Mount target creation checks the real parent remains inside the workspace, rejects symlink targets, rejects file targets, and rejects non-empty existing directories.
- Reopened sessions remain unchanged unless the CLI/server launch path supplies trusted runtime provision metadata.

### CLI launch boundary
- Extended `WorkbookCliDependencies` with optional `runtimeProvision` profile injection.
- The CLI now calls `trustRuntimeProvision()` at launch and passes trusted provision into session resolution.
- New sessions are materialized with runtime mount targets; reopened sessions carry the trusted provision descriptor when supplied.

### Server runtime resolution
- Replaced `dependencyRoot` in workbook runtime descriptors/options with `runtimeProvision`.
- Server runtime resolution now uses session runtime provision, explicit server runtime provision, or `NO_RUNTIME_PROVISION`.
- Docker terminal readiness checks and terminal manager construction receive trusted runtime provision rather than a dependency root.

### Terminal/Docker behavior
- Removed the hard-coded dependency mount behavior for `node_modules`, `package.json`, and `package-lock.json`.
- Docker runs now mount no external runtime paths by default.
- Learner work roots remain selectively writable as before.
- Trusted runtime provision mounts are added as read-only bind mounts at `/workspace/<safe-target>`.
- `TerminalPtyOptions`, `DockerRunArgumentsOptions`, and `WorkbookTerminalManagerOptions` now use `runtimeProvision` instead of `dependencyRoot`.

### Public exports
- Exported runtime provision functions and types from `tutorial-engine/src/index.ts`.

## Tests/Checks

Per the handoff instruction, I did **not** rerun the full tutorial-engine test/check suite. The prior worker reported that it ran and passed the full tutorial-engine test/check.

I did run a non-test hygiene check before committing:

```sh
git diff --check
```

Result: passed with no whitespace/error output.

The changed tests add coverage for:
- dependency-free terminal behavior by default
- read-only runtime provision bind mounts for safe targets
- unsafe/writable/duplicate/conflicting provision rejection
- Docker preflight receiving provision without creating targets itself
- session materialization of empty ignored mount target directories
- rejection of targets colliding with existing materialized workspace content
- CLI launch-boundary trust/pass-through of provision
- server rejection of invalid runtime provision sources

## Files Changed

- `tutorial-engine/src/workbook/runtime-provision.ts` — new runtime provision types, trusted validation, no-provision default.
- `tutorial-engine/src/session-workspace.ts` — creates/ignores runtime mount targets during session materialization and returns provision metadata.
- `tutorial-engine/src/workbook/cli.ts` — trusts injected launch profile and passes provision to session creation/reopen flow.
- `tutorial-engine/src/workbook/server.ts` — replaces dependency-root runtime descriptor with runtime provision descriptor.
- `tutorial-engine/src/workbook/terminal.ts` — removes hard-coded dependency mounts and adds generic trusted read-only runtime mounts.
- `tutorial-engine/src/index.ts` — exports runtime provision API.
- `tutorial-engine/test/session-workspace.test.ts` — adds runtime mount target materialization/collision tests.
- `tutorial-engine/test/workbook-cli.test.ts` — adds CLI launch-boundary trust/pass-through test.
- `tutorial-engine/test/workbook-server.test.ts` — updates invalid dependency-root coverage to invalid runtime source coverage.
- `tutorial-engine/test/workbook-terminal.test.ts` — updates terminal mount tests for no-profile default, safe provision profile, and rejection cases.

## Concerns / Follow-up

- I did not rerun the full test suite, by instruction; this report relies on the prior worker's pass plus `git diff --check`.
- Runtime provision currently accepts only existing directory sources. That matches the implemented generic read-only runtime-directory mount contract; file-source mounts would require an explicit follow-up design/change.
- Reopened sessions receive runtime provision metadata from the launch path but do not recreate missing mount target directories. This is consistent with Task 1's session materialization requirement for created sessions; if profiles can change between reopen launches, a later task may need explicit reconciliation behavior.
