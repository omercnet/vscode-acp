import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const DEMO_DIR = join(VSCODE_TEST_DIR, "session-transition-demo");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");

const AGENT_SOURCE = `#!/usr/bin/env node
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const promptsBySession = new Map();
let sessionCounter = 0;
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
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    } else if (message.method === "session/new") {
      const sessionId = "transition-demo-" + ++sessionCounter;
      setTimeout(() => {
        if (process.env.VSCODE_ACP_FAIL_SESSION === "1") {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Sign in to continue" } });
        } else {
          send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: null } });
        }
      }, 1800);
    } else if (message.method === "session/load") {
      const sessionId = params.sessionId;
      setTimeout(() => {
        const text = promptsBySession.get(sessionId) || "Saved prompt";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "user_message_chunk", messageId: "saved-user", content: { type: "text", text } } } });
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "saved-agent", content: { type: "text", text: "Saved reply" } } } });
        send({ jsonrpc: "2.0", id: message.id, result: { modes: null } });
      }, 1200);
    } else if (message.method === "session/prompt") {
      const text = params.prompt[0].text;
      promptsBySession.set(params.sessionId, text);
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "agent-1", content: { type: "text", text: "Ready " + params.sessionId + ": " + text } } } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function launchHost(
  userDataName: string,
  failSession = false
): Promise<ElectronApplication> {
  const userDataDir = join(DEMO_DIR, userDataName);
  const settingsDir = join(userDataDir, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": "Default Dark+",
      "window.titleBarStyle": "custom",
    })
  );
  const executablePath = await findVSCodeExecutable();
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
    env: {
      ...process.env,
      VSCODE_ACP_TEST_AGENT_COMMAND: AGENT_PATH,
      VSCODE_ACP_FAIL_SESSION: failSession ? "1" : "0",
      VSCODE_SKIP_PRELAUNCH: "1",
    },
  });
}

async function openChatView(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await window.setViewportSize({ width: 1280, height: 800 });
  await window.waitForTimeout(3000);
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  await window.waitForTimeout(500);
  await window.keyboard.type("VSCode ACP: Focus on Chat View");
  await window.waitForTimeout(300);
  await window.keyboard.press("Enter");
  await window.waitForTimeout(3000);
  return window
    .frameLocator("iframe.webview")
    .first()
    .frameLocator("#active-frame");
}

async function runCommand(window: Page, command: string): Promise<void> {
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  await window.waitForTimeout(300);
  await window.keyboard.type(command);
  await window.waitForTimeout(300);
  await window.keyboard.press("Enter");
}

test.beforeAll(async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
});

test.afterAll(async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
});

test("locks drafted input until connection and session creation finish", async () => {
  const host = await launchHost("success");
  try {
    const window = await host.firstWindow();
    const frame = await openChatView(window);
    const input = frame.locator("#input");
    const send = frame.locator("#send");

    await input.fill("Continue after setup");
    await input.focus();
    await frame.locator("#connect-btn").click();

    await expect(input).toBeDisabled();
    await expect(send).toBeDisabled();
    await expect(frame.locator("#input-container")).toHaveAttribute(
      "aria-busy",
      "true"
    );
    await expect(frame.locator("#input-hint")).toContainText("Connecting");
    await frame.locator("body").screenshot({
      path: join(SCREENSHOTS_DIR, "session-transition-locked.png"),
    });

    await expect(input).toBeEnabled({ timeout: 10000 });
    await expect(input).toHaveValue("Continue after setup");
    expect(
      await input.evaluate((element) => element === document.activeElement)
    ).toBe(true);
    await input.press("Enter");
    await expect(
      frame.getByText("Ready transition-demo-1: Continue after setup")
    ).toBeVisible();
    await expect(
      frame.getByText("Session creation already in progress")
    ).toHaveCount(0);
  } finally {
    await host.close();
  }
});

test("recovers usable controls with a classified session creation error", async () => {
  const host = await launchHost("failure", true);
  try {
    const window = await host.firstWindow();
    const frame = await openChatView(window);
    const input = frame.locator("#input");

    await input.fill("Keep this draft");
    await frame.locator("#connect-btn").click();
    await expect(input).toBeDisabled();
    await expect(
      frame.locator(".message.error", {
        hasText: "Authentication required: Sign in to continue",
      })
    ).toBeVisible({ timeout: 10000 });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("Keep this draft");
    await expect(frame.locator("#input-container")).toHaveAttribute(
      "aria-busy",
      "false"
    );
    expect(
      await input.evaluate((element) => element === document.activeElement)
    ).toBe(true);
    await frame.locator("body").screenshot({
      path: join(SCREENSHOTS_DIR, "session-transition-recovered.png"),
    });
    await expect(
      frame.getByText("Session creation already in progress")
    ).toHaveCount(0);
  } finally {
    await host.close();
  }
});

test("serializes replacement during initial session creation", async () => {
  const host = await launchHost("replacement");
  try {
    const window = await host.firstWindow();
    const frame = await openChatView(window);
    const input = frame.locator("#input");

    await input.fill("Draft survives replacement");
    await frame.locator("#connect-btn").click();
    await expect(frame.locator("#status-text")).toHaveText("Connected", {
      timeout: 10000,
    });
    await expect(input).toBeDisabled();

    await runCommand(window, "ACP: New Chat");
    await expect(input).toBeEnabled({ timeout: 10000 });
    await expect(input).toHaveValue("Draft survives replacement");

    await input.fill("Replacement prompt");
    await input.press("Enter");
    await expect(
      frame.getByText("Ready transition-demo-2: Replacement prompt")
    ).toBeVisible();
    await expect(
      frame.getByText("Session creation already in progress")
    ).toHaveCount(0);
  } finally {
    await host.close();
  }
});

test("locks and targets the restored session during load", async () => {
  const host = await launchHost("restore");
  try {
    const window = await host.firstWindow();
    const frame = await openChatView(window);
    const input = frame.locator("#input");

    await frame.locator("#connect-btn").click();
    await expect(input).toBeEnabled({ timeout: 10000 });
    await input.fill("Remember me");
    await input.press("Enter");
    await expect(
      frame.getByText("Ready transition-demo-1: Remember me")
    ).toBeVisible();

    await runCommand(window, "ACP: New Chat");
    await expect(input).toBeDisabled();
    await expect(input).toBeEnabled({ timeout: 10000 });
    await input.fill("Continue loaded");

    await runCommand(window, "ACP: Load Session");
    const savedSession = frame.getByRole("button", {
      name: "Load Remember me",
    });
    await expect(savedSession).toBeVisible();
    await savedSession.click();

    await expect(input).toBeDisabled();
    await expect(frame.locator("#input-container")).toHaveAttribute(
      "aria-busy",
      "true"
    );
    await expect(frame.getByText("Conversation restored.")).toBeVisible({
      timeout: 10000,
    });
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue("Continue loaded");

    await input.press("Enter");
    await expect(
      frame.getByText("Ready transition-demo-1: Continue loaded")
    ).toBeVisible();
  } finally {
    await host.close();
  }
});
