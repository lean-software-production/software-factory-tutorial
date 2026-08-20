---
type: lesson-transition
---

## Pressure test

The line runs in order, and it is about to be left alone. Before that happens, look at what its
independence actually rests on.

The validator does not write to files because `validate.md` tells it not to. It holds the `bash`
tool.
Every other boundary in this tutorial was drawn with `--tools` — the doer cannot run a shell because
it
was never given one — and this one was drawn with a sentence.

Have the learner check rather than take it on faith. Add one line to `validate.md` asking the
validator
to create `calculator/proof.txt`, run `./factory/refactor/validate.sh`, and then look for the file:

```sh
ls calculator/proof.txt
```

It is there. Delete it and remove the line again.

Nothing went wrong, because a person was reading every verdict and would have noticed. That person
is
about to stop reading them. Independence that rests on a prompt is a promise the station makes to
itself, and the next lesson replaces it with one the station cannot break.
