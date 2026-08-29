# Tutorial engine

The workbook is the tutorial engine's only browser interface. It embeds
`@earendil-works/pi-coding-agent` as a TypeScript SDK; it does not start Pi's CLI or RPC mode.

What it is for, and the students, authors and facilitators it serves, is in
[`docs/vision.md`](docs/vision.md).

## Run a workbook

Point the workbook engine at an authored tutorial directory. In this repository, that content
template is `../tutorial` from the engine package; learner edits happen in a session workspace
under `../tutorial/.tutorial/<session-id>/workspace/`:

```sh
cd tutorial-engine
npm install
npm run dev:workbook -- ../tutorial
```

From the repository root, `npm run tutorial:workbook` is the named launcher for the workbook;
`npm start` is its alias. It uses the root trusted Node runtime profile for the embedded terminal:
it mounts only the repository-root `node_modules/` directory read-only at workspace
`node_modules/`, and it never mounts `package.json` or lockfiles. The terminal container mounts the
session workspace root read-only, then overlays learner-writeable roots such as `factory/`,
`calculator/`, `workspaces/`, scratch directories, and `.git/`. A plain launch creates a fresh
session and prints its ID and workspace path. Reopen a specific session with
`npm run tutorial:workbook -- --session <id>`; browser-tutor `.tutorial/.tmp` state is not resumed.

Before printing launch lines, listening, or opening the browser, the CLI makes two small model preflight calls in parallel: one as the Main Tutor (`TUTOR_MODEL`) and one as the Practice Coach (`PRACTICE_COACH_MODEL`). Both must return a non-empty assistant reply. This catches missing auth, quota, and usage-limit failures up front; successful startup costs one minimal prompt per role and takes roughly the slower of the two calls. Authored content and session validation still happen before these paid calls. Low-level `startWorkbookServer` users, tests, and eval fixtures that bypass the CLI are not preflighted.

Add `--no-open` to suppress browser launch, or `--port 4310` to choose a port. Add `--watch` when authoring Markdown content:

```sh
npm run dev:workbook -- ../tutorial --watch
```

Watch mode observes `workbook.md`, `parts/**/*.md`, and lesson `lesson.md`/`blocks/*.md` files. A valid prose save refreshes the authored text in place: the browser keeps the current lesson/block URL anchor, presentation progress, timeline history, attempts, learner workspace, and local UI selection. If a structural edit removes the current anchor/block, the session falls back to the earliest still-valid uncompleted block after applying the retained completion history. An invalid intermediate save leaves the last valid workbook visible and shows a small author notice until the next valid save. Watch mode does not watch engine TypeScript, CSS, or the browser bundle; use the normal Vite/development workflow for those.

The server binds only to `127.0.0.1`. Pi credentials remain in the server process; the browser has no filesystem or provider-credential access.

Keep the launching terminal open. It prints timestamped startup, browser, Pi, tool, validation, and shutdown events. It also saves each run to `~/Library/Logs/SoftwareFactoryTutorial/` on macOS (or `$XDG_STATE_HOME/software-factory-tutorial/` elsewhere); the terminal prints the exact path. While Pi is working, a heartbeat every 15 seconds names its current activity, so a browser spinner always has a corresponding server-side status.

## Tutorial convention

A tutorial needs no engine configuration file. The engine infers the workbook from authored
Markdown under the target directory:

- `workbook.md` has YAML front matter, exactly one H1 title, and workbook introduction Markdown;
- optional `parts/<part-id>.md` files have empty front matter, one H1 title, and part preamble Markdown;
- each `lessons/<lesson-id>/lesson.md` has duration, optional `workspace`, and ordered block ids in
  front matter;
- a lesson H1 supplies the title; the first paragraph after it is the compact dek used in summaries and history; any remaining Markdown is the full lesson introduction;
- each `lessons/<lesson-id>/blocks/<block-id>.md` has one H2 title, block-type front matter, and learner-facing Markdown.

Supported authored block types are:

