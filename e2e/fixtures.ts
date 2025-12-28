import {
  test as base,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import { join } from "path";
import { mkdir, writeFile, readdir } from "fs/promises";
import { platform } from "os";

const PROJECT_ROOT = join(__dirname, "..");
const USER_DATA_DIR = join(PROJECT_ROOT, ".vscode-test/user-data-e2e");
const VSCODE_TEST_DIR = join(PROJECT_ROOT, ".vscode-test");

const TIMING = {
  VSCODE_INIT: 3000,
};

async function findVSCodeExecutable(): Promise<string> {
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

export function cmdOrCtrl(): string {
  return platform() === "darwin" ? "Meta" : "Control";
}

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

export { expect } from "@playwright/test";
