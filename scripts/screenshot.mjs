#!/usr/bin/env node
/**
 * Takes screenshots of the VS Code extension for PR documentation.
 * Uses Playwright's Electron support to launch VS Code with the extension.
 */

import { _electron as electron } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdir, writeFile } from "fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const USER_DATA_DIR = join(PROJECT_ROOT, ".vscode-test/user-data");

const VSCODE_PATH = join(
  PROJECT_ROOT,
  ".vscode-test/vscode-darwin-arm64-1.107.1/Visual Studio Code.app/Contents/MacOS/Electron"
);

async function takeScreenshot() {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  // Set up VS Code settings for light theme
  const settingsDir = join(USER_DATA_DIR, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify(
      {
        "workbench.colorTheme": "Default Light+",
        "window.titleBarStyle": "custom",
      },
      null,
      2
    )
  );

  console.log("Launching VS Code with extension (light theme)...");

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
        y: 35, // Skip title bar
        width: 305, // Sidebar width to divider line
        height: viewport.height - 60, // Skip title bar and status bar
      },
    });
  } catch (e) {
    console.log("Could not interact with ACP sidebar:", e.message);
  }

  console.log("Closing VS Code...");
  await electronApp.close();

  console.log(`Screenshot saved to ${SCREENSHOTS_DIR}/acp-sidebar.png`);
}

takeScreenshot().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
