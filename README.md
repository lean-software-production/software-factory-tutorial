# Software factory tutorial 🏭

You're going to build a small software factory: software that improves a codebase a little at a time and checks its own work.

The tutorial is two pieces of work. **Part 1** builds one agent at a time and runs each of them by hand — a doer that changes the code, then a validator that gathers independent evidence about the change — so you can see what each one contributes before anything is automated. **Part 2** joins them into an assembly line that runs itself and routes a failed verdict back for repair. Repeated safely, that feedback loop converges on a healthier codebase.

## About the calculator

The raw material is a natural-language calculator written in TypeScript. It has a solid set of automated tests to provide your first validation evidence, but its code has become messy and hard to maintain. You can inspect the code in [`./calculator`](./calculator). Your job is to make safe, repeated refactorings that clean it up without changing what it does.

See the calculator's [README](./calculator/README.md) for more details.

## Your goal

You begin with a single headless `pi -p` command that reads the calculator and answers a question. It creates no files and there is no loop yet. From there you build a doer that changes the code, then a validator that checks the change against written criteria, then carry the validator's findings back to the doer by hand. Only once you have run that loop yourself do you automate it.

Six lessons: 001–004 are Part 1, 005–006 are Part 2. Each part is a separate piece of homework, and the tutor stops at the end of lesson 004 so you can choose whether to carry straight on.

## Setup

You need Node.js 22.19 or later, npm 11 or later, a browser, and an authenticated `pi` on your `PATH`. Use Vim or any other editor; Docker and VS Code are not required.

Node 22 still bundles npm 10, which cannot record the `libc` field this repository's lockfile
uses and quietly strips it on every install. `npm install` warns when it is too old; upgrade
with `npm install -g npm@11`.

From the repository root:

```sh
npm install
npm run setup
```

The lessons call `pi` directly, so it has to be on your `PATH`. `npm install` already
fetched the version this repository pins, so exporting npm's local binary directory is
enough; install it globally if you would rather:

```sh
export PATH="$PWD/node_modules/.bin:$PATH"
```

`npm run setup` checks that Pi has an authenticated model for the web tutor. If it reports that Pi needs authentication, run `pi`, enter `/login`, and choose a provider. Pi keeps those credentials in its user-level configuration; this repository does not store them.

It also names the two models the tutorial runs on.

## Two models, on purpose

The tutorial runs two agents, and they want opposite things.

| Agent | Wants | Chosen with |
| --- | --- | --- |
| The web tutor | To teach well, at whatever a good explanation costs you | `TUTOR_MODEL` |
| The doer you drive with `pi -p` | To be cheap and fast | `pi`, then `/model` |

The doer's mistakes are not a problem to design away — catching them with independent
validation is the skill this tutorial teaches, so a small quick model is the better
raw material. Give the tutor whatever you would rather it used:

```sh
export TUTOR_MODEL=<provider>/<model>   # `pi --list-models` shows your options
```

Leave `TUTOR_MODEL` unset and Pi picks the tutor's model for you. Name a model that
does not exist or is not authenticated and the tutor falls back to Pi's pick rather
than failing; `npm run setup` reports whichever happened.

## Start the tutorial

```sh
npm run tutorial
```

The command opens the local tutor in your browser. It listens on loopback only; if no
browser opens, visit the printed address yourself.

To reach the tutor from another machine — for example through a proxy that serves it under
a subfolder, such as the EnsembleWorks canvas dev-server control at `/dev/4310/` — pick the
port the proxy expects and bind beyond loopback:

```sh
npm run tutorial -- --port 4310 --host 0.0.0.0 --no-open
```

The tutor has no authentication and edits the working tree, so only do that on a network you
trust.

Leave it running and open a second terminal at the repository root. Stay there: every command the lessons give you is written to run from the root, and the scripts you build take their paths relative to it. If you put `pi` on your `PATH` with the `export` above rather than installing it globally, repeat that export in this terminal too — from lesson 002 the scripts you write call `pi` themselves.

The files you write by hand all live under `factory/`, which is where the tutor looks for your work. Edit them with your usual editor as the tutor instructs, then go back to the tutor for the next step or for feedback. Once you have created `factory/refactor-do.sh` in lesson 002, run it directly:

```sh
chmod +x factory/refactor-do.sh
./factory/refactor-do.sh
```

Lesson 005 moves the whole line into `factory/refactor/`, and from then on you run `./factory/refactor/run.sh`. The lessons use Pi as the default doer. Advanced users may substitute another CLI harness when it preserves the doer requirements described in each lesson.

## Resume a tutorial

The tutor saves its browser transcript in `factory/tutorial-session.jsonl`. When you run `npm run tutorial` again, it offers to resume the saved transcript or start again. Resume keeps your factory files and asks a fresh tutor process to inspect them before continuing. Start again deletes everything in `factory/` and begins from the first step.

## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`ATTRIBUTION.md`](ATTRIBUTION.md).
