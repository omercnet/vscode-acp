import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/**/*.test.js",
  // Terminal containment, workspace trust, and approved execution are only
  // reachable with a real local workspace root, so the harness always opens
  // one instead of leaving those tests pending.
  workspaceFolder: "./src/test/fixtures/workspace",
  launchArgs: ["--disable-workspace-trust"],
  mocha: {
    ui: "tdd",
    timeout: 20000,
  },
  coverage: {
    include: ["src/**/*.ts"],
    exclude: ["src/test/**", "**/*.d.ts"],
    reporter: ["text", "lcov"],
  },
});
