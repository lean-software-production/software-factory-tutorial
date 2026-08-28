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
      // A warning, not an error, and deliberately so. There are five violations in App and the
      // editor/timeline effects, and each is a real design question rather than a slip: effects
      // that intentionally read `state` without depending on all of it, and dependency arrays
      // built with `.join("|")` to hand-roll a deep compare. Making them errors today would force
      // either a rushed restructure or a row of disable comments, and a disable comment is how a
      // finding stops being visible. As warnings they are printed on every lint run and tracked as
      // their own piece of work.
      "react-hooks/exhaustive-deps": "warn"
    }
  }
];
