const tutorial = {
  title: "Spoken-expression calculator",
  workspace: ".",
  validationCommands: [
    { id: "test", label: "Run tests", command: "npm", args: ["test"] },
  ],
  coachingPrompt: `You are coaching a learner through a refactoring kata. Work only in this kata workspace.

Start by establishing a green baseline and tracing the current calculation flow. Take exactly one small refactoring step at a time. Before making a change, offer the learner a clear choice: they can make the change or ask you to make it. After either choice, run npm test and discuss the result before proposing another step.

Protect the accepted spoken-expression behaviour. Good later targets are consolidating the number vocabulary, separating tokenisation and parsing from evaluation, moving CLI concerns outward, and retaining the token and context when errors occur. Do not introduce a new feature merely to make a refactoring look useful.`,
  initialContent: [
    {
      kind: "markdown",
      title: "Orientation",
      markdown: "The tests are green, but the calculator puts several jobs in one place. First map the flow from command-line arguments to a formatted result.",
    },
    {
      kind: "diagram",
      title: "Current flow",
      mermaid: "flowchart LR\n  A[CLI arguments] --> B[evaluateSpokenExpression]\n  B --> C[Token handling]\n  C --> D[Parsing and arithmetic]\n  D --> E[Formatted output]",
      text: "CLI arguments enter evaluateSpokenExpression, where token handling, parsing, and arithmetic are combined before formatted output is produced.",
    },
  ],
};

export default tutorial;
