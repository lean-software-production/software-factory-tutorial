# Software factory tutorial 🏭

You're going to build a small software factory: a repeatable validation loop that improves a codebase a little at a time. You will give an agent a clear goal, validate its change independently, and feed the evidence into the next turn. Repeated safely, that feedback loop lets the factory converge on a healthier codebase.

## About the calculator

The raw material is a natural-language calculator written in TypeScript. It has a solid set of automated tests to provide the factory's first validation evidence, but its code has become messy and hard to maintain. You can inspect the code in [`./calculator`](./calculator). Your factory's job is to make safe, repeated refactorings that clean it up without changing what it does.

See the calculator's [README](./calculator/README.md) for more details.

## Your goal

You will begin with a bash `while` loop that shells out to `pi -p` for each agent operation, then build it into a loop where independent validation guides the next change.

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
