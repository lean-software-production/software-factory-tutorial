# Natural Language Calculator

The codebase is a "natural language calculator" written in Typescript. Fortunately it has a reasonably comprehensive set of automated tests for its behaviour. Unfortunately the code is a mess.

The calculator evaluates a deliberately small spoken-expression language. The starter code is correct but cramped: parsing, arithmetic, formatting, and command-line handling sit too close together.

You can try the calculator from the repository root. Install its dependencies and build it once, then use its local npm entrypoint:

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
npm run quality
```

It runs ESLint over `src`, reporting cognitive complexity, cyclomatic complexity, nesting depth,
function length, statement count, parameter count, and duplicated branches. Every finding carries
a file, a line, and the rule name, and the command exits non-zero when it finds any — so a
reviewer, human or agent, can quote the output as evidence.

Findings on the starting code are expected: each one names a seam worth refactoring. The
thresholds describe the well-factored destination, so a finished refactoring reports none.
