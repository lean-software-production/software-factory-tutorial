# 25. Use one Main Tutor for practice review

Date: 2026-08-29

## Status

accepted

Supersedes [11. Use a terminal Practice Coach with Main Tutor authority](0011-use-a-terminal-practice-coach-with-main-tutor-authority.md), [19. Keep Live Terminal Context Private](0019-keep-live-terminal-context-private.md), [21. Preflight model-backed roles before workbook startup](0021-preflight-model-backed-roles-before-workbook-startup.md), and [22. Use one-shot terminal workflow assessment](0022-use-one-shot-terminal-workflow-assessment.md).

## Context

The workbook has converged on one learner-facing tutor, but the accepted terminal-review ADRs still
split model-backed work between the Main Tutor and a terminal Practice Coach. That split conflicts
with editor practice, ordinary chat, and the desired architecture for terminal practice: one tutor
session should carry the relevant teaching context and remain the only model-backed role that can
coach, review, or accept practice work.

ADRs 0018 through 0020 established constraints that still hold. Bash, not the browser, remains the
authority for terminal lifecycle. Completed command evidence is immutable. Provider failures must not
strand the learner in Checking or leak private terminal material. ADR 0022 removed the retry storm by
using one terminal workflow assessment, but it still depended on a separate Practice Coach. ADR 0021
then preflighted that separate role, which adds startup cost and diagnostics for a role this Yak is
removing.

The architecture gate must also preserve EventStorming terminology from ADR 0015. Model requests are
external effects. Domain events record facts about command completion, feedback, acceptance, and
review recovery. Browser, tutor, timeline, and log projections are separate audiences with separate
privacy rights.

## Decision

Use the Main Tutor as the only model-backed tutoring and practice-review role. Editor-practice,
terminal-practice, reflection review, restoration, summaries, and ordinary learner chat all use the
Main Tutor role. There is no model-backed Practice Coach, no terminal handoff role, and no startup
preflight for `PRACTICE_COACH_MODEL`. The ordinary workbook launch preflights only the Main Tutor
model resolved through `TUTOR_MODEL`.

When Bash records `terminal-command-finished`, the terminal workflow sends the immutable completed
command evidence directly to the Main Tutor for review. The prompt may add bounded private transcript
context for the active terminal-practice block and may give the tutor only active-workspace-scoped
read-only tools:

- `list_files`
- `read_file`

Those tools may read only the active live workspace for the block under review. They do not broaden
acceptance authority beyond the bound attempt, and they do not let the tutor claim shell execution or
workspace observation it did not perform. Shell, write, edit, network, and nested-Pi access are
explicitly prohibited for practice review.

The Main Tutor terminal-review path preserves the Bash-authoritative public lifecycle:

```text
Idle -> Running -> Checking -> Feedback | Complete
```

Bash records submission and completion. The browser renders only the server projection. Checking means
a bounded review effect is in progress for the current finished attempt. Feedback and Complete are
durable outcomes recorded by the workflow, not browser-local guesses.

Provider failure never mutates or discards immutable command evidence. A failed, empty, timed-out, or
otherwise unusable Main Tutor review may be retried automatically only within one bounded total call
budget for that review request. The budget covers the initial call and all automatic retry calls. When
that budget is exhausted, the workflow records durable generic feedback and exposes a review-only
retry action. That action retries review of the same preserved evidence; it does not rerun the shell
command, edit files, or create different command evidence. A later command submission, block change,
content generation change, or newer review retry supersedes older review requests, and stale results
cannot overwrite newer feedback or acceptance.

The EventStorming slice for a completed terminal command is:

1. **Event:** `terminal-command-finished` records the Bash-finished attempt, exit status, and private
   evidence reference.
2. **Policy:** the terminal review policy starts a bounded Main Tutor review effect for the current
   attempt and evidence reference.
3. **Events:** successful review records either `terminal-feedback-recorded` or `attempt_accepted`
   followed by the existing acceptance/progression events. Exhausted automatic review failure records
   generic `terminal-feedback-recorded` and a private review-retry entitlement.
4. **Command:** the learner's review-only retry requests a new bounded Main Tutor review effect for
   the same evidence reference, unless a newer attempt or block state has superseded it.

Legacy event compatibility remains required. Existing rows such as `observation_acknowledged`,
`observation_verified`, `block_continued`, `terminal-feedback-recorded`,
`terminal-coach-handoff-recorded`, and `attempt_accepted` must still be read for old sessions and
projections. New runtime behaviour must not create Practice Coach handoffs, but old private handoff
rows remain private compatibility data and cannot become public tutor context, public workbook state,
or acceptance authority by themselves.

Privacy boundaries from ADRs 0018 through 0020 are retained and tightened. Public state, SSE timeline
records, browser-safe serializations, diagnostics, and log projections must not expose private
transcript, command text, immutable evidence, file content, private rubrics, paths, tool results,
failure detail, retry budget state, or legacy handoff content. Learner-visible failure copy remains
generic. Private review context
may be used only inside the Main Tutor review request and the minimum private state needed to reject
stale results and permit review-only retry.

Do not introduce a faster terminal-review model in this task. A separate or faster model for terminal
review remains deferred until Task 7 measures Main Tutor terminal-review latency and establishes a
need.

## Consequences

There is one model-backed tutor to configure, preflight, observe, and explain. Terminal and editor
practice use the same review authority, which removes Practice Coach handoffs and the second model
role while preserving Bash-owned terminal state.

Terminal review may be slower because the Main Tutor receives the completed evidence directly. That
latency is an explicit trade-off to be measured before adding another model. If provider calls fail,
the learner gets durable feedback and can retry review without losing command evidence or rerunning
the command.

Runtime work that follows this ADR must change prompts, tool wiring, retry bookkeeping, stale-result
guards, projections, and compatibility tests together. This ADR records the architecture only and does
not change runtime behaviour.
