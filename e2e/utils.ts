import { join } from "path";
import { readdir } from "fs/promises";
import { platform } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import type { ElectronApplication } from "@playwright/test";

const execFileAsync = promisify(execFile);

/** Wait for the Electron children, not just Playwright's Windows cmd wrapper. */
export async function closeVSCode(host: ElectronApplication): Promise<void> {
  const processIds =
    process.platform === "win32"
      ? await host.evaluate(({ app }) =>
          app.getAppMetrics().map(({ pid }) => pid)
        )
      : [];
  await host.close();
  if (processIds.length === 0) {
    return;
  }

  const powershell = join(
    process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const script = [
    "$ErrorActionPreference='Stop'",
    "foreach($processId in $env:VSCODE_E2E_PROCESS_IDS.Split(',')){",
    "try{$owned=[System.Diagnostics.Process]::GetProcessById([int]$processId)}catch [System.ArgumentException]{continue}",
    "try{if(-not $owned.WaitForExit(10000)){throw 'VS Code child did not exit before cleanup'}}finally{$owned.Dispose()}",
    "}",
  ].join("\n");
  await execFileAsync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, VSCODE_E2E_PROCESS_IDS: processIds.join(",") },
      windowsHide: true,
      timeout: 20000,
    }
  );
}

export const PROJECT_ROOT = join(__dirname, "..");
export const VSCODE_TEST_DIR = join(PROJECT_ROOT, ".vscode-test");

/**
 * Find the VS Code executable path based on the current platform.
 * Looks in .vscode-test/ for a downloaded VS Code instance.
 */
export async function findVSCodeExecutable(): Promise<string> {
  const entries = await readdir(VSCODE_TEST_DIR);
  const vscodeDir = entries.find((e) => e.startsWith("vscode-"));

  if (!vscodeDir) {
    throw new Error(
      "VS Code not found in .vscode-test/. Run 'npm test' first to download it."
    );
  }

  const installation = join(VSCODE_TEST_DIR, vscodeDir);
  const currentPlatform = platform();

  if (currentPlatform === "win32") {
    return join(installation, "Code.exe");
  }
  if (currentPlatform === "linux") {
    return join(installation, "code");
  }
  if (currentPlatform !== "darwin") {
    throw new Error(`Unsupported platform: ${currentPlatform}`);
  }

  // The macOS bundle and its Electron binary have both been renamed across
  // releases, so read the actual names instead of hardcoding them.
  const bundle = (await readdir(installation)).find((entry) =>
    entry.endsWith(".app")
  );
  if (!bundle) {
    throw new Error(`No VS Code application bundle in ${installation}`);
  }

  const binaryDir = join(installation, bundle, "Contents", "MacOS");
  const binaries = await readdir(binaryDir, { withFileTypes: true });
  const binary =
    binaries.find((entry) => entry.name === "Electron" || entry.name === "Code")
      ?.name ?? binaries.find((entry) => entry.isFile())?.name;
  if (!binary) {
    throw new Error(`No VS Code executable in ${binaryDir}`);
  }

  return join(binaryDir, binary);
}

/**
 * Returns the platform-appropriate modifier key for keyboard shortcuts.
 * Meta (Cmd) on macOS, Control on Linux/Windows.
 */
export function cmdOrCtrl(): string {
  return platform() === "darwin" ? "Meta" : "Control";
}
