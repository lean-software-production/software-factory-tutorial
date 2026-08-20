---
type: narrative
---

## Why this needs no daemon

The learner has three terminals, and each one does exactly one blocking thing: the first runs the
line,
the second follows a file, the third writes a line to a pipe and exits. Nothing has to read the
learner's typing and wait for a station to finish at the same time, which is the only genuinely
awkward
thing about this shape.

A daemon exists to connect a short-lived command to a handle held inside some other process. Here
the
handle is a path on disk, and any terminal that can write to a file can reach it.

Pi also ships a typed client for exactly this — a class with `start`, `stop`, `prompt`, `steer` and
`onEvent` methods, which would make this a dozen lines of Node instead of two dozen of shell. It is
better code, and it is the wrong choice here: it would put "how do you talk to a running process"
behind a method call the learner cannot see through, at the second-to-last lesson of a tutorial that
has been shell all the way down. Mention it as the thing to reach for outside a tutorial.
