import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Lints the workbook browser client. Its job is the class of defect review keeps finding by hand:
 * hooks called conditionally, and effects whose dependency list does not match what they read.
 *
 * It deliberately does not enforce style. The dense one-line style in this codebase is a deliberate
 * choice (see the formatter decision), so no formatting rule belongs here.
 */
export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["web-workbook/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: "readonly", document: "readonly", location: "readonly", history: "readonly", navigator: "readonly", fetch: "readonly", WebSocket: "readonly", EventSource: "readonly", matchMedia: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", requestAnimationFrame: "readonly", cancelAnimationFrame: "readonly", addEventListener: "readonly", removeEventListener: "readonly", scrollY: "readonly", console: "readonly", IntersectionObserver: "readonly", ResizeObserver: "readonly", HTMLElement: "readonly", MessageEvent: "readonly", URL: "readonly" }
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // An error. The five reports this rule opened were all real: an effect reading a filtered
      // array while depending on a key derived from it, an editor seeded from a value that would
      // have rebuilt it mid-typing, a title effect reading state it did not depend on, and a
      // runway effect carrying two `.join("|")` hashes that stood in for one derived id. Each was
      // fixed by making the effect depend on what it reads, so there is nothing left to downgrade
      // the rule for.
      "react-hooks/exhaustive-deps": "error"
    }
  }
];
