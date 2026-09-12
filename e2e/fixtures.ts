import {
  test as base,
  _electron as electron,
  ElectronApplication,
  Page,
  FrameLocator,
  Frame,
} from "@playwright/test";
import { join } from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { findVSCodeExecutable, cmdOrCtrl, PROJECT_ROOT } from "./utils";

const USER_DATA_DIR = join(PROJECT_ROOT, ".vscode-test/user-data-e2e");
const EXTENSIONS_DIR = join(PROJECT_ROOT, ".vscode-test/extensions-e2e");

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
    await rm(EXTENSIONS_DIR, { recursive: true, force: true });
    await mkdir(EXTENSIONS_DIR, { recursive: true });
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
        "--extensions-dir=" + EXTENSIONS_DIR,
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
  await window.keyboard.type("VSCode ACP: Focus on Chat View");
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

/**
 * Locates the webview's underlying content `Frame` (as opposed to the
 * `FrameLocator` proxy from `getWebviewFrame`), which is required for APIs
 * like `frame.evaluate` that need a live frame handle.
 */
export async function getWebviewContentFrame(window: Page): Promise<Frame> {
  const allFrames: Frame[] = [];

  function collectFrames(frameList: Frame[]) {
    for (const f of frameList) {
      allFrames.push(f);
      collectFrames(f.childFrames());
    }
  }
  collectFrames(window.frames());

  for (const frame of allFrames) {
    try {
      const hasWelcomeView = await frame.locator("#welcome-view").count();
      if (hasWelcomeView > 0) {
        return frame;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Webview content frame not found");
}

export { expect } from "@playwright/test";
export { cmdOrCtrl } from "./utils";
