# Software factory tutorial 🏭

You're going to build one assembly line: software that improves a codebase a little at a time and checks its own work.

A software factory is made of lines like it. A real one runs several — one that refactors, one that upgrades dependencies, one that writes the tests nobody got round to — each with its own agents, its own criteria, and its own definition of done, with the factory deciding which runs when. You are building the first, and everything you learn doing it is how you would build the rest.

The tutorial has three parts: first you learn what a factory is and run a tiny one, then you build a manual validation loop, then you turn that loop into an observable software factory.

## About the calculator

The raw material is a natural-language calculator written in TypeScript. It has a solid set of automated tests to provide your first validation evidence, but its code has become messy and hard to maintain. You can inspect the code in [`./workspaces/refactor-line/calculator`](./workspaces/refactor-line/calculator). Your job is to make safe, repeated refactorings that clean it up without changing what it does.

See the calculator's [README](./workspaces/refactor-line/calculator/README.md) for more details.

## Your goal

You begin with a single headless `pi -p` command that reads the calculator and answers a question. It creates no files and there is no loop yet. From there you build a doer that changes the code, then a validator that checks the change against written criteria, then carry the validator's findings back to the doer by hand. Only once you have run that loop yourself do you automate it.

Fifteen lessons in three parts:

- Part 1, `what-is-a-factory` and `tetris`, establishes the factory model.
- Part 2, lessons 001–004, builds the validation loop by hand.
- Part 3, lessons 005–013, automates and operates the factory.

## Setup

You need Node.js 24.2 or later on the 24.x line, npm 11 or later, a browser, and an authenticated `pi` on your `PATH`. Use Vim or any other editor; Docker and VS Code are not required.

The Node floor is not arbitrary, and neither is the ceiling. Below 24.2 the `npm run setup`
preflight silently does nothing, so it never tells you whether Pi is authenticated. And on
Node 23 the runtime prints an experimental-feature warning to stderr that makes the
calculator's own test suite fail before you have touched a line of it — which would then fail
the first success criterion on every verdict the tutorial teaches you to trust. Odd-numbered
Node releases are Current rather than LTS, and that is where such warnings appear; this
tutorial is tested on 24.x. Node 24 bundles npm 11, so a current Node gets you both.

First install and check the shared tooling from the repository root:

```sh
npm install
npm run setup
```

After setup, start the tutor from the repository root. It prints learner workspace paths; use the
active `refactor-line` path for the main lesson commands:

```sh
npm run tutorial:workbook
cd tutorial/.tutorial/<session-id>/workspaces/refactor-line
```

The lessons run from this live workspace, where `factory/` and `calculator/` are siblings. The
lessons call `pi` directly, so it has to be on your `PATH`. `npm install` already fetched the
version this repository pins. From the live workspace, exporting the repository's local binary
directory is enough; install Pi globally if you would rather:

```sh
export PATH="$PWD/../../../../../node_modules/.bin:$PATH"
```

`npm run setup` checks that Pi has an authenticated model for the web tutor. If it reports that Pi needs authentication, run `pi`, enter `/login`, and choose a provider. Pi keeps those credentials in its user-level configuration; this repository does not store them.

It also names the model choices the tutorial runs on.

## Models, on purpose

The tutorial runs two agent roles, and they want different things.

| Agent | Wants | Chosen with |
| --- | --- | --- |
| The main web tutor | To teach and review practice well | `TUTOR_MODEL` |
| The doer you drive with `pi -p` | To be cheap and fast | `pi`, then `/model` |

The doer's mistakes are not a problem to design away — catching them with independent
validation is the skill this tutorial teaches, so a small quick model is the better
raw material. Give the main tutor whatever you would rather it used:

```sh
export TUTOR_MODEL=<provider>/<model>   # `pi --list-models` shows your options
```

Leave `TUTOR_MODEL` unset and Pi picks the main tutor's model for you. Name a model
that does not exist or is not authenticated and the tutor falls back to Pi's pick
rather than failing; `npm run setup` reports whichever happened.

