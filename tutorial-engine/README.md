# Tutorial engine

The workbook is the tutorial engine's only browser interface. It embeds
`@earendil-works/pi-coding-agent` as a TypeScript SDK; it does not start Pi's CLI or RPC mode.

What it is for, and the students, authors and facilitators it serves, is in
[`docs/vision.md`](docs/vision.md).

## Run a workbook

Point the workbook engine at an authored tutorial directory. In this repository, that content
template is `../tutorial` from the engine package; learner edits happen in live workspace copies
under `../tutorial/.tutorial/<session-id>/workspaces/<workspace-id>/`:

```sh
cd tutorial-engine
npm install
npm run dev:workbook -- ../tutorial
```

From the repository root, `npm run tutorial:workbook` is the named launcher for the workbook;
`npm start` is its alias. It uses the root trusted Node runtime profile for the embedded terminal:
it mounts only the repository-root `node_modules/` directory read-only at workspace
`node_modules/`, and it never mounts `package.json` or lockfiles. The terminal container mounts only
the active live workspace read-write at `/workspace`; sibling workspaces are not mounted. A plain
launch creates a fresh session and prints its ID and workspace paths. Reopen a specific session with
`npm run tutorial:workbook -- --session <id>`; browser-tutor `.tutorial/.tmp` state is not resumed.

Before printing launch lines, listening, or opening the browser, the CLI makes one small Main Tutor (`TUTOR_MODEL`) model preflight call. It must return a non-empty assistant reply. This catches missing auth, quota, and usage-limit failures up front; successful startup costs one minimal prompt. Authored content and session validation still happen before this paid call. Low-level `startWorkbookServer` users, tests, and eval fixtures that bypass the CLI are not preflighted.

Add `--no-open` to suppress browser launch, or `--port 4310` to choose a port. Add `--watch` when authoring Markdown content:

```sh
npm run dev:workbook -- ../tutorial --watch
```

Watch mode observes `workbook.md`, `parts/**/*.md`, and lesson `lesson.md`/`blocks/*.md` files. A valid prose save refreshes the authored text in place: the browser keeps the current lesson/block URL anchor, presentation progress, timeline history, attempts, learner workspace, and local UI selection. If a structural edit removes the current anchor/block, the session falls back to the earliest still-valid uncompleted block after applying the retained completion history. An invalid intermediate save leaves the last valid workbook visible and shows a small author notice until the next valid save. Watch mode does not watch engine TypeScript, CSS, or the browser bundle; use the normal Vite/development workflow for those.

The server binds only to `127.0.0.1`. Pi credentials remain in the server process; the browser has no filesystem or provider-credential access.

## Main Tutor and session state

The workbook has one model-backed role: the Main Tutor. Chat, editor review, terminal review,
reflection, restoration, and summaries all use that role. Every operation creates a fresh restricted Pi
session, reconstructs its history from the canonical `workbook/events.jsonl` log, and disposes the Pi
session afterward. Authored content is prior assistant speech; active-block conversation stays detailed;
completed evaluated blocks use block summaries; completed lessons use lesson summaries.

Current logs start with an explicit `workbook-session-format` version record. Missing, old, newer, or
old-event logs fail with a clear instruction to start a fresh session; there is no old-session migration
or replay lane. Reopening a supported session reconstructs learner progress from the log but never resumes
a pending model effect.

During an active editor or terminal practice block, the Main Tutor receives only bounded read-only
`list_files` and `read_file` tools scoped to that lesson's live workspace. Other blocks have no workspace
tools. There is no shell, network, mutation, extension, skill, nested Pi, or broad filesystem authority.

Each Main Tutor prompt or compaction gets exactly three automatic provider attempts. Exhaustion creates
one learner-safe process-local fatal state: the workbook asks the learner to fix or reconnect the provider
and restart, and blocks all progression without persisting a failure event or provider detail. There is no
manual retry route or pending-effect recovery. Required block, lesson, and final workbook summaries are
written before the completion event they support.

Keep the launching terminal open. It prints timestamped startup, browser, Pi, tool, validation, and shutdown events. It also saves each run to `~/Library/Logs/SoftwareFactoryTutorial/` on macOS (or `$XDG_STATE_HOME/software-factory-tutorial/` elsewhere); the terminal prints the exact path. While Pi is working, a heartbeat every 15 seconds names its current activity, so a browser spinner always has a corresponding server-side status.

## Tutorial convention

A tutorial needs no engine configuration file. The engine infers the workbook from authored
Markdown under the target directory:

- `workbook.md` has YAML front matter, exactly one H1 title, and workbook introduction Markdown;
- optional `parts/<part-id>.md` files have empty front matter, one H1 title, and part preamble Markdown;
- each `lessons/<lesson-id>/lesson.md` has duration, optional lowercase-hyphenated `workspace` ID,
  and ordered block ids in front matter;
- a lesson H1 supplies the title; the first paragraph after it is the compact dek used in summaries and history; any remaining Markdown is the full lesson introduction;
- each `lessons/<lesson-id>/blocks/<block-id>.md` has one H2 title, block-type front matter, and learner-facing Markdown.

