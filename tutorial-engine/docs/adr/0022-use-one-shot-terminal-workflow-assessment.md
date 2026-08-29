# 22. Use one-shot terminal workflow assessment

Date: 2026-08-29

## Status

superseded by [25. Use one Main Tutor for practice review](0025-use-one-main-tutor-for-practice-review.md)

Supersedes [20. Bound terminal assessment retries with recoverable feedback](0020-bound-terminal-assessment-retries-with-recoverable-feedback.md).

## Context

A completed terminal command enters Checking after Bash has recorded durable finished evidence. The
terminal workflow then asks the Practice Coach to inspect that evidence. If the Coach returns a ready
or interesting handoff, the Main Tutor makes the authoritative terminal review decision.

ADR 0020 bounded an older retry loop by retaining retry counters, retry maps, backoff scheduling, and
a retry limit configured to zero. ADR 0021 then added startup preflight for model-backed roles. The
preflight catches unusable Coach or Tutor role models before the workbook starts, so keeping dormant
terminal retry machinery in the runtime workflow adds complexity without improving ordinary startup
safety.

Preflight cannot prove that a later provider call will never hang or fail. Network failures, provider
outages, and quota changes can still happen after startup, so terminal Checking still needs a bounded
runtime escape hatch.

## Decision

Keep the Bash-authoritative public states:

```text
Idle → Running → Checking → Feedback | Complete
```

Each finished terminal command gets one direct workflow assessment path:

1. Practice Coach assesses the finished evidence once.
2. If the Coach returns learner feedback, the workflow records that feedback.
3. If the Coach returns a ready or interesting handoff, the Main Tutor reviews once and either records
   feedback or accepts the work.

If the Practice Coach throws, times out, returns `working`, or returns empty text, the workflow records
the generic durable `terminal-feedback-recorded` message: review is temporarily unavailable and the
learner should run the command again. The Main Tutor terminal-review path records the same generic
feedback if it throws, times out, returns `working`, or returns empty text.

The 30-second terminal assessment timeout remains. It protects the learner from a hung provider call
after startup preflight has passed. Late provider results are ignored by the same current-request and
terminal-feedback guards used by the terminal lifecycle projection, so a late success cannot overwrite
a timeout failure or a newer command.

This decision concerns only terminal workflow assessment. The ordinary Main Tutor session retry policy
for chat, editor review, reflection review, restoration, and summaries is separate and unchanged.

## Consequences

The runtime terminal assessment code no longer needs retry maps, retry counters, backoff constants, or
scheduled retry callbacks. Reads, reloads, and restart recovery replay durable terminal feedback rather
than rescheduling old failed assessments.

A transient terminal assessment failure now asks the learner to explicitly rerun the command instead
of hiding another workflow-level model call. That is acceptable because startup preflight catches the
common unusable-model case, while the retained timeout and stale-result guards keep later failures
safe and bounded.
