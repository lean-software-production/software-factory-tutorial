# Terminal provenance and Main Tutor context plan

## Goal

Fix terminal evidence so a piped Bash command is recorded as the complete submitted command, not
only its first simple command. Give ordinary Main Tutor chat private access to the active terminal's
rolling transcript and its latest structured command/evidence, so it can answer learner questions
about terminal output.

## Constraints

- Use TDD: each behaviour gets a test that fails before its production implementation changes.
- Preserve the current command-before-output-before-finish terminal lifecycle.
- Keep the Bash OSC marker protocol private; marker bytes must never appear in learner-visible output
  or evidence.
- Keep raw terminal content, command text, evidence references, attempt IDs, guidance, and Coach
  handoffs out of browser contracts, public state, SSE, and public timeline data.
- The Main Tutor may discuss labelled terminal content as untrusted learner evidence, but must not
  claim it ran a command or read the workspace itself.
- The live transcript is session-memory-only and may be a bounded rolling buffer; completed
  terminal evidence remains durable.
- This is a tutorial environment. Do not add secret filtering or special prompt-injection handling.
- Record the durable tutorial-engine architecture decision as an ADR with `adrgen` in the
  development container, and index it.

## Task 1: Preserve complete Bash input in terminal command evidence

Files:

- `tutorial-engine/src/workbook/terminal.ts`
- `tutorial-engine/test/terminal-shell-protocol.test.ts`
- `tutorial-engine/test/workbook-terminal.test.ts`, only if it is the appropriate existing seam

1. Write a regression test that starts a real interactive Bash with the production workbook lifecycle
   hook, runs a harmless piped command, and parses its terminal output with `TerminalShellProtocol`.
   The command must use a line continuation as the authored button does, such as:

   ```sh
   printf 'question\n' \
     | cat
   ```

2. Confirm the test fails because the current command-submitted event contains only the first
   pipeline stage.
3. Extract the production Bash `PROMPT_COMMAND` value into an exported helper if that lets the test
   use exactly the same hook as Docker.
4. Change the one-shot `DEBUG` hook to read Bash's most recent submitted history entry (`fc -ln -1`)
   rather than `$BASH_COMMAND`. Disarm `DEBUG` before running the capture so hook internals and
   pipeline children cannot emit extra command events. Retain a safe fallback only if no history entry
   exists.
5. Make the real-Bash test prove exactly one full command event, command-before-output ordering,
   finish-after-output ordering, and stripped private marker bytes. Keep existing unit coverage green.

## Task 2: Give Main Tutor chat a private active terminal context

Files:

- `tutorial-engine/src/workbook/terminal.ts`
- `tutorial-engine/src/workbook/server.ts`
- `tutorial-engine/src/workbook/workflow.ts`
- `tutorial-engine/src/workbook/pi-history.ts`
- `tutorial-engine/src/workbook/tutor.ts`
- relevant tests under `tutorial-engine/test/`

1. Before implementation, create an ADR using:

   ```sh
   devcontainer exec --workspace-folder . bash -lc 'cd tutorial-engine && adrgen <command>'
   ```

   It must state that live terminal transcript is bounded, session-memory-only private active-context
   data for ordinary Main Tutor chat, while immutable completed evidence remains the review authority.
   Update `tutorial-engine/docs/adr/README.md`.

2. Add a private, bounded terminal transcript path from `WorkbookTerminalManager` to the workflow.
   It must include accepted terminal input and terminal output and must never change a public browser
   contract.
3. Extend `ActiveBlockContext` only for an active `terminal-practice` block to contain the rolling
   transcript and the latest structured command. When a command has finished, include its private
   finished evidence and exit status. Do not expose terminal context for a different block.
4. Supply this terminal context to normal Main Tutor message handling, but preserve the existing
   dedicated immutable attempt path for automatic terminal review.
5. Adjust Main Tutor system instructions so it may use the labelled transcript/evidence when replying
   but does not claim it ran commands itself.
6. Test first that a normal learner chat turn receives active terminal transcript plus the latest
   finished structured command/evidence. Test a running command as well. Prove that public workbook
   state and public timeline serializations do not contain the private content.

## Verification

Run the focused tests from `tutorial-engine/`, then `npm run check`. If a `justfile` is present in the
repository, run the appropriate `just` target after the checks.
