# Software factory tutorial 🏭

You're going to build a small software factory: a repeatable validation loop that improves a codebase a little at a time. You will give an agent a clear goal, validate its change independently, and feed the evidence into the next turn. Repeated safely, that feedback loop lets the factory converge on a healthier codebase.

## About the calculator

The raw material is a natural-language calculator written in TypeScript. It has a solid set of automated tests to provide the factory's first validation evidence, but its code has become messy and hard to maintain. You can inspect the code in [`./calculator`](./calculator). Your factory's job is to make safe, repeated refactorings that clean it up without changing what it does.

See the calculator's [README](./calculator/README.md) for more details.

## Your goal

You will begin with a bash `while` loop that shells out to `pi -p` for each agent operation, then build it into a loop where independent validation guides the next change.

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
| The doer your factory drives with `pi -p` | To be cheap and fast | `pi`, then `/model` |

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

Leave it running. In another terminal, work in the factory directory:

```sh
cd factory
```

Edit files there by hand as instructed by the tutor, then use it for the next step or feedback. Once you have created `run.sh`, run it directly. The lessons use Pi as the default factory doer. Advanced users may substitute another CLI harness when it preserves the doer requirements described in each lesson.

## Resume a tutorial

The tutor saves its browser transcript in `factory/tutorial-session.jsonl`. When you run `npm run tutorial` again, it offers to resume the saved transcript or start again. Resume keeps your factory files and asks a fresh tutor process to inspect them before continuing. Start again deletes everything in `factory/` and begins from the first step.

## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`ATTRIBUTION.md`](ATTRIBUTION.md).
