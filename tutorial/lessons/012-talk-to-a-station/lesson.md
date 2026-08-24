---
durationMinutes: 35
outcomes:
  - Run the doer station in RPC mode with a named pipe command channel.
  - Keep the channel open safely and clean it up on exit.
  - Create a factory-level steering script that writes compact JSONL commands to the channel.
  - Watch a run while steering the doer and explain when a steer can still affect the station.
blocks:
  - key-concept
  - implementation-order
  - why-this-needs-no-daemon
  - checks
  - pressure-test
---

# Talk to a running station

Give one station a channel, and say something to it while it works.
