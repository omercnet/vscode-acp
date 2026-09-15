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

const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const DEMO_DIR = join(VSCODE_TEST_DIR, "protocol-metadata-demo");
const USER_DATA_DIR = join(VSCODE_TEST_DIR, "user-data-protocol-metadata");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const INITIAL_LOCATION = join(PROJECT_ROOT, "package.json");
const FINAL_LOCATION = join(PROJECT_ROOT, "src", "extension.ts");

const AGENT_SOURCE = `#!/usr/bin/env node
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (sessionId, value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
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
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "metadata-agent", title: "Metadata Demo", version: "1.4.0" }
      } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "protocol-metadata-demo", modes: null } });
    } else if (message.method === "session/prompt") {
      update(params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "inspect-source",
        title: "Inspect source",
        kind: "read",
        status: "pending",
        rawInput: { description: "Inspect initialized source metadata" },
        content: [{ type: "content", content: { type: "text", text: "Inspected source metadata." } }],
        locations: [{ path: ${JSON.stringify(INITIAL_LOCATION)}, line: 5 }]
      });
      update(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "inspect-source",
        status: "in_progress",
        locations: [{ path: ${JSON.stringify(FINAL_LOCATION)}, line: 10 }]
      });
      update(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "inspect-source",
        status: "completed"
      });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "max_tokens" } });
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
    JSON.stringify({
      "window.titleBarStyle": "custom",
      "workbench.colorTheme": "Default Dark+",
      "task.allowAutomaticTasks": "off",
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
  const builtInChat = window
    .locator(".pane-header")
    .filter({ hasText: /^Chat$/ });
  await expect(builtInChat).toBeVisible();
  if ((await builtInChat.getAttribute("aria-expanded")) === "true") {
    await builtInChat.click();
  }
  await expect(builtInChat).toHaveAttribute("aria-expanded", "false");
  return window
    .frameLocator("iframe.webview")
    .first()
    .frameLocator("#active-frame");
}

test("shows protocol metadata and opens a trusted tool location", async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await rm(USER_DATA_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });

  const host = await launchHost();
  try {
    const window = await host.firstWindow();
    const frame = await focusChat(window);

    await expect(frame.locator("#status-text")).toHaveText(
      "Connected · Metadata Demo 1.4.0"
    );
    await frame.locator("#input").fill("Inspect the extension entry point");
    await frame.locator("#send").click();

    const location = frame.locator(".tool-location-link");
    await expect(location).toHaveText(`${join("src", "extension.ts")}:10`, {
      timeout: 15000,
    });
    await expect(frame.locator(".message.warning")).toHaveText(
      "Response stopped because the agent reached its token limit."
    );
    await expect(frame.locator(".message.assistant .tool-item")).toBeVisible();
    await expect(frame.locator(".message.assistant .tool-input")).toContainText(
      "Inspect initialized source metadata"
    );
    await expect(frame.locator(".message.assistant .tool-output")).toHaveText(
      "Inspected source metadata."
    );
    await expect(frame.locator("#status-text")).toBeInViewport({ ratio: 1 });
    await expect(frame.locator(".message.warning")).toBeInViewport({
      ratio: 1,
    });
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "protocol-metadata-turn.png"),
    });

    await location.click();
    await expect(
      window.locator(".tabs-container .tab.active").filter({
        hasText: "extension.ts",
      })
    ).toBeVisible({ timeout: 10000 });
    await expect(
      window.locator(".statusbar-item").filter({ hasText: "Ln 10, Col 1" })
    ).toBeVisible({ timeout: 10000 });
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "protocol-metadata-navigation.png"),
    });
  } finally {
    await host.close();
    await rm(DEMO_DIR, { recursive: true, force: true });
    await rm(USER_DATA_DIR, { recursive: true, force: true });
  }
});
