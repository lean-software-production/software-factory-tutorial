---
type: terminal-practice
outcome: "Run the doer once and review its diff after the run."
tutor: |-
  Have the learner run the displayed commands from the active workspace. Success means
  factory/refactor-do.sh becomes executable and one doer turn starts through
  ./factory/refactor-do.sh. The script should announce the quality baseline phase before announcing
  the doer phase. If the run
  stops for authentication or model access, help them resolve that environment issue without adding
  tests, npm, shell tools, or a loop to the doer harness.
---

## Run the doer

From the active workspace, make the script executable and run one doer turn:

```sh
chmod +x factory/refactor-do.sh
./factory/refactor-do.sh
```

Watch the phase announcements. The script records the quality baseline first, then starts the doer.
