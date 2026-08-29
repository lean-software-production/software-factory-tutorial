# 24. Isolate lesson workspaces as live repositories

Date: 2026-08-29

## Status

accepted

Supersedes [0023](0023-scope-lesson-work-to-optional-shared-session-folders.md).

## Context

ADR 0021 put lesson work under optional folders inside one shared session workspace and one shared
Git repository. That reduced path clutter for early lessons, but it was not a real boundary: the
terminal still saw siblings, editor promotion resolved through a shared root, and a lesson could
accidentally depend on files outside its intended exercise.

The workbook now has lessons that need ordinary authored templates but stronger runtime isolation.
A learner should be able to revisit, reload, or resume a lesson without losing the live workspace
history, while terminal commands for the active lesson must not be able to traverse sibling lesson
workspaces.

## Decision

Lesson front matter may declare a strict lowercase-hyphenated workspace ID, such as
`workspace: refactor-line`. It is an ID, not a path. Lessons with `editor-practice` or
`terminal-practice` blocks must declare a workspace; narrative and reflection-only lessons may omit
it. The workspace field remains private engine state and is not included in the browser-safe lesson
contract.

Authored workspace templates are tracked directories at `tutorial/workspaces/<workspace-id>/`.
Every declared template must exist, be a real directory inside the content root, contain no `.git`,
and contain no symlinks. Session creation discovers the workspace IDs declared by the workbook's
lessons and eagerly copies each template to `.tutorial/<session-id>/workspaces/<workspace-id>/`,
skipping generated cache/evidence directories consistently with the product rules. Each copy is
initialized as an independent Git repository with a clean baseline commit. There is no outer session
Git repository.

Lessons sharing a workspace ID share that one live workspace and its history. The launcher never
resets or recopies a live workspace on progression, revisit, watch reload, or session resume; resume
validates that each declared live workspace still exists and is its own Git repository.

The embedded terminal mounts only the active live workspace read-write at `/workspace`. Sibling live
workspaces are not mounted and are not reachable through `/workspace`; runtime provision overlays are
mounted read-only beneath that active workspace. A preloaded terminal is replaced when the active
workspace changes, and stale output or exit callbacks from the old PTY are ignored. Therefore
`git rev-parse --show-toplevel` inside `/workspace` resolves to the active live workspace.

Editor draft reads and accepted promotions resolve against the active live workspace only. Authored
editor paths stay workspace-relative and browser-visible, but host paths and private workspace
metadata stay out of public state.

## Consequences

Workspace materialization becomes a session-creation concern rather than a progression concern. This
preserves learner history and makes reload/resume safer, at the cost of copying all declared
workspace templates up front.

Authors must maintain `tutorial/workspaces/<id>/` templates for every interactive lesson workspace
and must not use path-like `workspace` declarations. Local direct-entry conveniences are no longer a
runtime guarantee; the supported launch path creates or reopens a session before starting the
server.
