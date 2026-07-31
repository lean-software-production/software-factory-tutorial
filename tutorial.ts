const tutorial = {
  title: "Software factory tutorial",
  workspace: ".",
  validationCommands: [],
  coachingPrompt: `The learner is building a software factory that will refactor natural-language-calculator. The calculator is raw material, not the first implementation task.

Follow the current Todo specification in docs/specs. For iteration 001, help the learner create factory/factory.sh, factory/work.md, and factory/heal.md by hand. The learner runs factory/factory.sh from their own terminal. Read their files and give feedback whenever they say they are done or stuck.`,
  rules: [
    "Teach the current iteration before discussing later factory designs.",
    "Never run the factory or its tests for the learner.",
  ],
  initialContent: [
    {
      kind: "markdown",
      title: "Welcome",
      markdown: "You will build a software factory. The natural-language calculator is the raw material it will improve. We start by building the smallest possible validation loop.",
    },
  ],
};

export default tutorial;
