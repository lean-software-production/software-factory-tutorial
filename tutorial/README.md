# Software factory tutorial 🏭

You're going to build one assembly line: software that improves a codebase a little at a time and checks its own work.

A software factory is made of lines like it. A real one runs several — one that refactors, one that upgrades dependencies, one that writes the tests nobody got round to — each with its own agents, its own criteria, and its own definition of done, with the factory deciding which runs when. You are building the first, and everything you learn doing it is how you would build the rest.

The tutorial is two pieces of work. **Part 1** builds one agent at a time and runs each of them by hand — a doer that changes the code, then a validator that gathers independent evidence about the change — so you can see what each one contributes before anything is automated. **Part 2** joins them into an assembly line, takes you out of the loop, and then builds the instruments you need to operate something you are no longer driving: a record of what it did, a live view of what it is doing, a way to ask about a finished run, and a way to say something to a station while it works.

## About the calculator

The raw material is a natural-language calculator written in TypeScript. It has a solid set of automated tests to provide your first validation evidence, but its code has become messy and hard to maintain. You can inspect the code in [`./calculator`](./calculator). Your job is to make safe, repeated refactorings that clean it up without changing what it does.

See the calculator's [README](./calculator/README.md) for more details.

## Your goal

You begin with a single headless `pi -p` command that reads the calculator and answers a question. It creates no files and there is no loop yet. From there you build a doer that changes the code, then a validator that checks the change against written criteria, then carry the validator's findings back to the doer by hand. Only once you have run that loop yourself do you automate it.

Thirteen lessons: 001–004 are Part 1, 005–013 are Part 2. Each part is a separate piece of homework, and the tutor stops at the end of lesson 004 so you can choose whether to carry straight on.

The two parts are comparable homework, but not comparable in length. Part 2 is roughly twice the lessons, because automating something you were doing by hand is the easy half — the other half is being able to see what it did once you stopped watching, and neither half is optional. Every lesson in it is the same size as a lesson in Part 1, and there are simply more of them.

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

After setup, change into the tutorial root for learner commands:

```sh
cd tutorial
```

The lessons run from this `tutorial/` directory, where `factory/` and
`calculator/` are siblings. The lessons call `pi` directly, so it has to be on your
`PATH`. `npm install` already fetched the version this repository pins. From the
tutorial root, exporting the repository's local binary directory is enough; install
Pi globally if you would rather:

```sh
export PATH="$PWD/../node_modules/.bin:$PATH"
```

`npm run setup` checks that Pi has an authenticated model for the web tutor. If it reports that Pi needs authentication, run `pi`, enter `/login`, and choose a provider. Pi keeps those credentials in its user-level configuration; this repository does not store them.

It also names the model choices the tutorial runs on.

## Models, on purpose

The tutorial runs three agent roles, and they want different things.

| Agent | Wants | Chosen with |
| --- | --- | --- |
| The main web tutor | To teach well, at whatever a good explanation costs you | `TUTOR_MODEL` |
| The fast block helper | Quick read-only hints and readiness checks | `BLOCK_TUTOR_MODEL` |
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

The block helper is a short-lived read-only tutor used for fast hints and readiness
signals. It normally follows Pi's ordinary model selection too. If you want it to use
a smaller or faster authenticated model, set it separately:

```sh
export BLOCK_TUTOR_MODEL=<provider>/<model>
```

Leave `BLOCK_TUTOR_MODEL` unset and Pi chooses normally. Invalid or unauthenticated
values fall back to that same Pi choice.

## Start the tutorial

From the repository root, use the retained convenience launcher:

```sh
npm run tutorial
```

It starts the tutor against this `tutorial/` workspace and opens it in your browser. It
listens on loopback only; if no browser opens, visit the printed address yourself.

To reach the tutor from another machine — for example through a proxy that serves it under
a subfolder, such as the EnsembleWorks canvas dev-server control at `/dev/4310/` — pick the
port the proxy expects and bind beyond loopback:

```sh
npm run tutorial -- --port 4310 --host 0.0.0.0 --no-open
```

The tutor has no authentication and edits the working tree, so only do that on a network you
trust.

## Check the workbook

Before starting the tutor, check the authored workbook from the repository root without opening a
browser or starting a server:

```sh
npm run --workspace=tutorial-engine check:workbook
```

This uses the same loader as the tutor. It checks lesson and optional-part structure, manifests,
blocks, and lesson references, then prints the workbook's lesson and part counts.

Leave the tutor running and open a second terminal, then run `cd tutorial` there too. Stay in the tutorial root: every command the lessons give you is written to run from there, and the scripts you build take their paths relative to it. If you put `pi` on your `PATH` with the `export` above rather than installing it globally, repeat that export in this terminal after `cd tutorial` — from lesson 002 the scripts you write call `pi` themselves.

The files you write by hand all live under `factory/`, which is where the tutor looks for your work. Edit them with your usual editor as the tutor instructs, then go back to the tutor for the next step or for feedback. Once you have created `factory/refactor-do.sh` in lesson 002, run it directly:

```sh
chmod +x factory/refactor-do.sh
./factory/refactor-do.sh
```

Lesson 005 moves the whole line into `factory/refactor/`, and from then on you run `./factory/refactor/run.sh`. From lesson 010 you also build scripts that sit one level up, in `factory/` itself, for watching and questioning a line while it runs — those want a second terminal of their own, and lesson 012 wants a third. The lessons use Pi as the default doer. Advanced users may substitute another CLI harness when it preserves the doer requirements described in each lesson.

## Where to begin, and how to resume

The first time you run the root `npm run tutorial` launcher, it asks where to start. Start at the beginning to build everything yourself. Start at Part 2 to skip the first four lessons: it copies the files those lessons build into `factory/` and opens the assembly line, so you get Part 2 without having written Part 1 by hand.

After that, running it again offers to resume as well. Resume keeps your factory files and asks a fresh tutor process to inspect them before continuing. The other two options delete everything in `factory/` first.

The tutor keeps its own state — the transcript and how far you have got — in `.tutorial/.tmp/`. Your line's regenerated evidence stays in `factory/**/.tmp/`. Both locations are ignored by git; the scripts and prompts you write are not, so your own work is yours to commit if you want to keep it.

Each session moves you onto a branch of its own, named `factory-line-` and the date and time. From lesson 007 your line commits to the calculator, and from 008 it does so without asking, so those commits land there rather than on the branch you cloned.

## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`calculator/ATTRIBUTION.md`](calculator/ATTRIBUTION.md).
