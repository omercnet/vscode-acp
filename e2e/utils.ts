import { join } from "path";
import { readdir } from "fs/promises";
import { platform } from "os";

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

/**
 * Returns the platform-appropriate modifier key for keyboard shortcuts.
 * Meta (Cmd) on macOS, Control on Linux/Windows.
 */
export function cmdOrCtrl(): string {
  return platform() === "darwin" ? "Meta" : "Control";
}
