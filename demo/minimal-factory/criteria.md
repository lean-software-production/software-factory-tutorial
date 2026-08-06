## What counts as a good change

Every station on this line is given these criteria. The doer works towards them,
the validator grades against them, and the healer is told which of them a change
failed. They are the same four for everyone, on purpose: a line where the maker
and the judge hold different standards has no standard.

1. **One sentence.** The change can be described in one simple sentence. If
   describing it needs an "and", it is two changes and belongs in two turns.
2. **Behaviour unchanged.** Nothing observable about the calculator differs. Same
   inputs, same outputs, same errors.
3. **Tests pass.** The calculator's own suite still runs green.
4. **One file.** Only the target file named below is modified. Nothing else in
   the repository is touched.

The fourth one is not a request. The line reverts every change outside the target
file before anyone judges the change, so editing another file to make a problem go
away does not work — the edit is undone and the problem comes back. If a fix
requires touching something else, the honest move is to say so and change nothing.
