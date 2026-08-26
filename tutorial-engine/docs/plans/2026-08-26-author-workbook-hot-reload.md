# Author-mode workbook hot reload

## Status

Proposed — 2026-08-26

## Purpose

While authoring a tutorial, a save to an authored Markdown file should update the open workbook
without restarting the command or creating another learner workspace. This is an authoring aid: a
successful prose reload refreshes the authored text in place while preserving the current
lesson/block, URL anchor, presentation progress, timeline history, attempts, learner workspace, and
local browser UI selection.

The authored content root stays separate from the learner workspace. The watcher observes the
content root (`workbook.md`, `parts/`, and `lessons/`); it never watches or copies files from
`.tutorial/<session-id>/workspace/`.

## Decisions

### Explicit author watch mode

Add `--watch` to the workbook CLI. It enables Markdown hot reload for the current server process.
Normal launches retain their current stable-session behaviour. Document the author command in
`tutorial-engine/README.md`:

```sh
npm run dev:workbook -- ../tutorial --watch
```

`--watch` is the supported authoring loop. It does not watch TypeScript, CSS, or the browser bundle;
Vite/the existing development workflow remains responsible for engine and UI source changes.

### A reload preserves session state and reprojects authored text

On a valid content reload, atomically replace the in-memory `LoadedWorkbook` and ordered block
stream, then reproject the existing session state through the new stream:

- retain timeline events, attempt records, learner workspace files, and session-local Git history;
- preserve completed/work-accepted state for block identities that still exist;
- display already-recorded authored course messages with the same event ids/sequences but with text
  freshly projected from the new Markdown;
- rebuild/invalidate the main tutor session when the projected authored history, active block
  Markdown, or private guidance changes; and
- keep reload-generation protection so tutor/review/briefing work started before the valid reload
  cannot append results after it.

Normal prose edits keep the author exactly where they are. If a structural edit removes the current
block/anchor, the retained completion history is applied to the new stream and the active position
falls back to the earliest still-valid uncompleted block; authored messages for removed blocks are
not displayed because there is no current Markdown to project.

The browser receives a reload notification and fetches fresh state. It does not use
`window.location.reload()` and does not navigate to the introduction: refreshing state preserves the
active embedded terminal connection, local UI state, and the current URL anchor whenever that anchor
still exists.

### Last valid content wins

A save commonly exposes an incomplete YAML front matter block or an unfinished Markdown edit.
Reload the candidate only after a small debounce (about 150 ms). Use `loadWorkbook()` as the sole
validator.

If loading fails:

- retain the last valid in-memory workbook and current presentation;
- log the error with the authored file path supplied by the loader;
- send an author-only reload-status event containing a safe, concise error message; and
- retry on the next filesystem event.

A valid later save clears the error and replaces the content. Never expose private `tutor` guidance
in the reload status.

### Reload notification transport

Extend the existing `/api/workbook/timeline` Server-Sent Events endpoint rather than add a second
connection. It already provides a live server-to-browser channel.

- Keep `timeline` and `record` events unchanged.
- Add a `content-reloaded` event after the valid content replacement is complete.
- Add a `content-reload-error` event for an invalid candidate.
- The React app opens one `EventSource` after initial state load. On `content-reloaded`, it fetches
  `/api/workbook/state` and replaces local state without clearing current-position UI state or
  changing a still-valid URL anchor. On an error, it displays a small non-modal author notice while
  leaving the existing rendered tutorial usable.

The server must send the initial state only through the existing HTTP state route; SSE is a
notification channel, not a second state representation.

## Implementation plan

### 1. Define the watch-mode CLI contract

Modify:

- `tutorial-engine/src/workbook/cli-arguments.ts`
- `tutorial-engine/src/workbook/cli.ts`
- `tutorial-engine/src/workbook/server.ts`
- `tutorial-engine/README.md`
- CLI tests in `tutorial-engine/test/workbook-cli.test.ts`

Add `--watch` to argument parsing and help text. Thread it through `runWorkbookCli()` as a
`watchContent` server option, defaulting to `false` for direct `startWorkbookServer()` callers and
tests. The command must still accept `--session`, `--port`, and `--no-open` together with
`--watch`.

### 2. Add a small authored-content watcher

Create `tutorial-engine/src/workbook/content-watch.ts` with a narrow interface such as:

```ts
export interface ContentWatch {
  close(): void;
}

export function watchWorkbookContent(
  contentRoot: string,
  onChange: () => void,
  onError: (error: Error) => void,
): ContentWatch;
```

Watch only authored Markdown locations:

