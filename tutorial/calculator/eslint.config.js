import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

/**
 * Review rules for the kata, chosen so a validator can cite a rule name and a line
 * instead of an opinion. The limits mark out the well-factored destination the
 * success criteria describe, so the messy starting code is expected to report
 * findings: each one names a seam the doer can remove.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "eslint.config.js"] },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Reveals intention: small units with shallow control flow. The thresholds are
      // deliberately tight so a smell reports while it is still small, rather than
      // only once a function has grown past rescuing. A well-factored calculator
      // clears them; the starting code does not.
      complexity: ["error", { max: 5 }],
      "sonarjs/cognitive-complexity": ["error", 5],
      "max-depth": ["error", 2],
      "max-lines-per-function": ["error", { max: 20, skipBlankLines: true, skipComments: true }],
      "max-statements": ["error", 12],
      "max-params": ["error", 3],
      // No duplication: structural repetition that token-based tools miss.
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-duplicated-branches": "error",
      "no-duplicate-imports": "error"
    }
  }
);
