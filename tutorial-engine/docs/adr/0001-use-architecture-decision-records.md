# 1. Use Architecture Decision Records

Date: 2026-08-20

## Status

accepted

## Context

The tutorial engine has architecture decisions whose rationale would otherwise be scattered across
commits, pull requests, and conversations. Contributors need one durable, local record of each decision
and its consequences.

## Decision

Use Architecture Decision Records (ADRs) for durable architecture decisions about the tutorial engine.
Store them in `tutorial-engine/docs/adr/`, create and manage them with ADRgen from `tutorial-engine/`,
and retain accepted records as history. Replace a changed decision with a superseding ADR instead of
rewriting the accepted record.

## Consequences

Contributors can find the context and consequences of an engine architecture decision in one place.
Creating, accepting, superseding, and indexing ADRs adds a small documentation task to relevant work.