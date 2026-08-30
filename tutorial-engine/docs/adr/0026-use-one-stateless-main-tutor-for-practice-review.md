# 26. Use one stateless Main Tutor for practice review

Date: 2026-08-30

## Status

accepted

Supersedes [11. Use a terminal Practice Coach with Main Tutor authority](0011-use-a-terminal-practice-coach-with-main-tutor-authority.md), [19. Keep Live Terminal Context Private](0019-keep-live-terminal-context-private.md), [21. Preflight model-backed roles before workbook startup](0021-preflight-model-backed-roles-before-workbook-startup.md), and [22. Use one-shot terminal workflow assessment](0022-use-one-shot-terminal-workflow-assessment.md).

Affirms [6. Project workbook tutor history by role and compaction scope](0006-project-workbook-tutor-history-by-role-and-compaction-scope.md).

## Context

The workbook needs one coherent model-backed authority for ordinary tutoring, editor practice,
terminal practice, reflection review, restoration, and summaries. Earlier accepted terminal ADRs
introduced a Practice Coach, private terminal handoffs, role-specific preflight, recoverable review
failure, and one-shot terminal assessment. Those decisions conflict with the settled direction: the
Main Tutor is the only model-backed tutor or reviewer.

The branch-only ADR 0025 that first recorded this direction never landed on `main`. `main` now has an
unrelated ADR 0025, so this work records the replacement as ADR 0026 and removes the branch-only ADR
0025 file.

ADR 0006 already defines how workbook history is projected for tutoring. This decision keeps that
projection exactly and changes the runtime shape of model calls around it.

## Decision

Use one Main Tutor as the sole model-backed workbook tutor and reviewer. There is no model-backed
Practice Coach, terminal handoff role, fast terminal-review model, or separate review authority.

Every Main Tutor operation is a stateless model call. For each chat, practice review, reflection
review, restoration, summary, or other tutor operation, the engine constructs a fresh restricted Pi
session from the canonical workbook event-log projection, performs that one operation, and disposes
the session. Main Tutor sessions do not survive between operations and do not carry hidden state
outside the workbook event log and the operation's bounded private context.

Preserve ADR 0006 exactly:

- authored static content appears as prior assistant speech;
- the active-block conversation is detailed;
- completed evaluated blocks in the active lesson use block summaries;
- completed lessons use lesson summaries; and
- existing summary generation and event behaviour remains unchanged.

Throughout an active editor-practice or terminal-practice block, Main Tutor may use exactly these
read-only tools, scoped to that block's active live workspace:

- `list_files`
- `read_file`

Tool path handling rejects traversal, absolute paths, and symlinks that leave the active workspace.
The engine does not need adversarial concurrent symlink-race protection. Main Tutor gets no mutation,
shell, network, extension, skill, or nested-Pi capability.

When Bash records `terminal-command-finished`, the event stores one immutable, bounded private
evidence snapshot directly in the private event log. That snapshot includes the command, exit status,
interactions/output, and a labelled bounded transcript. There is no separate evidence-reference
repository.

Every Main Tutor operation gets three total automatic provider attempts: the initial call plus two
retries. If all attempts fail, the workbook shows a clear fatal infrastructure error, stops
progression for that workbook process, and tells the learner to fix or reconnect the provider and
restart. The workflow does not show a manual review retry button, does not present review failure as
learner feedback, and does not terminate the server process because of the failed provider calls.

Fatal state is process-local infrastructure state, not learner progress. A pending review or effect is
not resumed after restart. After the learner restarts with a working provider, they try the activity
again and create fresh evidence if review is needed.

There is no legacy session compatibility for Practice Coach or old-format events. Sessions containing
those events fail clearly as unsupported. The runtime must not parse, ignore, project, or use old
handoffs.

Browser, log, and privacy boundaries still exclude private command evidence, terminal transcript,
rubric, paths, file/tool contents, provider error details, and retry internals. These values may be
used only inside the bounded private operation context that requires them.

Bash remains authoritative for terminal lifecycle. The running workbook process still rejects stale
terminal-review results so a late result cannot overwrite a newer command, block, or process-local
fatal state.

Do not add a fast terminal model route. Measured Main Tutor terminal-review latency for `n=10` was
approximately 2.9 seconds median and 6.5 seconds p95, with 0% retries. That did not justify a second
model route.

## Consequences

The workbook has one model-backed role to configure, constrain, retry, observe, and explain. Practice
review and ordinary tutoring share the same authority while remaining stateless between operations.

The event log remains the source of tutor context, and ADR 0006 remains the compaction rule. Private
command evidence is durable enough for the operation that needs it without creating another private
repository or browser-visible surface.

Provider outages become fatal infrastructure problems for the running process rather than feedback on
the learner's work. Restart does not replay pending model effects, so recovery is simple and avoids
stale review state.

Old sessions that contain Practice Coach or old-format terminal-review events no longer load. That is
an intentional migration boundary for this architecture.
