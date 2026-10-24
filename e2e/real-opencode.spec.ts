import {
  expect,
  _electron as electron,
  test,
  type Frame,
  type Page,
} from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import {
  closeVSCode,
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
} from "./utils";

const enabled = process.env.VSCODE_ACP_REAL_OPENCODE === "1";
const agentPath = process.env.VSCODE_ACP_REAL_OPENCODE_PATH;
let userDataDir: string;

async function launchHost() {
  const settingsDir = join(userDataDir, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      "window.titleBarStyle": "custom",
      "vscode-acp.agentPaths": { opencode: agentPath },
    })
  );
  const executablePath = await findVSCodeExecutable();
  const { VSCODE_ACP_TEST_AGENT_COMMAND: _, ...environment } = process.env;
  return electron.launch({
    executablePath,
    args: [
      `--extensionDevelopmentPath=${PROJECT_ROOT}`,
      `--user-data-dir=${userDataDir}`,
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
    env: { ...environment, VSCODE_SKIP_PRELAUNCH: "1" },
  });
}

async function openChat(window: Page): Promise<Frame> {
  await window.waitForLoadState("domcontentloaded");
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  const commandInput = window.locator(".quick-input-widget input");
  await expect(commandInput).toBeVisible({ timeout: 30000 });
  await commandInput.fill(">ACP: Start Chat");
  await commandInput.press("Enter");

  let frame: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const candidate of window.frames()) {
          if (
            !candidate.isDetached() &&
            (await candidate.locator("#input").count()) > 0
          ) {
            frame = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 30000 }
    )
    .toBe(true);
  if (!frame) {
    throw new Error("ACP chat frame did not become ready");
  }
  return frame;
}

test("completes an ACP turn through the configured real OpenCode agent", async () => {
  test.skip(
    !enabled,
    "set VSCODE_ACP_REAL_OPENCODE=1 to run real-provider smoke tests"
  );
  test.skip(
    !agentPath || !isAbsolute(agentPath),
    "set VSCODE_ACP_REAL_OPENCODE_PATH to an absolute OpenCode executable"
  );

  userDataDir = await mkdtemp(join(tmpdir(), "vscode-acp-real-opencode-"));
  const host = await launchHost();
  try {
    const frame = await openChat(await host.firstWindow());
    await expect(frame.locator("#input")).toBeEnabled({ timeout: 60000 });
    await frame.locator("#input").fill("Reply with one short acknowledgement.");
    await frame.locator("#input").press("Enter");
    await expect(frame.locator(".message.assistant").last()).toBeVisible({
      timeout: 120000,
    });
    await expect(frame.locator("#input")).toBeEnabled({ timeout: 120000 });
  } finally {
    await closeVSCode(host);
    await rm(userDataDir, { recursive: true, force: true });
  }
});
