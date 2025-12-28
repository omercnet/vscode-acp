import {
  test as base,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";

const PROJECT_ROOT = join(__dirname, "..");
const USER_DATA_DIR = join(PROJECT_ROOT, ".vscode-test/user-data-e2e");
const VSCODE_PATH = join(
  PROJECT_ROOT,
  ".vscode-test/vscode-darwin-arm64-1.107.1/Visual Studio Code.app/Contents/MacOS/Electron"
);

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

    const electronApp = await electron.launch({
      executablePath: VSCODE_PATH,
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
    await window.waitForTimeout(3000);
    await use(window);
  },
});

export { expect } from "@playwright/test";
