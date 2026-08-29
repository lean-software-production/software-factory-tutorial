# 11. Use a terminal Practice Coach with Main Tutor authority

Date: 2026-08-26

## Status

superseded by [25. Use one Main Tutor for practice review](0025-use-one-main-tutor-for-practice-review.md)

Supersedes [5. Use a main tutor with on-demand block tutors](0005-use-a-main-tutor-with-on-demand-block-tutors.md)

## Context

The former on-demand block tutor could give learner-facing hints and create generic readiness
signals. That made a second tutor visible to the learner and let routine terminal observations enter
the shared conversation history.

Terminal practice benefits from fast feedback, but only the Main Tutor may decide whether work is
accepted and whether the learner may advance.

## Decision

Use an internal, terminal-only Practice Coach for the active terminal attempt and its private rubric.
It returns exactly `working`, `feedback`, `ready`, or `interesting`.

`working` and `feedback` are private terminal quick-feedback state. They do not create timeline
messages or enter Main Tutor history. `ready` and `interesting` carry a concise private handoff to
the Main Tutor, which independently reviews the immutable attempt and remains the only authority
that accepts or advances. A coach exception falls back to ordinary Main Tutor review.

Coach results are applied only when the observed attempt is still current for the active block and
content generation. Later terminal observation, block changes, reload, and close discard stale
responses. Provider calls remain outside global timeline transactions.

Remove on-demand block-tutor hints, briefings, routes, and public contract types.

## Consequences

The learner has one visible authority: the Main Tutor. Terminal feedback can remain fast without
polluting durable conversation history. The existing terminal observation generation and current
attempt identity provide the stale-response boundary; no separate state machine is introduced.
