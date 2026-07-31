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

The supplied Dev Container provides Node.js, pnpm, Graphviz, Pi, and both projects' npm dependencies.

Install Docker Desktop or OrbStack and VS Code's **Dev Containers** extension. From a terminal, make an OpenCode Zen key available, then start VS Code from that same terminal:

```sh
export OPENCODE_API_KEY=<your-key>
code .
```

In VS Code, press Command-Shift-P and choose **Dev Containers: Reopen in Container**. Wait for the image to build; VS Code then opens its integrated terminal inside the container.

The Dev Container passes `OPENCODE_API_KEY` to Pi without writing it into the repository. If you use direnv, an ignored `.local/secrets.envrc` at the repository root can export the same variable before you run `code .`.

## Start the tutorial

From the repository root, inside the Dev Container:

```sh
cd tutorial-engine
npm run dev -- .. --port 4310
```

The tutor reads this README and the current iteration in `docs/specs/`. It will show one small step at a time. You can make the change yourself or ask the tutor to make it, then ask it to inspect your work whenever you need feedback.

## The kata


## Iterations

The ledger is in [`docs/specs/README.md`](docs/specs/README.md). The first row marked `Todo` is the current lesson. Each iteration adds only the capability needed to relieve the pressure exposed by the last one.

## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`ATTRIBUTION.md`](ATTRIBUTION.md).
