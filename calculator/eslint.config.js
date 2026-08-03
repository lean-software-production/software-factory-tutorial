import sonarjs from "eslint-plugin-sonarjs";
import tseslint from "typescript-eslint";

/**
 * Review rules for the kata, chosen so a reviewer can cite a rule name and a line
 * instead of an opinion. The limits describe the well-factored destination in
 * factory/success.md, so the messy starting code is expected to report findings:
 * each one names a seam the doer can remove.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "eslint.config.js"] },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Reveals intention: small units with shallow control flow.
      complexity: ["error", { max: 8 }],
      "max-depth": ["error", 3],
      "max-lines-per-function": ["error", { max: 40, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 4],
      // No duplication: structural repetition that token-based tools miss.
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-duplicated-branches": "error",
      "no-duplicate-imports": "error"
    }
  }
);
