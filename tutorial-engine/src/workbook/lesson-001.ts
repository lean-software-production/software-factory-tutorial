import { validateWorkbookLesson, type WorkbookLesson } from "./contract.js";

export const lesson001: WorkbookLesson = validateWorkbookLesson({
  id: "001",
  title: "Run an agent headlessly",
  status: "draft",
  keyConcepts: [
    "An agent is a harness with a job to be done.",
    "A headless run does the job and exits, with no human in the conversation while it works.",
    "A boundary lists what the harness can use; this lesson's agent can read the calculator but cannot change files."
  ],
  learningOutcomes: [
    "Identify the harness and the job to be done in a Pi command.",
    "Explain what makes a run headless and why that matters for software that runs on its own.",
    "State what the lesson-001 boundary prevents the agent from doing."
  ],
  blocks: [
    {
      id: "orientation",
      type: "narrative",
      title: "Orientation",
      markdown: "This workbook draft ports lesson 001 for human review. You will use your own terminal from the repository root. The workbook shows commands and records your acknowledgements; it never runs those terminal commands for you.\n\nAn **agent** is a harness with a job to be done. The **harness** is ordinary software: it prepares the input, calls a model, and handles what comes back. The **job to be done** is what you hand it."
    },
    {
      id: "run-supplied-command",
      type: "terminal-practice",
      title: "Run the supplied headless command",
      required: true,
      command: "echo \"Describe what this calculator does, in three sentences.\" \\\n  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)",
      context: "Run from the repository root.",
      expectedObservation: "Pi prints a short description of the calculator and exits. The exact wording is not important; the mechanics are the lesson.",
      help: {
        explain: "The text before the pipe is the job to be done. The subshell changes into calculator, then Pi runs headlessly with -p and with read-only tools.",
        command: "Copy the command exactly, starting from the repository root. It uses standard input; you do not edit a file for this lesson.",
        expected: "Expect a brief answer about the calculator. It may vary because a model is producing it. What matters is that the run finishes without a conversation."
      }
    },
    {
      id: "change-job",
      type: "terminal-practice",
      title: "Change only the job to be done",
      required: true,
      command: "echo \"What files make up this calculator, and what does each one appear to do?\" \\\n  | (cd calculator && pi --no-session --tools read,grep,find,ls -p)",
      context: "Run from the repository root. Replace only the quoted standard input if you want to ask your own question.",
      expectedObservation: "Pi answers the new question and exits. The harness and boundary did not change; only the job did.",
      help: {
        explain: "Changing the quoted text changes the job to be done. The same harness still prepares input, calls the model, and handles the response.",
        command: "Keep the pipe and the parenthesized Pi command the same. Replace the quoted sentence after echo.",
        expected: "The answer should address your new question and then stop. If a script ran this and walked away, nothing would wait for a person."
      }
    },
    {
      id: "reflection",
      type: "reflection",
      title: "Reflection",
      required: true,
      prompt: "In your own words: which part was the harness and which part was the job to be done? What made the run headless, and what could the agent not have done however it was asked?"
    },
    {
      id: "transition",
      type: "lesson-transition",
      title: "Lesson transition",
      required: true,
      label: "Complete lesson 001",
      markdown: "This agent only describes. The next lesson gives an agent a job that changes the calculator, which means giving it a different boundary — and raises the question this tutorial is built around: who checks the change?"
    }
  ]
});
