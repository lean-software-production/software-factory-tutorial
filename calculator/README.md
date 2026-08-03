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

`npm test` says whether behaviour still holds. These scripts say whether the code is getting
better. Each prints to the terminal and exits non-zero when it finds a problem, so a reviewer —
human or agent — can quote the output as evidence:

```sh
npm run lint         # eslint: complexity, nesting depth, function length, duplicated branches
npm run duplication  # jscpd: copy-paste clones, with file and line locations
npm run cycles       # madge: circular imports
npm run deadcode     # knip: unused files, exports, and dependencies
npm run quality      # all four, stopping at the first failure
npm run complexity   # ccts-json: cognitive complexity per function (reports, does not gate)
```

Findings on the starting code are expected: each one names a seam worth refactoring. Prefer
these scripts to invoking the tools directly — `ccts` (without `-json`) starts a web server and
never exits, and `code-health-meter` writes HTML files while exiting `0` even when its audits
fail.
