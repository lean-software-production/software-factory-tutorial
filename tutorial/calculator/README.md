# Natural Language Calculator

The codebase is a "natural language calculator" written in Typescript. Fortunately it has a reasonably comprehensive set of automated tests for its behaviour. Unfortunately the code is a mess.

The calculator evaluates a deliberately small spoken-expression language. The starter code is correct but cramped: parsing, arithmetic, formatting, and command-line handling sit too close together.

You can try the calculator from the session workspace. Install its dependencies and build it once, then use its local npm entrypoint:

```sh
npm install --prefix calculator
npm run build --prefix calculator
npx ./calculator "add four and nine"

Result: 13
```

From inside `calculator`, the equivalent command is:

```sh
npx . "add four and nine"
```

The grammar accepts digit operands and the words `zero` through `twelve`:

```text
add four and nine
subtract two from ten
multiply three by six
divide twelve by four
divide ( multiply twelve by three ) by six
```

To run the tests for the calculator:

```sh
cd calculator
npm install
npm test
```

## Measuring quality

`npm test` says whether behaviour still holds. `npm run quality` says whether the code is getting
better:

```sh
node scripts/quality.mjs
```

`npm run quality` does the same thing. Prefer the direct form in scripts and agent prompts: the
check exits non-zero whenever it finds something, and npm appends its own `npm error … command
failed` block to that exit, which reads like the script broke rather than like the code has
findings. `npm run --silent quality` suppresses that too.

It runs two checks and prints both reports, even when the first one fails, so a single run shows
the whole picture:

- **ESLint** over `src` — cognitive complexity, cyclomatic complexity, nesting depth, function
  length, statement count, parameter count, and duplicated branches. Each finding carries a file,
  a line, and the rule name.
- **knip** — unused files, exports, and dependencies. This is what catches the leftovers of an
  extraction: a module the refactoring stopped importing, or an export nothing calls.

The command exits non-zero if either check reports, so a validator, human or agent, can quote the
output as evidence. `npm test` covers a third case for free: `noUnusedLocals` and
`noUnusedParameters` make unused variables, imports, and parameters a build error.
