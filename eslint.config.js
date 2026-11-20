import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "runner/package/agent",
      ".wrangler",
      "worker-configuration.d.ts",
      "playwright-report",
      "test-results",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  },
  { files: ["agent/**/*.cjs"], rules: { "@typescript-eslint/no-require-imports": "off" } },
  {
    files: [
      "runner/**/*.mjs",
      "scripts/**/*.mjs",
      "agent/**/*.mjs",
      "packages/**/*.mjs",
      "agent/**/*.cjs",
      "selfhost/**/*.mjs",
      "*.config.js",
    ],
    languageOptions: {
      globals: {
        console: "readonly",
        require: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        performance: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Response: "readonly",
      },
    },
  },
);
