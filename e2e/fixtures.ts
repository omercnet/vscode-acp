import {
  test as base,
  _electron as electron,
  ElectronApplication,
  Page,
  FrameLocator,
} from "@playwright/test";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { findVSCodeExecutable, cmdOrCtrl, PROJECT_ROOT } from "./utils";

const USER_DATA_DIR = join(PROJECT_ROOT, ".vscode-test/user-data-e2e");

const TIMING = {
  VSCODE_INIT: 3000,
  COMMAND_PALETTE_OPEN: 500,
  COMMAND_TYPE: 300,
  VIEW_LOAD: 3000,
};

export type TestFixtures = {
  vscode: ElectronApplication;
  window: Page;
};

export const test = base.extend<TestFixtures>({
  vscode: async ({}, use) => {
    const settingsDir = join(USER_DATA_DIR, "User");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        "workbench.colorTheme": "Default Dark+",
        "window.titleBarStyle": "custom",
      })
    );

    const vscodePath = await findVSCodeExecutable();

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
        "--window-position=-2000,-2000",
        PROJECT_ROOT,
      ],
      timeout: 60000,
      env: {
        ...process.env,
        VSCODE_SKIP_PRELAUNCH: "1",
      },
    });

    await use(electronApp);
    await electronApp.close();
  },

  window: async ({ vscode }, use) => {
    const window = await vscode.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1280, height: 800 });
    await window.waitForTimeout(TIMING.VSCODE_INIT);
    await use(window);
  },
});

export async function openACPView(window: Page): Promise<void> {
  const modifier = cmdOrCtrl();
  await window.keyboard.press(`${modifier}+Shift+P`);
  await window.waitForTimeout(TIMING.COMMAND_PALETTE_OPEN);
  await window.keyboard.type("View: Focus on Chat View");
  await window.waitForTimeout(TIMING.COMMAND_TYPE);
  await window.keyboard.press("Enter");
  await window.waitForTimeout(TIMING.VIEW_LOAD);
}

export function getWebviewFrame(window: Page): FrameLocator {
  return window
    .frameLocator("iframe.webview")
    .first()
    .frameLocator("#active-frame");
}

export { expect } from "@playwright/test";
export { cmdOrCtrl } from "./utils";
