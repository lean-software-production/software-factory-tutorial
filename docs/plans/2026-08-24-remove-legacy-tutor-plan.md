# Remove the legacy tutor

## Goal

Make the workbook tutor the only supported tutorial. Remove the old browser tutor, its build,
launch path, tests, and documentation without breaking the workbook or its existing learner state.

The old and new tutors were deliberately kept side by side while the workbook was being introduced.
That coexistence is no longer useful: it leaves two entry points, two browser applications, and source
code that the workbook imports only because it has not yet taken ownership of a few shared utilities.

## Scope and decisions

This change removes the legacy browser tutor. It does not remove compatibility for **earlier workbook
state formats**: existing workbook learners must still be able to resume from the append-only state in
`.tutorial/.tmp/workbook/`.

The implementation should adopt these defaults:

- `npm run tutorial:workbook` is the named tutorial command, and `npm start` remains its alias.
- Remove `npm run tutorial` rather than silently changing what it starts.
- Retarget the published `tutorial-engine` executable to the workbook CLI. Do not keep a legacy
  executable or API compatibility layer.
- Do not migrate, read, or delete legacy browser-tutor state. Existing
  `.tutorial/.tmp/tutorial-session.jsonl` and `.tutorial/.tmp/tutorial-progress.json` files remain
  ignored historical data; users start the workbook at its introduction.
- Do not recreate the legacy Part 2 shortcut or reset flow unless the workbook later gains an explicit,
  tested replacement.

Before implementation, record the workbook-only boundary as an ADR under
`tutorial-engine/docs/adr/`, using ADRgen in the development container. The ADR should supersede any
accepted decision that says both tutors remain supported.

## Current boundary

The legacy tutor currently owns:

- `tutorial-engine/web/` and `tutorial-engine/vite.config.ts`;
- `tutorial-engine/src/cli.ts`, `src/server/`, `src/session-log.ts`, `src/lesson/`, `src/protocol/`,
  and `src/validation/`;
- legacy-only agent code and tests;
- the root `scripts/tutorial.mjs` launcher and `npm run tutorial` command; and
- the `dist/web/` build output.

The workbook tutor currently owns:

- `tutorial-engine/web-workbook/`;
- `tutorial-engine/src/workbook/`;
- the root `scripts/tutorial-workbook.mjs` launcher and `npm run tutorial:workbook` command; and
- `.tutorial/.tmp/workbook/` state.

The workbook still imports some utilities from the legacy tree. Those utilities must move before the
legacy source is deleted.

## Implementation plan

### 1. Establish the workbook-only package boundary

Update `tutorial-engine/package.json` so `build` first clears `dist/`, then compiles TypeScript and
builds only the workbook web application. Remove the legacy `dev` and `build:web` scripts. Retain
`dev:workbook`, `build:web:workbook`, `check:workbook`, and the workbook terminal-image build. Point
the `tutorial-engine` bin at `dist/workbook/cli.js`.

Update the root `package.json` to remove `tutorial`. Keep `tutorial:workbook` and its `start` alias.
Regenerate the root lockfile after the package changes.

Remove `scripts/tutorial.mjs`, `tutorial-engine/vite.config.ts`, and the legacy web source after the
workbook renderer no longer imports it. Because `dist/` is ignored and TypeScript does not clean old
output, verify a fresh build cannot leave `dist/web/` behind.

### 2. Move workbook dependencies into workbook ownership

Extract or move the following modules, preserving their behaviour and their relevant tests:

