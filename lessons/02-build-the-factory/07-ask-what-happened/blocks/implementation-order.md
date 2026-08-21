---
type: terminal-practice
tutor: |-
  Guide the learner through creating factory/ask.sh, comparing raw and filtered event counts, and
  asking questions about a recent run. Success means ask.sh requires a line and question, filters to
  tool_execution_start and message_end events, invokes pi --no-session --no-tools -p, answers only
  from the supplied record, and works on finished or growing records. Accept alternative useful
  questions if the learner verifies at least one answer against the JSONL. Clue toward putting the
  question before the evidence and filtering duplicate streamed fragments when context gets too
  large. The point is that an agent can treat the factory record as raw material without receiving
  tools.
---

## Implementation order

Work in this order. Complete each small step before moving to the next one:

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
       "$line"/.tmp/events/*.jsonl
   } | pi --no-session --no-tools -p
   ```

   The question goes first and the evidence after it, in the order every other station on this line
   has
   been taught to expect. "Answer only from what is in it" is there because a model asked about a
   refactoring will happily tell you about refactoring in general.

2. **Filter before asking.** The `jq` in the middle is not decoration. A five-iteration run writes
   tens
   of thousands of event lines, most of them streaming fragments of messages that also appear whole
   further down. Keeping the tool calls and the completed messages is what makes the record fit.

   See the difference for yourself:

   ```sh
   cat factory/refactor/.tmp/events/*.jsonl | wc -l
   jq -c 'select(.type=="tool_execution_start" or .type=="message_end")' \
     factory/refactor/.tmp/events/*.jsonl | wc -l
   ```

   This is the first time the line has run into a limit that belongs to the model rather than to the
   shell, and it will not be the last. A record that does not fit is a record nobody can ask about.

3. **Ask it something `jq` cannot answer.** From the repository root:

   ```sh
   ./factory/ask.sh refactor "Did this run make progress, or did it keep changing the same code?"
   ./factory/ask.sh refactor "Which criterion failed most often, and what did the validator say about it?"
   ./factory/ask.sh refactor "Where did the money go?"
   ```

   Check an answer against the record by hand before trusting the next one. This station has exactly
   the same standing as every other station on the line: it is a model, it can be wrong, and nothing
   here validates it.