- `narrative`: authored workbook prose. It has only `type: narrative` front matter, renders its H2 title and Markdown, and advances with Continue.
- `terminal-practice`: embedded terminal work. It requires private `tutor` front matter and a learner-facing `outcome`.
- `editor-practice`: embedded editor work. It requires private `tutor`, workspace-relative `path` front matter, and a learner-facing `outcome`.
- `reflection`: tutor-mediated reflection. It requires private `tutor` front matter and a learner-facing `outcome`.

A lesson's `workspace` may be absent. When present it must be
`workspaces/<lowercase-hyphenated-slug>`. It is not filesystem isolation: all lessons still share
the same session workspace and the same session-local Git repository, and sibling navigation
remains possible. The field only changes the default working folder for that lesson.
Editor-practice paths remain learner-visible as authored, such as `spec.md`, but reads and
accepted promotions resolve them under the lesson folder. Terminal-practice shells start in
`/workspace/workspaces/<slug>`.

If `tutorial/workspaces/<slug>/` exists, the launcher copies it into each new session and
includes its copied files in the baseline commit. Authored `.gitkeep` files are copied unchanged.
If the copied template contains no files, the launcher writes an empty `.gitkeep` marker in the
session destination so Git can baseline the declared workspace. If there is no template, the
`workspace` declaration creates the session folder with the same empty `.gitkeep` marker. The hidden
marker is acceptable in the learner workspace because ordinary `ls` omits it. Symlinked lesson
workspace templates and nested symlinks are rejected during materialization.

A lesson's `outcomes` are not authored in its front matter. They are derived, in block order,
from the `outcome` field on every interactive block (`terminal-practice`, `editor-practice`, and
`reflection`), so each learning outcome is delivered at the block where it is actually earned.

The workbook synthesizes the workbook introduction, each part preamble, and each lesson preamble
as structural blocks. A lesson-preamble block contains its title, dek, outcomes, and full
introduction before the first declared block. Structural blocks have anchors, participate in the
same progression flow as declared blocks, and do not require evaluated learner evidence. See
[`docs/workbook-state-vocabulary.md`](docs/workbook-state-vocabulary.md) for the state vocabulary
and transitions.

## Commands

```sh
npm run build  # compile server and browser client
npm test       # unit tests
npm run check  # TypeScript, unit tests, browser build, and browser smoke
```

`npm run browser:smoke` is safe to run on its own. It serves the built bundle in
`dist/web-workbook/`, so before it starts Chromium it compares that bundle against everything vite
reads to produce it — `web-workbook/`, `src/`, `vite.config.ts`, `package.json` — and builds it when
it is missing or older than any of them. A smoke failure is therefore about the code, not about
which bundle happened to be on disk. Inside `npm run check` the preceding `build:web:workbook` has
already made the bundle current, so the check still builds it exactly once and the smoke adds only
a directory sweep. The other browser scripts under `test/` — `continue-scroll.mts`,
`tutor-chat-scroll.mts`, `visual-affordances.mts` — serve the same directory and only check that it
exists, so run `npm run build:web:workbook` before driving one of those by hand.

## Release checks

Playwright is a declared development dependency, but Chromium itself is downloaded separately.
The devcontainer handles this: its image carries Chromium's system libraries and `post-create.sh`
downloads the browser, so `npm run check` works in a fresh container with no extra step. On a host
outside the container, provision it once after `npm install`:

```sh
npm run browser:install
```

If Chromium is present but fails to start with a missing shared library such as `libnspr4.so`, the
system dependencies are absent rather than the browser; `npm run browser:install:ci` installs both
and needs root.

`npm run check` is the deterministic package gate: it type-checks the engine and workbook UI, runs
engine tests, builds the workbook browser bundle, and runs the Chromium smoke test. `prepublishOnly`
runs `build` then this check, so publishing cannot omit the browser smoke. CI provisions Chromium with
its Linux dependencies through `npm run browser:install:ci`. Docker terminal-image builds and
provider-backed evaluations are intentionally separate from this mandatory gate.
