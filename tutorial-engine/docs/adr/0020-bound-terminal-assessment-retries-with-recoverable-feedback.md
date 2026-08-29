# 20. Bound terminal assessment retries with recoverable feedback

Date: 2026-08-29

## Status

superseded by [22. Use one-shot terminal workflow assessment](0022-use-one-shot-terminal-workflow-assessment.md)

Supersedes [18. Use Bash-authoritative terminal display states](0018-use-bash-authoritative-terminal-display-states.md).

## Context

A completed terminal command is durable once Bash records `terminal-command-finished` with its final
evidence. The browser then projects the attempt as Checking while the Practice Coach, and sometimes
the Main Tutor, review that evidence.

The workflow previously treated provider errors, empty review text, and `working` decisions as
invisible infrastructure retries. Those retries used capped backoff for each delay, but no total retry
budget. If the provider had already exhausted its own internal retries and kept returning an error such
as a usage-limit failure, the workflow scheduled another model call forever. Reopening state did not
show a learner-visible failure, so the attempt stayed in Checking with no recovery path except
submitting another command and starting another storm.

Checking is useful only while bounded work is in progress. It must not hide an infrastructure failure
that the learner can recover from by explicitly rerunning the command later.

## Decision

Keep the Bash-authoritative display states:

```text
Idle → Running → Checking → Feedback | Complete
```

A finished terminal attempt may make at most the configured bounded automatic assessment attempts. The
current policy makes no external automatic retry after a terminal assessment provider failure,
`working` decision, empty review text, or assessment timeout; the provider adapter may still perform
its own internal retries inside that single call.

When the budget is exhausted, the workflow records the existing durable terminal lifecycle event
`terminal-feedback-recorded` with a generic recoverable message telling the learner that review is
temporarily unavailable and to run the command again. That event moves the public projection from
Checking to Feedback. It also makes the assessment request no longer current, so late provider results,
state reads, content reloads, and server restart recovery cannot restart or complete the old attempt.

The learner's explicit retry remains a normal new Bash command submission. A later
`terminal-command-submitted` for the block supersedes the failed attempt and begins a new lifecycle.

## Consequences

A provider outage or quota error consumes at most one external Coach or Main Tutor call for the
finished command, then leaves a durable, browser-visible, recoverable state. Repeated reads and
restart recovery replay the failure rather than scheduling more model work.

Some transient failures that might have succeeded after another external call now ask the learner to
rerun the command. This is intentional: for terminal-practice final evidence, avoiding silent model
call storms and making recovery explicit is more important than invisible retry persistence.
