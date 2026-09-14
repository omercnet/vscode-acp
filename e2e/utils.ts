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