## Start the tutorial

From the repository root, start the workbook:

```sh
npm run tutorial:workbook
```

It uses this `tutorial/` directory as the authored content template, creates a fresh
session under `.tutorial/<session-id>/`, prints that session ID and learner workspace
path, and opens the tutor in your browser. It listens on loopback only; if no browser
opens, visit the printed address yourself.

To reach the tutor from another machine — for example through a proxy that serves it under
a subfolder, such as the EnsembleWorks canvas dev-server control at `/dev/4310/` — pick the
port the proxy expects and bind beyond loopback:

```sh
npm run tutorial:workbook -- --port 4310 --host 0.0.0.0 --no-open
```

The tutor has no authentication and edits the session-local learner workspace, so only do that
on a network you trust.

## Check the workbook

Before starting the tutor, check the authored workbook from the repository root without opening a
browser or starting a server:

```sh
npm run check:workbook
```

This uses the same generic loader as the tutor and verifies load/schema integrity. It does not pin
prose, lesson counts, block order, vocabulary, commands, filenames, or expected learner behavior.
Learning quality stays with the authors. Occasional human or dynamic agent play-throughs can be
useful observations, but they are non-gating and should consume the workbook dynamically.

Leave the tutor running and open a second terminal, then `cd` to the printed active live workspace
path, for example `tutorial/.tutorial/<session-id>/workspaces/refactor-line`. Stay there: every
command the lessons give you is written to run from that live workspace, and the scripts you build
take their paths relative to it. If you put `pi` on your `PATH` with the `export` above rather than installing it
globally, repeat that export in this terminal after changing directory — from lesson 002 the
scripts you write call `pi` themselves.

Most files you write by hand live under `factory/` in the active live workspace, which is where the
tutor looks for your work. The workbook's embedded editor and terminal are confined to the active
live workspace; sibling workspaces from the same session are separate repositories and are not
mounted in the terminal. Edit files with your usual editor as the tutor instructs, then go back to
the tutor for the next step or for feedback. Once
you have created `factory/refactor-do.sh` in lesson 002, run it directly:

```sh
chmod +x factory/refactor-do.sh
./factory/refactor-do.sh
```

Lesson 005 moves the whole line into `factory/refactor/`, and from then on you run `./factory/refactor/run.sh`. From lesson 010 you also build scripts that sit one level up, in `factory/` itself, for watching and questioning a line while it runs — those want a second terminal of their own, and lesson 012 wants a third. The lessons use Pi as the default doer. Advanced users may substitute another CLI harness when it preserves the doer requirements described in each lesson.

## Where to begin, and how to resume

Every plain `npm run tutorial:workbook` launch creates a new session. The launcher prints the
session ID, the session state path, and the learner workspace paths. Save the ID if you want to
come back to that exact work later:

```sh
npm run tutorial:workbook -- --session <session-id>
```

Only an explicit `--session <session-id>` resumes a previous session. Legacy state under
`.tutorial/.tmp/` is ignored by the launcher and is not resumed or deleted automatically.

The tutor keeps its transcript and progress in `.tutorial/<session-id>/workbook/`. Your editable
copies live in `.tutorial/<session-id>/workspaces/<workspace-id>/`; lessons 001–013 use
`refactor-line`. Regenerated evidence still belongs in `factory/**/.tmp/` inside that workspace.
Both `.tutorial/` and those `.tmp/` directories are ignored by the product repository; the scripts,
prompts, calculator changes, and commits you make are private to the live workspace repository.

From lesson 007 your line commits to the session-local calculator, and from 008 it does so
without asking, so those commits land in `.tutorial/<session-id>/workspaces/refactor-line/.git`
rather than in the cloned tutorial repository.

## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`workspaces/refactor-line/calculator/ATTRIBUTION.md`](workspaces/refactor-line/calculator/ATTRIBUTION.md).
