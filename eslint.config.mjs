// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["src/**/*.ts"],
      rules: {
        // Privileged Zotero modules intentionally use an ES5-style `var`
        // vocabulary and @ts-nocheck while they are migrated incrementally.
        "@typescript-eslint/ban-ts-comment": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "no-empty": ["error", { allowEmptyCatch: true }],
        "no-var": "off",
      },
    },
    {
      files: ["addon/content/preferences.js"],
      rules: {
        // Preference UI handlers are best-effort and deliberately ignore
        // unavailable Zotero APIs in older versions.
        "no-empty": ["error", { allowEmptyCatch: true }],
        "no-unused-vars": ["error", { caughtErrors: "none" }],
      },
    },
    {
      files: ["test/**/*.mjs"],
      languageOptions: {
        globals: {
          Buffer: "readonly",
          console: "readonly",
          setTimeout: "readonly",
        },
      },
    },
  ],
});
