# Software factory tutorial 🏭

You're going to build a small software factory. In this case, it is a simple, repeatable machine that improves a codebase a little bit at a time.

The codebase is a [natural language calculator](./calculator) that has become difficult to maintain.

## About the calculator

The codebase is a "natural language calculator" written in Typescript. Fortunately it has a reasonably comprehensive set of automated tests for its behaviour. Unfortunately the code is a mess.

See the calculator's [README](./calculator/README.md) for more details.

## Your goal

You will build simple software factory that makes safe, repeated refactorings to improve the quality of the codebase.

The factory will be implemented as a bash `while` loop that shells out to `pi -p` to run an agent operation each loop.

## Setup

You need Node.js 22.19 or later, npm, a browser, and an authenticated Pi. Use Vim or any other editor; Docker and VS Code are not required.

From the repository root:

```sh
npm install
npm run setup
```

`npm run setup` checks that Pi has an authenticated model for the web tutor. If it reports that Pi needs authentication, run `npx pi`, enter `/login`, and choose a provider. Pi keeps those credentials in its user-level configuration; this repository does not store them.

## Start the tutorial

```sh
npm run tutorial
```

The command opens the local tutor in your browser. Leave it running. In another terminal, work in the factory directory:

```sh
cd factory
```

Edit files there by hand as instructed by the tutor, then use it for the next step or feedback. Once you have created `run.sh`, run it directly. The lessons use Pi as the default factory doer. Advanced users may substitute another CLI harness when it preserves the doer requirements described in each lesson.


## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`ATTRIBUTION.md`](ATTRIBUTION.md).
## Resume a tutorial

The tutor saves its browser transcript in `factory/tutorial-session.jsonl`. When you run `npm run tutorial` again, it offers to resume the saved transcript or start again. Resume keeps your factory files and asks a fresh tutor process to inspect them before continuing. Start again deletes everything in `factory/` and begins from the first step.
