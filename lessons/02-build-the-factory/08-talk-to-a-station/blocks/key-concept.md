---
type: narrative
---

## Key concept

Headless has meant one thing since lesson 001: no human in the conversation while the station works.
The learner has read that as *the station cannot be spoken to*, which is not what it says and not
what
is true.

Pi's third output mode changes what standard input is for. With `-p`, stdin is the prompt: the
station
reads it, does the job, and exits. With `--mode rpc`, **stdin is a command channel** — the process
stays
alive and reads JSON commands one per line, for as long as something keeps the channel open.

One of those commands is `steer`, and the docs are precise about when it lands: the message is
delivered after the current assistant turn finishes executing its tool calls, and before the next
model
call. Not an interruption, and not a queue for later. The station finishes what it is doing, and
then
what the learner said is in its context.

Nobody is in the conversation. Something can still be put into it.
