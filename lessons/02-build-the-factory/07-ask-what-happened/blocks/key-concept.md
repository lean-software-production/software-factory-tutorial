---
type: narrative
---

## Key concept

You have spent two lessons reading the record with `jq`, which answers the questions you thought to
ask in the form you thought to ask them. "What did it cost" is a sum. "Is this line converging, or
has it rewritten the same function four times" is not.

There is a station that is good at that, and you built one in lesson 001.

```sh
echo "Describe what this calculator does, in three sentences." \
  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
```

Nothing about that command changes here except what it is pointed at. The harness is the same, the
job
still arrives on stdin, the boundary is still read-only. **The line's record is raw material like
any
other, and an agent reads it the way the first agent you ever ran read the calculator.**

This station needs no tools at all — the first one on this line that gets none. Everything it
works from is handed to it, which is the pattern lesson 006 established when it took `bash` away
from the validator and carried the evidence in instead. Applied a third time, it stops looking like
a trick.

`ask.sh` lives beside `watch.sh`, one level above the line, for the same reason: it operates a
factory
rather than belonging to a line, and it takes the line's name as an argument.