- `<root>/workbook.md`;
- `<root>/parts/**/*.md`; and
- `<root>/lessons/**/lesson.md` and `<root>/lessons/**/blocks/*.md`.

Use a portable watcher strategy rather than recursively watching the entire root. It must ignore
`.tutorial/`, `factory/`, `calculator/`, editor swap files, and unrelated engine output. Debounce
coalesced save events. Rescan subscriptions after a successful reload so newly added lesson or
block directories are observed.

Keep this module independent of HTTP, timeline, and React. Unit-test filtering, debounce, close,
and adding a new lesson/block directory with an injectable filesystem-watcher seam; do not make the
suite depend on timing quirks of the host filesystem.

### 3. Make the workbook runtime reloadable without resetting session state

Modify `tutorial-engine/src/workbook/server.ts` and tutor-history projection helpers.

Refactor server startup so the current `LoadedWorkbook` and its ordered block stream are mutable
runtime state rather than startup-only `const` values. All state projection, route handlers,
authored-message generation, and tutor context helpers must read that current state.

On a debounced change:

1. load and fully validate a candidate with `loadWorkbook(runtime.contentRoot)`;
2. if it fails, retain all current runtime state and broadcast `content-reload-error`;
3. if it succeeds, enter the existing timeline serialization boundary, advance a reload generation,
   replace the loaded workbook and block stream, reread the retained timeline, and run the normal
   active-block initialization against the new stream; then
4. rebuild the main tutor against the reprojected state, requeue any active reviewing/working
   attempt, and broadcast `content-reloaded`.

Existing asynchronous review/briefing tasks must carry the generation in which they started and
silently abandon their final write when it no longer matches. A reload must not let an old review
accept an attempt or append a tutor message into the new generation.

Ensure server shutdown closes the content watch before closing HTTP/SSE connections and retains the
current close behaviour for terminal and tutor resources.

### 4. Refresh the browser on content notifications

Modify `tutorial-engine/web-workbook/src/workbook-ui.tsx` and, if needed,
`tutorial-engine/web-workbook/src/styles.css`.

After initial state is present, establish one `EventSource` to `api/workbook/timeline`. Register
handlers for the two new reload events and close the source on unmount. Ignore the existing timeline
record events for now; terminal review polling and HTTP mutation responses remain unchanged.

On `content-reloaded`, fetch state and replace it without clearing local current-position state or
navigating to the introduction. If the existing URL fragment still names a revealed block or the
completion anchor, keep it. If a structural edit makes the fragment invalid, replace it with the
server-projected active anchor. On `content-reload-error`, preserve the current state and present an
unobtrusive notice with a concise parse/validation error. A subsequent successful reload removes the
notice.

Do not render or transmit private tutor guidance. The browser receives only the loader error string
and the public state it already receives from the state route.

### 5. Test the author loop end to end

Add focused server tests in `tutorial-engine/test/workbook-server.test.ts` (or a dedicated
`workbook-content-watch.test.ts`) using a fake/injectable watcher trigger:

- a block Markdown prose edit reloads the authored text in place, preserves the active block and
  URL anchor, and retains timeline/attempt state;
- changing lesson topology (add/remove/rename a block, lesson, or part) presents the new topology
  and falls back only if the current block/anchor no longer exists;
- an invalid intermediate Markdown save leaves the last valid state available and produces a reload
  error event;
- correcting that save replaces the content and clears the error;
- a delayed tutor review from before reload cannot write into the new generation;
- reload retains a sentinel file and Git repository in the learner workspace; and
- `close()` stops the watcher and prevents later callbacks from mutating state.

Extend UI tests to verify that a reload notification fetches and renders the new state without
changing a valid current anchor, falls back for an invalid anchor without a blocked-link modal, and
that an error notification leaves current content on screen.

Run from the repository root:

```sh
npm run --workspace=tutorial-engine check
npm run check
```

## Acceptance criteria

With `npm run dev:workbook -- ../tutorial --watch` running:

1. Saving any valid authored prose change updates the open workbook within one debounce cycle while
   preserving the current lesson/block and URL anchor.
2. Saving a structural curriculum change preserves retained progress where block identities still
   exist and falls back to the earliest still-valid uncompleted block only when the current
   block/anchor no longer exists.
3. A temporarily invalid save does not crash the server or blank the workbook. The prior valid
   tutorial remains visible, with an author-facing error notice.
4. The next valid save recovers automatically.
5. Learner workspace files and session-local Git history survive every reload.
6. No review, briefing, terminal callback, or SSE connection from the old generation can mutate the
   new one.
7. Non-watch launches preserve today's behaviour and do not allocate filesystem watchers.
