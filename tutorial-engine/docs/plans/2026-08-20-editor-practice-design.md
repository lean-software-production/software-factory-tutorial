# Live editor practice design

## Purpose

Add an `editor-practice` workbook block. It gives a learner an embedded editor for one declared
workspace file and gives a bounded reviewer agent a chance to guide the learner while they type.
When the current draft satisfies the block's private criteria, the reviewer calls a server-owned tool
to unlock the block. The server, not the agent, promotes the approved draft to the workspace file
and advances the ordered lesson.

The first migration applies this capability only to Lesson 002, “Build a doer.” Later lessons retain
their current block types until their own migration work.

## Learner experience

An editor-practice block renders its usual learner-facing Markdown and an embedded CodeMirror editor.
The editor opens the declared file's existing contents, or a blank draft when the file does not yet
exist. There is no Save or Review button.

After a short pause in typing, the browser sends the latest numbered draft revision to the workbook
server. The block shows a compact live status: editing, reviewing, focused feedback, or unlocked.
The learner can keep typing while a review is in flight. An unlock reveals the next ordered block.

The editor component is independent of the review and progression machinery. A later
guided-template mode can constrain edits to authored placeholders, support tabbing between them, and
highlight editable ranges without changing reviewer tools, persistence, or the event model.

## Authored contract

`editor-practice` joins `narrative`, `terminal-practice`, `reflection`, and `lesson-transition` as a
strictly validated block type. Its front matter has these fields:

```yaml
type: editor-practice
path: factory/refactor.md
tutor: |-
  Private review criteria, acceptable variations, focused hints, and the teaching reason.
```

The Markdown body remains the learner-facing instruction, explanation, and any illustrative code.
The private `tutor` prompt tells the reviewer exactly what to assess. It must name concrete
acceptance criteria and acceptable variations rather than request a general code review.

`path` is a workspace-relative file path. It must name one ordinary file and may not be absolute,
contain traversal, or refer to `.git`, `.tutorial`, `.tmp`, or a path outside the workspace. A block
may expose and edit only its own declared path.

## Drafts, review, and promotion

The server owns editor drafts in `.tutorial/.tmp/workbook/drafts/`. A draft is separate from the
workspace target while it is being written and reviewed. A refreshed or resumed page restores the
latest draft for the active block.

Each submitted draft has a monotonic revision identifier. The server queues at most the latest
pending revision for an active editor-practice block. It does not start a reviewer turn for every
keystroke. A new revision supersedes an older queued review.

A reviewer turn receives only the active block's private prompt and the identified draft. The draft
is untrusted input. The reviewer has one progression capability:

```text
unlock_editor_practice(revisionId)
```

The server accepts that call only when the block is still active, the revision is still current, and
the reviewer session belongs to that block. It then writes the approved draft to the block's declared
workspace path and appends an `editor_practice_unlocked` event. A review that arrives after further
typing is stale and cannot advance the block or write a file.

When the reviewer finds a problem, it returns concise, criterion-specific inline guidance. It does
not unlock the block. It may not inspect arbitrary workspace files, call shell commands, or choose a
later block.

## Failure handling

A failed, malformed, or unavailable reviewer call leaves the current draft and block intact. The UI
reports that review is temporarily unavailable. The server retries the latest revision with bounded
backoff; a new draft replaces a queued retry.

Invalid tool calls, stale revisions, and attempts to escape the declared path are rejected, recorded
as diagnostic events, and cannot affect workspace files or ordered progression.

## Lesson 002 migration

Replace the single combined `implementation-order` terminal-practice block with four focused blocks:

1. An editor-practice block for `factory/refactor.md`, which states the doer's one focused,
   behaviour-preserving refactoring job and its no-shell boundary.
2. An editor-practice block for `factory/refactor-do.sh`, which creates the baseline, announces each
   harness phase, and invokes Pi from `calculator/` with edit tools but no `bash`.
3. A terminal-practice block that makes the script executable and performs one doer turn.
4. A terminal-practice block that inspects the diff, runs tests, and runs the quality command outside
   the doer.

The existing key concept, alternatives, reflection, and lesson transition remain. The split makes the
prompt, harness, run, and independent check distinct learner checkpoints.

## Implementation boundaries

The change introduces the type through the workbook contract and loader, event projection, workbook
server, reviewer adapter and tool boundary, embedded-editor UI, and styles. The server keeps the
reviewer and draft state private; the public workbook state exposes only the block, current status,
and feedback needed by the UI.

CodeMirror is the first-pass editor. It is lighter than Monaco for this focused Markdown and shell
editing use, while providing the state and extension points needed for the later guided-template
mode.

## Verification

Deterministic tests cover:

- manifest validation for editor-practice and its required fields;
- declared-path containment and protected-path rejection;
- draft persistence and restore;
- latest-revision queueing and stale-unlock rejection;
- reviewer feedback, valid unlock, and promotion to the target workspace file;
- event replay and ordered progression; and
- browser editing, live status, inline feedback, and automatic unlock.

The live evaluator gains an isolated editor-practice fixture block and scenarios that use a real tutor
model and judge model. One scenario must show useful feedback for an insufficient draft that remains
locked. Another must show that a satisfactory draft unlocks the block and promotes the approved file.
Stale approvals and path-boundary rules stay deterministic tests because they do not require a model.

## Out of scope

This first pass does not migrate later lessons, embed a terminal redesign, add general code review,
or implement guided-template placeholders. It provides the reusable editor-practice path those later
features will use.
