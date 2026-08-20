# 2. Model evaluated learner work as attempts

Date: 2026-08-20

## Status

accepted

## Context

The workbook currently models editor drafts, terminal observations, and reflection conversations
separately. Each path has its own completion event and stale-work protection. A tutor decision can arrive
after a learner has supplied newer evidence, so progression needs a common way to identify exactly what
the tutor reviewed.

## Decision

Model each evaluated learner interaction as an immutable attempt. An attempt has a server-owned opaque
ID, a monotonic version within its block, a kind, and a snapshot of the learner evidence. The server
accepts an attempt only when it remains the current attempt for the active block.

An accepted attempt leaves its block at a visible success checkpoint. The learner explicitly continues
from that checkpoint. Narrative and lesson-transition blocks do not create attempts because they have no
learner evidence to evaluate.

## Consequences

Editor, terminal, and reflection evaluation share one lifecycle and stale-decision rule. The server can
add interactive block types without inventing another completion protocol. The engine must store attempt
snapshots and migrate the existing block-specific projection state to the common lifecycle.
