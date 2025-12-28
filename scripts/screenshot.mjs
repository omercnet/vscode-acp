#!/usr/bin/env node
/**
 * Takes screenshots of the VS Code extension for PR documentation.
 * Uses Playwright's Electron support to launch VS Code with the extension.
 */

import { _electron as electron } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdir } from "fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const USER_DATA_DIR = join(PROJECT_ROOT, ".vscode-test/user-data");
const EXTENSIONS_DIR = join(PROJECT_ROOT, ".vscode-test/extensions");

const VSCODE_PATH = join(
  PROJECT_ROOT,
  ".vscode-test/vscode-darwin-arm64-1.107.1/Visual Studio Code.app/Contents/MacOS/Electron"
);

async function takeScreenshots() {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  console.log("Launching VS Code with extension...");

  const electronApp = await electron.launch({
    executablePath: VSCODE_PATH,
    args: [
      "--extensionDevelopmentPath=" + PROJECT_ROOT,
      "--user-data-dir=" + USER_DATA_DIR,
      "--disable-extensions", // Disable ALL other extensions (Copilot, etc)
      "--disable-gpu-sandbox",
      "--no-sandbox",
      "--disable-workspace-trust",
      "--skip-release-notes",
      "--skip-welcome",
      "--disable-telemetry",
      PROJECT_ROOT,
    ],
    timeout: 60000,
    env: {
      ...process.env,
      VSCODE_SKIP_PRELAUNCH: "1",
    },
  });

  electronApp.on("close", () => console.log("App closed"));

  console.log("Waiting for VS Code to load...");

  // Wait for the main window
  const window = await electronApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Set a known viewport size
  await window.setViewportSize({ width: 1280, height: 800 });

  // Give VS Code time to fully initialize
  await window.waitForTimeout(5000);

  console.log("Taking main window screenshot...");
  await window.screenshot({
    path: join(SCREENSHOTS_DIR, "vscode-main.png"),
    fullPage: true,
  });

  // Focus the ACP sidebar using VS Code command
  try {
    console.log("Opening ACP view via command...");

    // Use command palette to focus the ACP chat view
    await window.keyboard.press("Meta+Shift+P");
    await window.waitForTimeout(500);
    await window.keyboard.type("View: Focus on Chat View");
    await window.waitForTimeout(300);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(2000);

    // Get viewport and crop to left sidebar where the ACP view lives
    const viewport = window.viewportSize();
    console.log("Viewport:", viewport);

    // The ACP view is in the primary sidebar (left side)
    // Crop starting after the activity bar (~48px)
    console.log("Taking cropped ACP sidebar screenshot...");
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "acp-sidebar.png"),
      clip: {
        x: 48, // After activity bar
        y: 0, // Include title
        width: 350,
        height: viewport.height - 25, // Skip status bar
      },
    });
  } catch (e) {
    console.log("Could not interact with ACP sidebar:", e.message);
  }

  // Get all windows (might have webview windows)
  const windows = electronApp.windows();
  console.log(`Found ${windows.length} windows`);

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const title = await w.title();
    console.log(`Window ${i}: ${title}`);
    await w.screenshot({
      path: join(SCREENSHOTS_DIR, `window-${i}.png`),
    });
  }

  console.log("Closing VS Code...");
  await electronApp.close();

  console.log(`Screenshots saved to ${SCREENSHOTS_DIR}/`);
}

async function takeAnsiDemoScreenshot() {
  // This creates an HTML demo of ANSI colors for PR documentation
  // Since we can't easily trigger real terminal output, we'll document
  // the feature with a standalone demo
  const { chromium } = await import("@playwright/test");

  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Create a demo HTML showing ANSI color rendering
  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          background: #1e1e1e;
          color: #cccccc;
          font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
          padding: 20px;
          font-size: 14px;
        }
        .tool-output {
          background: #252526;
          padding: 12px;
          border-radius: 4px;
          margin: 10px 0;
          white-space: pre-wrap;
        }
        .terminal { background: #1e1e1e; }
        .ansi-black { color: #000000; }
        .ansi-red { color: #cd3131; }
        .ansi-green { color: #0dbc79; }
        .ansi-yellow { color: #e5e510; }
        .ansi-blue { color: #2472c8; }
        .ansi-magenta { color: #bc3fbc; }
        .ansi-cyan { color: #11a8cd; }
        .ansi-white { color: #e5e5e5; }
        .ansi-bright-black { color: #666666; }
        .ansi-bright-red { color: #f14c4c; }
        .ansi-bright-green { color: #23d18b; }
        .ansi-bright-yellow { color: #f5f543; }
        .ansi-bright-blue { color: #3b8eea; }
        .ansi-bright-magenta { color: #d670d6; }
        .ansi-bright-cyan { color: #29b8db; }
        .ansi-bright-white { color: #ffffff; }
        .ansi-bold { font-weight: bold; }
        .ansi-dim { opacity: 0.7; }
        .ansi-italic { font-style: italic; }
        .ansi-underline { text-decoration: underline; }
        h3 { color: #569cd6; margin-bottom: 8px; }
        .tool-status { margin-right: 8px; }
      </style>
    </head>
    <body>
      <h3>🔧 Tool: npm test</h3>
      <pre class="tool-output terminal"><span class="ansi-bright-green ansi-bold">✓</span> <span class="ansi-green">Webview</span>
  <span class="ansi-bright-green">✓</span> escapeHtml
    <span class="ansi-dim">✓ escapes ampersands</span>
    <span class="ansi-dim">✓ escapes less than</span>
    <span class="ansi-dim">✓ escapes greater than</span>
  <span class="ansi-bright-green">✓</span> ansiToHtml
    <span class="ansi-dim">✓ converts red foreground color</span>
    <span class="ansi-dim">✓ converts bold style</span>
    <span class="ansi-dim">✓ handles combined styles</span>

<span class="ansi-bright-green ansi-bold">127 passing</span> <span class="ansi-dim">(233ms)</span></pre>

      <h3>🔧 Tool: eslint --fix</h3>
      <pre class="tool-output terminal"><span class="ansi-bright-yellow">⚠</span> <span class="ansi-yellow">warning</span>  Unexpected console statement  <span class="ansi-dim">no-console</span>
<span class="ansi-bright-red">✖</span> <span class="ansi-red">error</span>    'foo' is defined but never used  <span class="ansi-dim">@typescript-eslint/no-unused-vars</span>

<span class="ansi-yellow">1 warning</span>, <span class="ansi-red">1 error</span></pre>

      <h3>🔧 Tool: git diff --stat</h3>
      <pre class="tool-output terminal"> src/views/webview/<span class="ansi-bold">main.ts</span> | <span class="ansi-green">+128</span> <span class="ansi-red">-1</span>
 media/<span class="ansi-bold">main.css</span>            | <span class="ansi-green">+118</span>
 src/test/<span class="ansi-bold">webview.test.ts</span>  | <span class="ansi-green">+189</span>
 <span class="ansi-cyan">3 files changed</span>, <span class="ansi-green">434 insertions(+)</span>, <span class="ansi-red">1 deletion(-)</span></pre>
    </body>
    </html>
  `);

  await page.screenshot({
    path: join(SCREENSHOTS_DIR, "ansi-demo.png"),
    fullPage: true,
  });

  await browser.close();
  console.log("ANSI demo screenshot saved");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--ansi-only")) {
    await takeAnsiDemoScreenshot();
  } else if (args.includes("--vscode-only")) {
    await takeScreenshots();
  } else {
    await takeScreenshots();
    await takeAnsiDemoScreenshot();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
