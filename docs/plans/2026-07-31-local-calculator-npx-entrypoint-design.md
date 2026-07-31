# Local calculator npx entrypoint design

## Goal

Run the calculator from the repository root without publishing or installing it globally:

```sh
npx ./natural-language-calculator "add four and nine"
```

The equivalent command inside the calculator directory is `npx . "add four and nine"`.

## Design

Package the calculator as a local npm CLI, following the tutorial engine's pattern. Its package manifest will expose a `natural-language-calculator` binary whose target is the compiled `dist/cli.js` entrypoint.

Add a build script and TypeScript output configuration that compile production files in `src/` into `dist/`. The CLI implementation will keep its existing argument handling, output, and exit status behaviour.

The README will show the root-level and in-directory `npx` commands. It will state that a developer first installs the calculator dependencies and builds it. This matches the existing local tutorial-engine command: `npx` executes an already-built local package; it neither publishes the package nor installs it globally.

## Validation

Retain the current unit and CLI-boundary tests. Add an integration test that invokes the built local binary through `npx`, verifies a successful calculation, and verifies that an invalid expression exits non-zero and reports the existing error message.

## Scope

No package will be published. No calculator grammar, arithmetic, formatting, or error behaviour will change.
