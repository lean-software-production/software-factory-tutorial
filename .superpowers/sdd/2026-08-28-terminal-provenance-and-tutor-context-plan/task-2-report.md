# Task 2 report — Give Main Tutor chat a private active terminal context

## Summary

Implemented private, bounded active terminal context for ordinary Main Tutor chat. The context is available only for the active `terminal-practice` block and contains labelled terminal input/output transcript, latest command state, and finished command evidence after completion. Public workbook state and public timeline projections remain unchanged and do not expose command text, terminal output, attempt IDs, or evidence references. Automatic terminal review continues to use the existing immutable finished-attempt path and does not receive the live active terminal context.

## TDD evidence

### ADR creation

- Ran required ADR creation command after starting the devcontainer:
  - First `devcontainer exec --workspace-folder . bash -lc 'cd tutorial-engine && adrgen create "Keep Live Terminal Context Private"'` failed because no dev container was running: `Error: Dev container not found.`
  - Ran `devcontainer up --workspace-folder .` to create/start it; the first invocation timed out while installing/downloading dependencies, but the container became usable.
  - Re-ran `devcontainer exec --workspace-folder . bash -lc 'cd tutorial-engine && adrgen create "Keep Live Terminal Context Private"'` successfully: `0019-keep-live-terminal-context-private.md created`.
  - Ran `devcontainer exec --workspace-folder . bash -lc 'cd tutorial-engine && adrgen status 19 accepted'` successfully.
  - Ran `devcontainer exec --workspace-folder . bash -lc 'cd tutorial-engine && adrgen list'`; ADR 19 is listed as `accepted`.

### RED

After writing tests first, ran:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && npm --prefix tutorial-engine test -- workbook-server.test.ts workbook-tutor.test.ts
```

Meaningful failures:

- `gives ordinary Main Tutor chat private active terminal context for a running command only`: `replyContext.terminal` was `undefined`.
- `gives ordinary Main Tutor chat private active terminal context for a finished command with evidence`: `replyContext.terminal` was `undefined`.
- `includes author-guidance nondisclosure and active terminal context boundaries in ordinary reply instructions`: system prompt did not mention labelled terminal transcript / command-claim boundary.

One earlier attempted RED command used an invalid Vitest option (`--runInBand`) and failed with `Unknown option --runInBand`; this was not counted as the product RED signal.

### GREEN / focused

After minimal implementation, ran:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && npm --prefix tutorial-engine test -- workbook-terminal.test.ts workbook-server.test.ts workbook-tutor.test.ts
```

Result:

- `Test Files 3 passed (3)`
- `Tests 44 passed (44)`

### Full check

Ran from `tutorial-engine`:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && cd tutorial-engine && npm run check
```

Result:

- ESLint passed.
- `tsc --noEmit` passed.
- `tsc -p tsconfig.check.json` passed.
- Full Vitest suite passed: `Test Files 36 passed (36)`, `Tests 312 passed (312)`.
- `vite build` passed.
- Browser smoke passed: `Browser smoke passed: rendered the v2 workbook UI and observed /api/workbook/complete-block.`

No `justfile`/`Justfile` was present under the worktree, so no `just` target was run.

## Implementation details

- `WorkbookTerminalManager` now records a private bounded active transcript in memory. It appends accepted input from `receive({ type: "input" })` and marker-stripped terminal output from the shell protocol path. It exposes `activeTranscriptContext()` only when the current workflow-reported active terminal block matches the stored transcript block.
- `WorkbookWorkflowDependencies` accepts an optional `activeTerminalContext` provider. `server.ts` wires this to the embedded terminal manager without adding any browser/public contract fields.
- `ActiveBlockContext` now has an optional private `terminal` member containing transcript and latest command state. Workflow builds it only for the active `terminal-practice` block and validates the terminal manager's lesson/block before adding it.
- Finished command context reads immutable evidence from `TerminalEvidenceRepository` and includes it privately for ordinary chat.
- Automatic terminal review explicitly calls `mainContext({ includeTerminalContext: false })`, preserving the existing dedicated immutable attempt/evidence path.
- Main Tutor prompts now say that labelled terminal transcript/evidence may be used as learner evidence and must not be described as commands the tutor ran itself.

## Files changed

- `docs/plans/2026-08-28-terminal-provenance-and-tutor-context-plan.md` — included required plan document in commit.
- `tutorial-engine/docs/adr/0019-keep-live-terminal-context-private.md` — new accepted ADR.
- `tutorial-engine/docs/adr/README.md` — indexed ADR 0019.
- `tutorial-engine/src/workbook/terminal.ts` — private bounded active transcript capture and accessor.
- `tutorial-engine/src/workbook/workflow.ts` — private active terminal context projection for ordinary chat; review path excludes live terminal context.
- `tutorial-engine/src/workbook/pi-history.ts` — private active terminal context types on `ActiveBlockContext`.
- `tutorial-engine/src/workbook/server.ts` — terminal manager context provider wired into workflow.
- `tutorial-engine/src/workbook/tutor.ts` — Main Tutor instruction boundary for labelled terminal context.
- `tutorial-engine/test/workbook-server.test.ts` — running/finished ordinary-chat context tests; public state/timeline non-leak assertions; automatic review path assertion.
- `tutorial-engine/test/workbook-terminal.test.ts` — private transcript scoping test.
- `tutorial-engine/test/workbook-tutor.test.ts` — instruction boundary expectations.

## Self-review

- Confirmed private context is not added to public contract types, public state projection, public timeline projection, terminal SSE, or browser code.
- Confirmed normal learner chat sees active terminal context for both running and finished commands.
- Confirmed finished evidence remains immutable and automatic terminal review still receives the existing transient attempt built from durable finished evidence, not live active terminal context.
- Confirmed transcript context is scoped to the active terminal block and unavailable for another active block.
- Confirmed no Task 1 provenance behavior was changed beyond integrating transcript capture in `terminal.ts`.

## Fix round 1 — ordering and ordinary-chat evidence consistency

### Summary

Addressed both Medium review findings:

- `WorkbookTerminalManager.receive()` now records accepted input in the private active transcript and active observation before calling `TerminalPty.write()`, preserving causal input-before-output order even when a PTY emits output synchronously from `write()`.
- Ordinary Main Tutor active terminal context now treats a latest submitted command as finished only when the matching finished lifecycle row has readable immutable evidence whose command and exit status match the submitted command and recorded finished status. Missing or inconsistent evidence falls back to running command context and does not pass `evidenceRef`, `exitStatus`, or `finishedEvidence` to ordinary chat.

The deferred low race around async lifecycle fact persistence remains out of scope and unchanged.

### RED

After adding focused regression tests first, ran:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && npm --prefix tutorial-engine test -- workbook-terminal.test.ts workbook-server.test.ts
```

