# Software factory tutorial 🏭

This is a tutorial about building a small software factory. The purpose of the factory is to 
refactor the [natural language calculator](./calculator) in this codebase, which has become difficult to maintain.

## About the calculator

The codebase is a "natural language calculator" written in Typescript. Fortunately it has a reasonably comprehensive set of automated tests for its behaviour. Unfortunately the code is a mess.

See the calculator's [README](./calculator/README.md) for more details.

## Your goal

You will build simple software factory that makes safe, repeated refactorings to improve the quality of the codebase.

The factory will be implemented as a bash `while` loop that shells out to `pi -p` to run an agent operation each loop.

## Setup

You need Node.js 22.19 or later, npm, an OpenCode API key, and a browser. Use Vim or any other editor; Docker and VS Code are not required.

From the repository root:

```sh
npm install
npm run setup
```

`npm run setup` prompts for your `OPENCODE_API_KEY` and saves it in the ignored, owner-only `.local/secrets.envrc` file. It never runs during `npm install`. In CI or another non-interactive environment, export `OPENCODE_API_KEY` instead.

## Start the tutorial

```sh
npm run tutorial
```

The command opens the local tutor in your browser. Leave it running. In another terminal, work in the factory directory:

```sh
cd factory
```

Edit files there by hand, then use the tutor for the next step or feedback. Once you have created `factory.sh`, run it directly.


## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`ATTRIBUTION.md`](ATTRIBUTION.md).
