import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdir, rm, writeFile } from "fs/promises";
import { delimiter, join } from "path";
import {
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const DEMO_DIR = join(VSCODE_TEST_DIR, "session-restart-demo");
const USER_DATA_DIR = join(VSCODE_TEST_DIR, "user-data-e2e");
const STORE_PATH = join(DEMO_DIR, "sessions.json");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");

const AGENT_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
const storePath = process.env.VSCODE_ACP_DEMO_STORE;
const sessions = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
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
      const sessionId = "restart-demo";
      sessions[sessionId] = sessions[sessionId] || { messages: [] };
      fs.writeFileSync(storePath, JSON.stringify(sessions));
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId, modes: null } });
    } else if (message.method === "session/prompt") {
      const prompt = params.prompt[0].text;
      const reply = "Persisted reply: " + prompt;
      sessions[params.sessionId].messages.push({ prompt, reply });
      fs.writeFileSync(storePath, JSON.stringify(sessions));
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "agent-1", content: { type: "text", text: reply } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.method === "session/load") {
      const session = sessions[params.sessionId];
      session.messages.forEach((entry, index) => {
        update(params.sessionId, { sessionUpdate: "user_message_chunk", messageId: "user-" + index, content: { type: "text", text: entry.prompt } });
        update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "agent-" + index, content: { type: "text", text: entry.reply } });
      });
      send({ jsonrpc: "2.0", id: message.id, result: { modes: null } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function launchHost() {
  const settingsDir = join(USER_DATA_DIR, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({ "window.titleBarStyle": "custom" })
  );
  const executablePath = await findVSCodeExecutable();
  return electron.launch({
    executablePath,
    args: [
      `--extensionDevelopmentPath=${PROJECT_ROOT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
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
      PATH: `${BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
      VSCODE_ACP_TEST_AGENT_COMMAND: AGENT_PATH,
      VSCODE_ACP_DEMO_STORE: STORE_PATH,
      VSCODE_SKIP_PRELAUNCH: "1",
    },
  });
}

async function focusChat(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await window.setViewportSize({ width: 1280, height: 800 });
  await window.waitForTimeout(3000);
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  await window.waitForTimeout(500);
  await window.keyboard.type("ACP: Start Chat");
  await window.waitForTimeout(300);
  await window.keyboard.press("Enter");
  await window.waitForTimeout(3000);
  return window
    .frameLocator("iframe.webview")
    .first()
    .frameLocator("#active-frame");
}

test("restores persisted ACP history after an Extension Development Host restart", async ({}, testInfo) => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });

  const firstHost = await launchHost();
  try {
    const firstWindow = await firstHost.firstWindow();
    const firstFrame = await focusChat(firstWindow);
    await expect(firstFrame.locator("#connect-btn")).toBeHidden();
    await firstWindow.waitForTimeout(500);
    await firstFrame.locator("#input").fill("Keep this conversation");
    await firstFrame.locator("#input").press("Enter");
    await expect(
      firstFrame.getByText("Persisted reply: Keep this conversation")
    ).toBeVisible();
    await firstWindow.waitForTimeout(500);
  } finally {
    await firstHost.close();
  }

  const secondHost = await launchHost();
  try {
    const secondWindow = await secondHost.firstWindow();
    const secondFrame = await focusChat(secondWindow);
    await secondWindow.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
    await secondWindow.waitForTimeout(500);
    await secondWindow.keyboard.type("ACP: Load Session");
    await secondWindow.waitForTimeout(300);
    await secondWindow.keyboard.press("Enter");
    const picker = secondFrame.locator("#session-picker");
    const sessionItem = picker.getByRole("button", {
      name: "Load Keep this conversation",
    });
    await expect(sessionItem).toBeVisible();
    await picker.screenshot({
      path: testInfo.outputPath("session-history.png"),
    });
    await sessionItem.click();
    await expect(
      secondFrame
        .locator(".message.user")
        .filter({ hasText: "Keep this conversation" })
    ).toBeVisible();
    await expect(
      secondFrame
        .locator(".message.assistant")
        .filter({ hasText: "Persisted reply: Keep this conversation" })
    ).toBeVisible();
    await secondFrame
      .locator("#messages")
      .screenshot({ path: testInfo.outputPath("restored-conversation.png") });
  } finally {
    await secondHost.close();
    await rm(DEMO_DIR, { recursive: true, force: true });
  }
});
