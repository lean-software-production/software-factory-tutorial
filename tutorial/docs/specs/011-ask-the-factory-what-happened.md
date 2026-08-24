# Ask the factory what happened

Point lesson 001's command at the line's own record.

## Key concept

The learner has spent two lessons reading the record with `jq`, which answers the questions they
thought to ask in the form they thought to ask them. "What did it cost" is a sum. "Is this line
converging, or has it rewritten the same function four times" is not.

There is a station that is good at that, and they built one in lesson 001.

```sh
echo "Describe what this calculator does, in three sentences." \
  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)
```

Nothing about that command changes here except what it is pointed at. The harness is the same, the job
still arrives on stdin, the boundary is still read-only. **The line's record is raw material like any
other, and an agent reads it the way the first agent the learner ever ran read the calculator.**

This station needs no tools at all — the first one on this line that gets none. Everything it works
from is handed to it, which is the pattern lesson 006 established when it took `bash` away from the
validator and carried the evidence in instead. Applied a third time, it stops looking like a trick.

`ask.sh` lives beside `watch.sh`, one level above the line, for the same reason: it operates a factory
rather than belonging to a line, and it takes the line's name as an argument.

## Implementation order

Build this lesson in this order. Complete each small step before moving to the next one:

1. **Write the asker.** Create `factory/ask.sh`:

   ```sh
   #!/usr/bin/env bash
   set -euo pipefail

   cd "$(dirname "$0")"
   line="${1:?usage: ask.sh <line> <question>}"
   shift

   {
     echo "$*"
     echo
     echo "Below is the record of the most recent run of the '$line' assembly line."
     echo "Each line is one JSON event. Answer only from what is in it."
     echo
     jq -c 'select(.type=="tool_execution_start" or .type=="message_end")' \
       "$line"/events/*.jsonl
   } | pi --no-session --no-tools -p
   ```

   The question goes first and the evidence after it, in the order every other station on this line has
   been taught to expect. "Answer only from what is in it" is there because a model asked about a
   refactoring will happily tell you about refactoring in general.

2. **Filter before asking.** The `jq` in the middle is not decoration. A five-iteration run writes tens
   of thousands of event lines, most of them streaming fragments of messages that also appear whole
   further down. Keeping the tool calls and the completed messages is what makes the record fit.

   Have the learner see the difference for themselves:

   ```sh
   cat factory/refactor/events/*.jsonl | wc -l
   jq -c 'select(.type=="tool_execution_start" or .type=="message_end")' \
     factory/refactor/events/*.jsonl | wc -l
   ```

   This is the first time the line has run into a limit that belongs to the model rather than to the
   shell, and it will not be the last. A record that does not fit is a record nobody can ask about.

3. **Ask it something `jq` cannot answer.** From the repository root:

   ```sh
   ./factory/ask.sh refactor "Did this run make progress, or did it keep changing the same code?"
   ./factory/ask.sh refactor "Which criterion failed most often, and what did the validator say about it?"
   ./factory/ask.sh refactor "Where did the money go?"
   ```

   Have the learner check an answer against the record by hand before trusting the next one. This
   station has exactly the same standing as every other station on the line: it is a model, it can be
   wrong, and nothing here validates it.

## Checks

From the repository root, after a run has finished:

```sh
./factory/ask.sh refactor "What did each iteration change, in one line each?"
```

Verify by hand that:

- the answer names things that are actually in the record, and the learner can find them;
- `ask.sh` runs with no tools, and does not read the calculator or any file the caller did not give it;
- it works on a line that has finished and on one that is halfway through, since the record is a file
  either way; and
- `./factory/ask.sh` with no arguments fails with its usage message.

## Pressure test

Three scripts now sit above the line: one that runs it, one that watches it, one that answers questions
about it. That is most of what a person needs to operate something they are not doing by hand.

Start a run and watch it. Two iterations in, the doer picks the wrong file — it has decided the parser
needs restructuring when the duplication `success.md` cares about is in the formatter.

The learner can see it happening. They can ask `ask.sh` about it and get a clear, accurate account of
the mistake being made. They can watch the next tool call land in the wrong file.

What they cannot do is say anything to it.

Every station on this line has been handed its job at the moment it started and then left alone until
it finished. That was the definition of headless in lesson 001, and it has been true of everything
since. The only control the learner has over a station that is running is to kill it.
