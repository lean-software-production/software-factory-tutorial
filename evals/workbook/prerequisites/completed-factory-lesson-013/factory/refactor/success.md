Success criteria for the refactor line:

- Passes its tests. Evidence: `npm test` output from the harness.
- Reveals intention. Evidence: quote names or structure in the diff that make the calculator easier to read.
- No duplication. Evidence: quote `grep -n` or diff output that shows duplicated logic was removed or not introduced.
- Fewest elements. Evidence: quote quality output or diff output showing unnecessary code was removed or not added.
