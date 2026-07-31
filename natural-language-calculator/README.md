# Natural Language Calculator

The codebase is a "natural language calculator" written in Typescript. Fortunately it has a reasonably comprehensive set of automated tests for its behaviour. Unfortunately the code is a mess.

The calculator evaluates a deliberately small spoken-expression language. The starter code is correct but cramped: parsing, arithmetic, formatting, and command-line handling sit too close together.

You can try the calculator from the repository root. Install its dependencies and build it once, then use its local npm entrypoint:

```sh
npm install --prefix natural-language-calculator
npm run build --prefix natural-language-calculator
npx ./natural-language-calculator "add four and nine"

Result: 13
```

From inside `natural-language-calculator`, the equivalent command is:

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
cd natural-language-calculator
npm install
npm test
```
