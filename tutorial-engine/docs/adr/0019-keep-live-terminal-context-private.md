# 19. Keep Live Terminal Context Private

Date: 2026-08-28

## Status

superseded

Superseded by [26. Use one stateless Main Tutor for practice review](0026-use-one-stateless-main-tutor-for-practice-review.md)

## Context

Terminal-practice blocks already preserve immutable completed-command evidence for automatic Practice Coach and Main Tutor review. Ordinary learner chat with the Main Tutor did not receive the active terminal state, so the tutor could not answer natural questions about a command that was running or had just finished unless that state had gone through the review path.

The browser contract must remain safe: raw terminal input, output, command text, attempt identifiers, evidence references, private guidance, and coach handoffs must not enter public workbook state, SSE timeline records, or other browser-visible workbook serializations.

## Decision

Keep live terminal transcript as bounded, session-memory-only private active-context data. For the active `terminal-practice` block only, the server may add this private active context to ordinary Main Tutor chat. It contains labelled terminal input/output transcript text and the latest structured command state. When the latest command has completed, the active context may also include its immutable finished evidence, exit status, and evidence reference.

Immutable completed evidence remains the review authority. Automatic terminal review continues to use the dedicated finished-attempt evidence path; ordinary chat terminal context is for explanation and coaching only, not acceptance authority.

The Main Tutor instructions must treat terminal transcript and evidence as labelled learner evidence. The tutor may use it when replying, but must not claim that it ran commands, read files, observed the workspace directly, or produced terminal output itself.

## Consequences

- Ordinary Main Tutor chat can answer learner questions about visible terminal activity while a command is running or after it finishes.
- Public workbook contracts stay unchanged and continue to omit raw terminal data and private lifecycle identifiers.
- The live transcript is intentionally transient and bounded; a server restart may lose it.
- Completed terminal review remains deterministic because durable finished evidence remains the source of authority for automatic assessment.
