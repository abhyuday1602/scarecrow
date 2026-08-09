import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Node.js globals
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        globalThis: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "prefer-template": "warn",
      "no-throw-literal": "error",
    },
  },
  // browser.js runs inside the page context via Playwright evaluate()
  {
    files: ["browser.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        window: "readonly",
        getComputedStyle: "readonly",
        Node: "readonly",
        Element: "readonly",
      },
    },
  },
  // TUI files use htm tagged templates where Box/Text/Static are resolved at runtime
  {
    files: ["cli/tui/**/*.js"],
    languageOptions: {
      globals: {
        Box: "readonly",
        Text: "readonly",
        Static: "readonly",
      },
    },
  },
  {
    ignores: [
      "node_modules/",
      "runs/",
      "uploads/",
      "coverage/",
      "*.config.js",
    ],
  },
];
