# Unified workbook attempts and tutor session

## Purpose

Replace the workbook's separate editor reviewer, terminal observer, and reflection responder with one
long-running, restricted tutor session. Model every evaluated learner interaction as an immutable
attempt. The tutor judges one attempt at a time and can declare only that the current attempt is ready.

Accepted work remains visible as a success checkpoint. The learner, not the tutor, chooses when to
continue to the next block.

## Scope

This design changes the evaluated block types:

- `editor-practice`
- `terminal-practice`
- `reflection`

Narrative and lesson-transition blocks have no learner evidence to judge. They retain their existing
Continue behaviour.

## Attempt model

An attempt is an immutable snapshot of evidence for one active evaluated block.

```ts
type AttemptKind = "editor" | "terminal" | "reflection";
type AttemptStatus = "working" | "reviewing" | "feedback" | "accepted" | "superseded";

type Attempt = {
  id: string;
  lessonId: string;
  blockId: string;
  version: number;
  kind: AttemptKind;
  evidence: unknown;
  status: AttemptStatus;
};
```

The server creates attempts and assigns their opaque IDs and increasing per-block versions. The browser
may submit input, but it does not create an accepted attempt or choose its identity. The current attempt
is stored under `.tutorial/.tmp/workbook/attempts/`; learner evidence therefore stays outside authored
content and the public lesson contract.

Each interactive source creates an attempt as follows:

- An editor creates an attempt after the learner pauses typing. Its evidence is the draft text.
- A terminal creates an attempt after its output pauses. Its evidence is the bounded transcript and the
  frozen terminal display copy.
- A reflection creates an attempt when the learner sends a response. Its evidence is the response and the
  prior reflection conversation needed to interpret it.

A newer attempt supersedes an older attempt for the same block. A decision about a superseded attempt has
no effect.

## Tutor session and capability

The server owns one Pi agent session for the life of the workbook server. It has no filesystem, shell,
network, workspace, or built-in tools. Its only allowed custom tool is:

```text
accept_current_attempt()
```

The tool accepts no model-supplied block ID, path, version, or attempt ID. Before each review, the server
binds the tool internally to the exact active attempt being reviewed. When the tutor calls it, the server
records that it was called for that binding. After the turn settles, the attempt service accepts the attempt
only when it is still current and active.

This protects against a delayed tutor decision accepting a later learner edit that the tutor did not see.
It also prevents prompt-injected learner text from selecting another block, file, or revision.

The tutor receives the active block's private guidance and one attempt as clearly labelled untrusted data.
It may return concise learner feedback without calling the tool. For a reflection, that text is the tutor's
reply and remains part of the visible reflection conversation.

All tutor turns, including compaction, are serialized through one queue. A review never overlaps another
review or compaction.

## State and progression

For evaluated blocks, the public lifecycle is:

```text
working -> reviewing -> feedback
                    -> accepted -> continued -> next block active
```

`superseded` is internal. It is recorded when later evidence replaces an attempt under review, but is not
shown as an error to the learner.

When the tutor accepts an attempt:

1. The server checks that the attempt is still current for the active block.
2. For an editor, it promotes the accepted text to the authored target file.
3. It records an acceptance event with the attempt ID, version, and concise public success message.
4. It leaves the accepted block active and read-only.

The event log records durable progression facts: attempt acceptance and the learner's Continue action.
Existing event projection is migrated so it derives a common accepted checkpoint rather than separate
editor unlock, terminal verified, and reflection-completed states.

Continue is a generic browser action. It succeeds only for the active evaluated block whose current attempt
is accepted. It completes that block and reveals the next block. It cannot accept work, select a block, or
bypass an unaccepted block.

After a successful Continue action, the server queues Pi compaction with instructions to retain a concise,
factual summary of the completed block: its goal, accepted evidence, key feedback, and any learner
misconception worth carrying forward. The action returns promptly; a review for the next block waits behind
the queued compaction.

## UI

Editor, terminal, and reflection blocks share one accepted checkpoint view. It includes:

- a concise tutor success message;
- read-only accepted evidence: editor text, frozen terminal, or reflection thread;
- a Continue button.

When the UI first receives an accepted attempt, it displays a decorative full-screen confetti burst for one
second. The confetti is `aria-hidden`, does not intercept input, respects `prefers-reduced-motion`, and does
not replay simply because the page refreshes while the checkpoint remains visible.

Existing input surfaces remain in place. Their server routes submit evidence to the common attempt service.
The editor continues to review after typing pauses, the terminal after output pauses, and the reflection on
submission.

## Failure handling

If a tutor turn fails, the current attempt stays current and displays a neutral retry state. The attempt
service retries it after the existing debounce interval. A server restart reloads the current unaccepted
attempt and requeues review when its block becomes active.

A malformed tutor response without `accept_current_attempt()` is feedback, never acceptance. The service
allows the actual custom tool name in Pi's tool allowlist; otherwise Pi renders a tool-shaped string as
ordinary text rather than executing it.

## Verification

Tests must show that:

- all three sources create attempts and surface their common status;
- only an accepted current attempt can produce a checkpoint;
- stale or superseded acceptance cannot write an editor target, complete a block, or advance the lesson;
- accepted editor text is promoted only after that exact attempt is accepted;
- Continue advances only from an accepted checkpoint;
- one tutor session serializes editor, terminal, reflection, and compaction work and exposes only
  `accept_current_attempt`;
- compaction is queued after Continue and before the next tutor review;
- success checkpoint confetti appears once, lasts one second, and is disabled for reduced motion;
- the public state and UI never expose private tutor guidance or private attempt internals.
