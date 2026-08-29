# 23. Scope lesson work to optional shared-session folders

Date: 2026-08-29

## Status

superseded by [0024](0024-isolate-lesson-workspaces-as-live-repositories.md)

## Context

Most lessons in the workbook use the same session workspace root. Some early, experiential lessons
need a small scratch project with browser editor paths like `spec.md` and `prompt.md`, but putting
those names at the session root would collide with later lessons and distract from the exercise.

The goal is a smaller default working folder for a lesson, not a security boundary. The session
still has one learner workspace and one session-local Git repository, and learners may still
navigate to sibling folders when the lesson asks them to inspect the larger workspace.

## Decision

A lesson may declare `workspace: workspaces/<lowercase-hyphenated-slug>` in `lesson.md`. The loader
validates this path strictly. The field is private engine state and is not added to the browser-safe
workbook contract.

For a scoped lesson, editor-practice `path` values remain authored and browser-visible relative
paths, such as `spec.md`, while draft reads and accepted promotions resolve beneath the lesson
workspace.
Terminal-practice shells for the active lesson start in `/workspace/workspaces/<slug>`.

New sessions create declared lesson workspace directories under the existing session workspace. If
an authored `tutorial/workspaces/<slug>/` template exists, the launcher copies it into the session
and includes its copied files in the baseline Git commit. Authored `.gitkeep` files are copied
unchanged. If the copied template contains no files, the launcher writes an empty `.gitkeep` marker
in the session destination so Git can baseline the declared workspace. If there is no template, the
declaration creates the session folder with the same empty `.gitkeep` marker. The hidden marker is
acceptable in the learner workspace because ordinary `ls` omits it. Top-level symlinked lesson
workspace templates and nested symlinks are rejected during materialization.

The embedded terminal keeps the root `/workspace` mount read-only and overlays `workspaces/` as a
writable session directory alongside existing writable roots such as `factory/`, `calculator/`, and
`.git/`. A prestarted terminal created before a scoped terminal block becomes active must not
receive learner input in the wrong working directory; the terminal manager replaces that shell
before writing input for the active scoped block.

## Consequences

Early lessons can offer small local files without teaching the whole session workspace layout first.
Existing lessons without `workspace` keep their current editor paths, terminal working directory,
and session-local Git behavior.

This is not filesystem isolation. Authors must not use lesson workspaces to hide files or enforce a
security boundary. Engine code also has to carry the private lesson workspace through loading,
materialization, editor promotion, and terminal startup without leaking it into public state.