| Current location | Workbook action |
| --- | --- |
| `src/browser-open.ts` | Move under `src/workbook/`; update the workbook CLI and browser-open test. |
| `src/cli-arguments.ts` | Move under `src/workbook/`; retain the argument parser and its tests. |
| `src/runtime-log.ts` | Move under `src/workbook/`; retain its logging test. |
| `src/tutorial-state.ts` | Move under `src/workbook/`, preserving the `.tutorial/.tmp` base path. |
| `src/agent/pi-adapter.ts` | Extract the tutor and block-tutor model choice and resolution helpers into a workbook model module. |
| `src/agent/workspace-boundary.ts` | Move it to workbook ownership and replace its dependency on legacy audit protocol types with a small local audit-sink type. |
| `src/server/local-server.ts` | Define `LOOPBACK_HOST` in the workbook server or a workbook HTTP utility. |
| `web/src/markdown.tsx` | Move the Markdown renderer into `web-workbook/src/`; move its styling and tests with it. |

Remove `mermaid` after this extraction if no workbook code imports it. The workbook still needs its
Markdown and syntax-highlighting dependencies.

### 3. Delete legacy runtime code and its tests

Delete the legacy source once no workbook import references it:

- `tutorial-engine/web/`;
- `src/cli.ts` and `src/index.ts` unless a workbook-only public API replaces the latter;
- `src/server/`, `src/session-log.ts`, `src/lesson/`, `src/protocol/`, and `src/validation/`; and
- legacy-only portions of `src/agent/`.

Delete the associated legacy tests and the sample legacy lesson fixture. Retain and re-home tests that
cover browser opening, CLI arguments, runtime logging, the workspace boundary, Markdown rendering,
`.gitignore`, the workbook server, events, timeline, tutor, and browser UI.

Update the gitignore test to assert workbook events and attempts rather than the legacy transcript and
progress files.

Remove dead pre-current-workbook API compatibility from `src/workbook/tutor.ts`, including the old
`WorkbookTutor` and `RestrictedWorkbookTutor` shapes, legacy overloads, and `compactAfterBlock()`.
Update the tests that cover those APIs.

### 4. Keep real workbook state compatibility

Retain the compatibility code in the workbook timeline, event, and server modules that reads earlier
workbook JSONL records, normalizes prior message-source names, projects older event variants, and
backfills early workbook frames. These paths protect existing workbook sessions; they are unrelated to
the legacy browser tutor.

Rename comments and types where useful so “legacy” means an earlier workbook record format rather than
the removed tutor. Do not convert browser-tutor state into workbook state.

### 5. Update learner and developer documentation

Update these current documents to describe only the workbook:

- `README.md` — replace old command examples and remove unsupported transcript, resume, reset, and
  Part 2 shortcut claims;
- `.devcontainer/README.md` — use `npm run tutorial:workbook -- --port 4310`;
- `tutorial-engine/README.md` — document workbook development, checks, and the embedded Docker
  terminal; and
- `AGENTS.md` — describe the workbook event log and attempts instead of generic tutor transcript and
  progress files.

Keep old plans as historical records. Add an archive note where necessary to make clear that their
legacy-browser entry points and side-by-side deployment assumptions no longer apply.

### 6. Verify the removal

Run focused tests after each extraction, then run the full checks after deletion:

```sh
npm run --workspace=tutorial-engine check:workbook
npm run --workspace=tutorial-engine check
npm run --workspace=tutorial-engine build
npm run test:onboarding
npm run check
```

Confirm the old artefacts are absent after a clean build:

```sh
test ! -d tutorial-engine/web
test ! -d tutorial-engine/dist/web
```

Finally exercise the public workflow and package contents:

```sh
npm run tutorial:workbook -- --port 4310 --no-open
npm run --workspace=tutorial-engine browser:smoke
npm pack --dry-run --workspace=tutorial-engine
```

The browser smoke is optional when Playwright or Chromium is unavailable. The package dry run must list
only the workbook CLI and assets; it must not contain `dist/web/` or compiled legacy server files.

## Completion criteria

- The repository offers one tutorial implementation and one named tutorial command.
- The workbook builds, starts, and passes its automated checks without imports from legacy code.
- Existing workbook state remains readable.
- Legacy browser-tutor state is inert and remains ignored.
- A clean package contains no legacy browser application, server, CLI, or build output.
