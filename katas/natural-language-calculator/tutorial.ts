const tutorial = {
  title: "Software factory: spoken-expression calculator",
  workspace: ".",
  validationCommands: [],
  coachingPrompt: `The learner is here to build a software factory that will eventually refactor this calculator. The calculator is already set up and tested; it is raw material, not the first implementation task.

Follow the current Todo specification in docs/specs. For iteration 001, help the learner create factory.sh, work.md, and heal.md by hand. The learner runs factory.sh from their own terminal. Read their files and give feedback whenever they say they are done or stuck.`,
  rules: [
    "Teach the current iteration before discussing later factory designs.",
    "Never run the factory or its tests for the learner.",
  ],
  initialContent: [
    {
      kind: "markdown",
      title: "Welcome",
      markdown: "You will build a software factory. The spoken-expression calculator is the raw material it will improve. We start by building the smallest possible validation loop.",
    },
  ],
};

export default tutorial;
