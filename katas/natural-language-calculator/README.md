# Software factory tutorial

This is a tutorial about building a small software factory. The factory will make safe, repeated refactoring attempts; the spoken-expression calculator is simply the code it works on.

The calculator already has its TypeScript project, source code, and tests. Do not begin by improving the calculator directly. Begin by building the smallest factory that can ask a worker to change it and then validate that change independently.

## Start the tutorial

From the repository root:

```sh
cd tutorial-engine
npm install
npm start -- ../katas/natural-language-calculator
```

The tutor reads this README and the current iteration in `docs/specs/`. It will show one small step at a time. You can make the change yourself or ask the tutor to make it, then ask it to inspect your work whenever you need feedback.

## The kata

The calculator evaluates a deliberately small spoken-expression language. The starter code is correct but cramped: parsing, arithmetic, formatting, and command-line handling sit too close together. Its tests are the factory's first source of independent validation.

Run the kata tests from this directory:

```sh
npm install
npm test
```

The grammar accepts digit operands and the words `zero` through `twelve`:

```text
add four and nine
subtract two from ten
multiply three by six
divide twelve by four
divide ( multiply twelve by three ) by six
```

## Iterations

The ledger is in [`docs/specs/README.md`](docs/specs/README.md). The first row marked `Todo` is the current lesson. Each iteration adds only the capability needed to relieve the pressure exposed by the last one.

## Inspiration

This independent TypeScript kata was inspired by Chelsea Troy's natural-language calculator exercise. See [`ATTRIBUTION.md`](ATTRIBUTION.md).