Supported authored block types are:

- `narrative`: authored workbook prose. It has only `type: narrative` front matter, renders its H2 title and Markdown, and advances with Continue.
- `terminal-practice`: embedded terminal work. It requires private `tutor` front matter and a learner-facing `outcome`.
- `editor-practice`: embedded editor work. It requires private `tutor`, workspace-relative `path` front matter, and a learner-facing `outcome`.
- `reflection`: tutor-mediated reflection. It requires private `tutor` front matter and a learner-facing `outcome`.

A lesson's `workspace` may be absent for narrative/reflection-only lessons. Editor-practice and
terminal-practice lessons must declare one lowercase-hyphenated ID, for example
`workspace: refactor-line`. Every declared ID must have an authored template at
`tutorial/workspaces/<id>/`; the launcher copies each declared template into
`.tutorial/<session-id>/workspaces/<id>/` and initializes that copy as an independent Git repository
with a clean baseline commit. Lessons that share an ID share that live workspace and history; the
launcher never resets or recopies it on progression, reload, revisit, or resume.

Editor-practice paths remain learner-visible as authored, such as `spec.md`, but reads and accepted
promotions resolve them under the active live workspace. Terminal-practice shells start in
`/workspace`, where Docker has mounted only that active live workspace. Docker child processes receive
only the minimal client environment needed to reach local Docker plus `OPENCODE_API_KEY` by name;
arbitrary parent secrets and proxy variables are not forwarded. Authored templates must be
real in-root directories, contain no `.git`, and contain no symlinks; `node_modules/` and generated
`.tmp/` evidence are not copied.

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
npm run build:typescript # compile engine TypeScript into dist/
npm run build            # compile server and browser client
npm test                 # unit tests, including deterministic eval tests
npm run check:eval       # deterministic/model-free type-check for synthetic engine eval code
npm run test:eval        # deterministic/model-free synthetic engine eval tests
npm run test:fast        # lint, strict no-emit type-check, eval checks, unit tests, web build, browser smoke
npm run eval -- --help   # paid Docker-backed live engine eval CLI
npm run test:workbook-ux               # authoritative provider-free UX recording + decoded-WebM analysis + report
npm run test:workbook-ux:deterministic # explicit alias for the same deterministic UX test
npm run test:workbook-ux:ai            # deliberate advisory Pi review after deterministic checks pass
npm run test:visual                    # canonical devcontainer visual gate, including two combined feedback composites
npm run check            # build TypeScript, run test:fast, then build/readiness-check the terminal image
```

The workbook UX test family lives in [`test/workbook-ux/`](test/workbook-ux/). It writes a durable `report.md` and `ux-test-result.json`; deterministic findings gate exit, while the optional AI review is advisory and marked `@needs-human`.

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
downloads the browser, so `npm run test:fast` works in a fresh container with no extra browser step.
On a host outside the container, provision it once after `npm install`:

```sh
npm run browser:install
```

If Chromium is present but fails to start with a missing shared library such as `libnspr4.so`, the
system dependencies are absent rather than the browser; `npm run browser:install:ci` installs both
and needs root.

`npm run test:fast` is the deterministic package gate: it lints the workbook UI, runs the strict
no-emit type-check for engine, tests, and workbook UI, checks synthetic engine eval types, runs the
engine tests once, builds the workbook browser bundle exactly once, and runs the Chromium smoke test.

`npm run check` is the engine release/package gate: it first runs `build:typescript` to prove package
emit, then `test:fast`, then `check:workbook-terminal-image` to build and readiness-check the Docker
terminal image. `prepublishOnly` delegates once to this check. CI provisions Chromium with its Linux
dependencies through `npm run browser:install:ci` before invoking the check. Live provider-backed
evaluations remain separate from this mandatory gate.

The synthetic tutorial-engine mechanics eval lives in [`evals/`](evals/). `npm run check:eval`
and `npm run test:eval` are deterministic and model-free. The live command is
`npm run eval -- --scenario <v2-id>` from this workspace; it is paid, requires Docker, and writes
active reports under `tutorial-engine/evals/reports/` from the repository root. `npm run eval:release`
runs the bounded consolidated release profile once each for `v2-editor-feedback-locked` and
`v2-transition-completion`. Exploratory scopes use `--scenario`, `--all --yes`, and optional repeats.

From the repository root, `npm run eval:engine -- --scenario <v2-id>` forwards here,
`npm run eval:release` delegates through `--workspace=tutorial-engine`, and root `npm run eval -- ...`
remains only as a temporary compatibility alias to `eval:engine`. It is not an authored-workbook eval.
These engine evals are distinct from the root-owned authored-workbook evaluator in
[`../evals/workbook/`](../evals/workbook/). Its deterministic commands are
`npm run check:eval:workbook` and `npm run test:eval:workbook`; its wired live runner is
`npm run eval:workbook -- ...` from the repository root and writes current reports under
root `evals/workbook/reports/`.