Result: `Test Files 2 failed (2)`, `Tests 2 failed | 35 passed (37)`.

Meaningful failures:

- `WorkbookTerminalManager > records accepted input before synchronous PTY output caused by that input`: transcript ordering was wrong (`expected 41 to be less than 0`), proving synchronous PTY output could precede accepted input.
- `workbook browser API > treats the latest ordinary-chat terminal command as running when finished evidence is missing or inconsistent`: ordinary-chat context reported the missing-evidence command as `status: "finished"` instead of `"running"`.

### GREEN / focused

Ran:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && npm --prefix tutorial-engine test -- workbook-terminal.test.ts workbook-server.test.ts
```

Result: `Test Files 2 passed (2)`, `Tests 37 passed (37)`.

Ran the broader Task 2 focused set:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && npm --prefix tutorial-engine test -- workbook-terminal.test.ts workbook-server.test.ts workbook-tutor.test.ts
```

Result: `Test Files 3 passed (3)`, `Tests 46 passed (46)`.

### Full check

Ran from `tutorial-engine`:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && cd tutorial-engine && npm run check
```

Result:

- ESLint passed.
- `tsc --noEmit` passed.
- `tsc -p tsconfig.check.json` passed.
- Full Vitest suite passed: `Test Files 36 passed (36)`, `Tests 314 passed (314)`.
- `vite build` passed.
- Browser smoke passed: `Browser smoke passed: rendered the v2 workbook UI and observed /api/workbook/complete-block.`

Checked for a worktree `justfile`/`Justfile` with:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && find .. -maxdepth 2 \( -name justfile -o -name Justfile \) -print
```

No justfile was present, so no `just` target was run.

### Files changed in fix round 1

- `tutorial-engine/src/workbook/terminal.ts` — moved private transcript append and interactive-input observation before PTY write.
- `tutorial-engine/src/workbook/workflow.ts` — validated finished evidence existence, command, and exit status before projecting finished private context to ordinary chat.
- `tutorial-engine/test/workbook-terminal.test.ts` — added synchronous-output regression covering private transcript and immutable evidence interaction ordering.
- `tutorial-engine/test/workbook-server.test.ts` — added ordinary-chat regression for missing and inconsistent private terminal evidence.

### Concerns

None beyond the previously recorded deferred low race around chat before async lifecycle facts persist.

## Fix round 2 — active terminal session scoping for ordinary chat

### Summary

Addressed the final-review Medium finding: ordinary Main Tutor active terminal context no longer treats an unfinished `terminal-command-submitted` record from a previous workflow/terminal session as the current running command when a fresh terminal session later provides transcript output. Finished commands remain eligible through durable finished evidence.

### RED

After adding the regression test first, ran:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && npm --prefix tutorial-engine test -- workbook-server.test.ts
```

Result: `Test Files 1 failed (1)`, `Tests 1 failed | 30 passed (31)`.

Meaningful failure:

- `does not treat an unfinished command from an old terminal session as running in ordinary chat`: `replyContext.terminal.latestCommand` contained the stale old-session command with `status: "running"` instead of being omitted.

### GREEN / focused

Ran:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && npm --prefix tutorial-engine test -- workbook-server.test.ts
```

Result: `Test Files 1 passed (1)`, `Tests 31 passed (31)`.

### Full check

Ran from `tutorial-engine`:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && cd tutorial-engine && npm run check
```

Result:

- ESLint passed.
- `tsc --noEmit` passed.
- `tsc -p tsconfig.check.json` passed.
- Full Vitest suite passed: `Test Files 36 passed (36)`, `Tests 315 passed (315)`.
- `vite build` passed.
- Browser smoke passed: `Browser smoke passed: rendered the v2 workbook UI and observed /api/workbook/complete-block.`

Checked for a worktree `justfile`/`Justfile` with:

```sh
cd /Users/matt/git/lean-software-production/software-factory-tutorial/.worktrees/tutorial-engine-terminal-context && find .. -maxdepth 2 \( -name justfile -o -name Justfile \) -print
```

No justfile was present, so no `just` target was run.

### Files changed in fix round 2

- `tutorial-engine/src/workbook/workflow.ts` — active terminal private context now only considers submitted commands from the current terminal session unless the attempt has a finished lifecycle record, preserving durable finished-evidence projection while ignoring stale unfinished submissions.
- `tutorial-engine/test/workbook-server.test.ts` — added restart/new-session regression proving old unfinished commands are not exposed to ordinary chat as running commands.
