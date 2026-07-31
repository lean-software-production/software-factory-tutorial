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
npm run tutorial -- --port 4310
```

The command opens the local tutor in your browser. Edit the repository files by hand—for example, with `vim`—then use the tutor for the next step or feedback. To run the factory loop directly, use `npm run factory`.

The tutor reads this README and the current iteration in `docs/specs/`. It will show one small step at a time. You can make the change yourself or ask the tutor to make it, then ask it to inspect your work whenever you need feedback.

## Optional Dev Container

Docker/OrbStack and VS Code's **Dev Containers** extension remain available if you want an isolated development environment. The container runs `npm ci` when it opens. Export `OPENCODE_API_KEY` before reopening it, then run `npm run tutorial`; the container passes that key through without writing it into the repository. Run `npm run setup` inside the container only if you prefer a local credential file there.

## The kata


## Iterations

The ledger is in [`docs/specs/README.md`](docs/specs/README.md). The first row marked `Todo` is the current lesson. Each iteration adds only the capability needed to relieve the pressure exposed by the last one.

## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`ATTRIBUTION.md`](ATTRIBUTION.md).
