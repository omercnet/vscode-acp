import {
  test,
  expect,
  _electron as electron,
  type Frame,
  type Page,
} from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { spawn } from "child_process";
import { once } from "events";
import { tmpdir } from "os";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  closeVSCode,
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const DEMO_DIR = join(VSCODE_TEST_DIR, "agent-resolution-demo");
const USER_DATA_DIR = join(VSCODE_TEST_DIR, "user-data-agent-resolution");
const WORKSPACE_DIR = join(DEMO_DIR, "untrusted-workspace");
const AGENT_COMMAND =
  process.platform === "win32" ? "opencode.cmd" : "opencode";
const WORKSPACE_PAYLOAD = join(WORKSPACE_DIR, "tools", AGENT_COMMAND);
const TRUSTED_AGENT = join(DEMO_DIR, "trusted-install", "bin", AGENT_COMMAND);
const SCREENSHOT_PATH = join(
  PROJECT_ROOT,
  "screenshots",
  "restricted-mode-agent-resolution.png"
);

/**
 * A minimal ACP agent that reports the executable the extension launched, so
 * the rendered reply identifies which binary actually ran.
 */
const agentSource = (label: string) => `#!/usr/bin/env node
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const params = message.params || {};
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "agent-resolution", modes: null } });
    } else if (message.method === "session/prompt") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "agent-1",
            content: { type: "text", text: "${label} running from " + __filename.replace(/\\\\/g, "/") },
          },
        },
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function writeAgent(commandPath: string, label: string): Promise<void> {
  if (process.platform !== "win32") {
    await writeFile(commandPath, agentSource(label), { mode: 0o755 });
    return;
  }

  const scriptPath = join(dirname(commandPath), "agent.js");
  await writeFile(scriptPath, agentSource(label));
  await writeFile(
    commandPath,
    [
      "@ECHO off",
      'SETLOCAL & SET "dp0=%~dp0"',
      'SET "_prog=node"',
      '"%_prog%" "%dp0%\\agent.js" %*',
      "",
    ].join("\r\n")
  );
}

async function launchRestrictedHost() {
  const settingsDir = join(USER_DATA_DIR, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      "window.titleBarStyle": "custom",
      "security.workspace.trust.startupPrompt": "never",
      "security.workspace.trust.banner": "always",
      "security.workspace.trust.untrustedFiles": "open",
      "vscode-acp.agentPaths": { opencode: TRUSTED_AGENT },
    })
  );
  const executablePath = await findVSCodeExecutable();
  return electron.launch({
    executablePath,
    args: [
      `--extensionDevelopmentPath=${PROJECT_ROOT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      "--disable-gpu-sandbox",
      "--no-sandbox",
      "--skip-release-notes",
      "--skip-welcome",
      "--disable-telemetry",
      "--window-position=-2000,-2000",
      WORKSPACE_DIR,
    ],
    timeout: 60000,
    env: { ...process.env, VSCODE_SKIP_PRELAUNCH: "1" },
  });
}

async function focusChat(window: Page): Promise<Frame> {
  await window.waitForLoadState("domcontentloaded");
  await window.setViewportSize({ width: 1280, height: 800 });
  await expect(window.getByRole("tab", { name: "VSCode ACP" })).toBeVisible({
    timeout: 30000,
  });
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  const commandInput = window.locator(".quick-input-widget input");
  await expect(commandInput).toBeVisible({ timeout: 30000 });
  await commandInput.fill(">ACP: Start Chat");
  const command = window
    .locator('.quick-input-list [role="option"]')
    .filter({ hasText: "ACP: Start Chat" })
    .first();
  await expect(command).toBeVisible({ timeout: 30000 });
  await commandInput.press("Enter");

  let chatFrame: Frame | null = null;
  await expect
    .poll(
      async () => {
        for (const frame of window.frames()) {
          if (frame.isDetached()) {
            continue;
          }
          try {
            if ((await frame.locator("#input").count()) > 0) {
              chatFrame = frame;
              return true;
            }
          } catch (error) {
            if (!frame.isDetached()) {
              throw error;
            }
          }
        }
        return false;
      },
      { timeout: 30000 }
    )
    .toBe(true);

  if (!chatFrame || (chatFrame as Frame).isDetached()) {
    throw new Error("ACP chat frame disappeared after becoming ready");
  }
  return chatFrame;
}

test("ignores a workspace executable override in Restricted Mode", async ({}, testInfo) => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await rm(USER_DATA_DIR, { recursive: true, force: true });
  await mkdir(join(WORKSPACE_DIR, ".vscode"), { recursive: true });
  await mkdir(join(WORKSPACE_DIR, "tools"), { recursive: true });
  await mkdir(join(DEMO_DIR, "trusted-install", "bin"), { recursive: true });
  await writeFile(join(WORKSPACE_DIR, "README.md"), "# untrusted repository\n");
  await writeFile(
    join(WORKSPACE_DIR, ".vscode", "settings.json"),
    JSON.stringify({ "vscode-acp.agentPaths": { opencode: WORKSPACE_PAYLOAD } })
  );
  await writeAgent(WORKSPACE_PAYLOAD, "MALICIOUS-WORKSPACE-AGENT");
  await writeAgent(TRUSTED_AGENT, "TRUSTED-AGENT");

  const host = await launchRestrictedHost();
  try {
    const window = await host.firstWindow();
    const frame = await focusChat(window);
    await expect(frame.locator("#connect-btn")).toBeHidden({ timeout: 30000 });
    await frame.locator("#input").fill("Which executable is running you?");
    await frame.locator("#input").press("Enter");

    await expect(
      frame
        .locator(".message.assistant")
        .filter({ hasText: "TRUSTED-AGENT running from" })
    ).toContainText(dirname(TRUSTED_AGENT).replace(/\\/g, "/"));
    await expect(frame.getByText("MALICIOUS-WORKSPACE-AGENT")).toHaveCount(0);

    await window.waitForTimeout(500);
    await window.screenshot({ path: SCREENSHOT_PATH });
    await window.screenshot({
      path: testInfo.outputPath("restricted-mode-agent-resolution.png"),
    });
  } finally {
    await closeVSCode(host);
    await rm(DEMO_DIR, { recursive: true, force: true });
    await rm(USER_DATA_DIR, { recursive: true, force: true });
  }
});

test("waits for Windows child handles before deleting host files", async () => {
  test.skip(process.platform !== "win32", "Windows exclusive file handles");
  const directory = await mkdtemp(join(tmpdir(), "vscode-acp-host-exit-"));
  const lockedPath = join(directory, "agenthost.log");
  const powershell = join(
    process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const child = spawn(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "$file=[System.IO.File]::Open($env:VSCODE_E2E_LOCK_FILE,'OpenOrCreate','ReadWrite','None')",
        "try{[Console]::WriteLine('locked');[Console]::ReadLine() | Out-Null}finally{$file.Dispose()}",
      ].join(";"),
    ],
    {
      env: { ...process.env, VSCODE_E2E_LOCK_FILE: lockedPath },
      windowsHide: true,
      stdio: ["pipe", "pipe", "inherit"],
    }
  );
  try {
    const [ready] = await once(child.stdout, "data");
    expect(ready.toString()).toContain("locked");
    // The wrapper can report close while the actual child still owns a file.
    const host = {
      evaluate: async () => [child.pid],
      close: async () => {
        child.stdin.end("\n");
      },
    } as unknown as ElectronApplication;
    await closeVSCode(host);
    expect(child.exitCode).toBe(0);
    await rm(lockedPath);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
