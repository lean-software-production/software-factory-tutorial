# Spoken-expression calculator kata

A small TypeScript refactoring kata. It evaluates a deliberately limited language of spoken arithmetic. The initial code is correct but intentionally cramped: token handling, parsing, arithmetic, output formatting, and command-line handling live too close together. Keep behaviour green while improving those seams.

## Setup and validation

```sh
npm install
npm test
```

`npm test` is the kata's complete validation command. It needs no global tools.

## Language

Operands are non-negative digit tokens (such as `0` or `23`) or the words `zero` through `twelve`. Expressions use these prefix forms:

- `add <value> and <value>`
- `subtract <value> from <value>`
- `multiply <value> by <value>`
- `divide <value> by <value>`

A value can be parenthesised, so operations can nest. Division by zero and any expression that does not match the language are rejected.

## CLI

Pass the expression as command-line arguments:

```sh
npm start -- multiply \( add seven and two \) by five
# Result: 45

npm start -- subtract 4 from eleven
# Result: 7
```

The command writes a result to standard output on success. Invalid input writes a short error to standard error and exits with a non-zero status.

## Refactoring direction

The test suite protects the current grammar. Useful first improvements include giving the number vocabulary one home, separating parsing from calculation, and moving command-line concerns to the edge. Improve error messages only after preserving the established behaviour.
