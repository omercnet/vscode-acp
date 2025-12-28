#!/usr/bin/env node
import { _electron as electron } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdir, writeFile, readdir } from "fs/promises";
import { platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const USER_DATA_DIR = join(PROJECT_ROOT, ".vscode-test/user-data");
const VSCODE_TEST_DIR = join(PROJECT_ROOT, ".vscode-test");

const TIMING = {
  VSCODE_INIT: 5000,
  COMMAND_PALETTE_OPEN: 500,
  COMMAND_TYPE: 300,
  COMMAND_EXECUTE: 2000,
};

const SCREENSHOT_CLIP = {
  ACTIVITY_BAR_WIDTH: 48,
  TITLE_BAR_HEIGHT: 35,
  SIDEBAR_WIDTH: 305,
  STATUS_BAR_HEIGHT: 25,
};

async function findVSCodeExecutable() {
  const entries = await readdir(VSCODE_TEST_DIR);
  const vscodeDir = entries.find((e) => e.startsWith("vscode-"));

  if (!vscodeDir) {
    throw new Error(
      "VS Code not found in .vscode-test/. Run 'npm test' first to download it."
    );
  }

  const currentPlatform = platform();

  if (currentPlatform === "darwin") {
    return join(
      VSCODE_TEST_DIR,
      vscodeDir,
      "Visual Studio Code.app/Contents/MacOS/Electron"
    );
  } else if (currentPlatform === "linux") {
    return join(VSCODE_TEST_DIR, vscodeDir, "code");
  } else if (currentPlatform === "win32") {
    return join(VSCODE_TEST_DIR, vscodeDir, "Code.exe");
  }

  throw new Error(`Unsupported platform: ${currentPlatform}`);
}

function cmdOrCtrl() {
  return platform() === "darwin" ? "Meta" : "Control";
}

async function takeScreenshot() {
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const settingsDir = join(USER_DATA_DIR, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": "Default Light+",
      "window.titleBarStyle": "custom",
    })
  );

  const vscodePath = await findVSCodeExecutable();
  console.log("Launching VS Code:", vscodePath);

  const electronApp = await electron.launch({
    executablePath: vscodePath,
    args: [
      "--extensionDevelopmentPath=" + PROJECT_ROOT,
      "--user-data-dir=" + USER_DATA_DIR,
      "--disable-extensions",
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

  const window = await electronApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.setViewportSize({ width: 1280, height: 800 });
  await window.waitForTimeout(TIMING.VSCODE_INIT);

  try {
    console.log("Opening ACP view via command...");

    const modifier = cmdOrCtrl();
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.waitForTimeout(TIMING.COMMAND_PALETTE_OPEN);
    await window.keyboard.type("View: Focus on Chat View");
    await window.waitForTimeout(TIMING.COMMAND_TYPE);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(TIMING.COMMAND_EXECUTE);

    const viewport = window.viewportSize();
    console.log("Viewport:", viewport);

    console.log("Taking cropped ACP sidebar screenshot...");
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "acp-sidebar.png"),
      clip: {
        x: SCREENSHOT_CLIP.ACTIVITY_BAR_WIDTH,
        y: SCREENSHOT_CLIP.TITLE_BAR_HEIGHT,
        width: SCREENSHOT_CLIP.SIDEBAR_WIDTH,
        height:
          viewport.height -
          SCREENSHOT_CLIP.TITLE_BAR_HEIGHT -
          SCREENSHOT_CLIP.STATUS_BAR_HEIGHT,
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
