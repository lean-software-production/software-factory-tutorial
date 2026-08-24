# 9. Separate authored content from session-local learner state

Date: 2026-08-24

## Status

accepted

## Context

The tutorial now has immutable authored material under `tutorial/`: workbook prose, lesson manifests,
specifications, docs, seeds, and the starter `calculator/` and `factory/` trees. A learner session must
let the tutor and the learner write freely, reset, branch, and commit without turning those writes into
changes to the authored curriculum.

The existing engine still treats the served tutorial directory as both content source and learner
workspace. That makes session state hard to discard, makes reopening a particular run ambiguous, and
lets generated tutor state or learner edits sit beside documents that are meant to be reviewed and
versioned as curriculum.

## Decision

Separate the two roots explicitly. The content root remains the authored tutorial tree. Session-local
state lives under `.tutorial/<session-id>/` inside that content root, and the learner writes only inside
that session's `workspace/` subdirectory. Session IDs are opaque safe names, not paths; reopening uses
an explicit existing ID, and unsafe or missing IDs are rejected.

When a session workspace is created, materialize only the mutable starter trees that the learner works
on: `calculator/` and `factory/`. Do not copy authored workbook, docs, lessons, specs, seeds, or any
`node_modules/`. Initialize the workspace itself as a local Git repository with a clean baseline commit,
so learner diffs and lesson commits are isolated from both the engine checkout and other sessions.

## Consequences

Authored content can be updated, reviewed, and shipped independently from learner progress. A session
can be thrown away by deleting its `.tutorial/<session-id>/` directory, and two sessions can diverge
without sharing edits or Git history.

Server startup and CLI parsing now need to choose between creating a new session by default and
reopening an explicit session ID before they load lesson state. Engine code that needs curriculum paths
must use the content root; code that runs learner commands or exposes file tools must use the session
workspace root. Future materialization changes should be deliberate, because adding authored trees to
the workspace weakens this boundary.
