import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import {
  closeVSCode,
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const DEMO_DIR = join(VSCODE_TEST_DIR, "diagnostics-demo");
const BIN_DIR = join(DEMO_DIR, "bin");
const EXTENSIONS_DIR = join(DEMO_DIR, "extensions");
const AGENT_PATH = join(BIN_DIR, "opencode");
const LIFECYCLE_PATH = join(DEMO_DIR, "lifecycle.log");
const PROMPT_SECRET = "diagnostics-prompt-secret";
const PAYLOAD_SECRET = "diagnostics-payload-secret";
const MCP_SECRET = "diagnostics-mcp-secret";

const AGENT_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
const lifecyclePath = process.env.VSCODE_ACP_DIAGNOSTICS_LIFECYCLE;
fs.appendFileSync(lifecyclePath, "start\\n");
let stopped = false;
function stop() {
  if (!stopped) {
    stopped = true;
    fs.appendFileSync(lifecyclePath, "stop\\n");
  }
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
let sessionCounter = 0;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "diagnostics-" + ++sessionCounter, modes: null } });
    } else if (message.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reply ${PAYLOAD_SECRET}" } } } });
      send({ jsonrpc: "2.0", method: "future/${PAYLOAD_SECRET}", params: { body: "${PAYLOAD_SECRET}" } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn", private: "${PAYLOAD_SECRET}" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function launchHost(): Promise<ElectronApplication> {
  const userDataDir = join(DEMO_DIR, "user-data");
  const settingsDir = join(userDataDir, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": "Default Dark+",
      "window.titleBarStyle": "custom",
      "vscode-acp.diagnostics.enabled": true,
      "vscode-acp.mcpServers": [
        {
          type: "http",
          name: "diagnostics-server",
          url: "https://diagnostics.invalid/mcp",
          headers: [{ name: "Authorization", value: `Bearer ${MCP_SECRET}` }],
        },
      ],
    })
  );
  const executablePath = await findVSCodeExecutable();
  return electron.launch({
    executablePath,
    args: [
      `--extensions-dir=${EXTENSIONS_DIR}`,
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
      VSCODE_ACP_DIAGNOSTICS_LIFECYCLE: LIFECYCLE_PATH,
      VSCODE_SKIP_PRELAUNCH: "1",
    },
  });
}

async function runCommand(window: Page, command: string): Promise<void> {
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  const input = window.locator(".quick-input-widget input");
  await expect(input).toBeVisible({ timeout: 30000 });
  await input.fill(command);
  await window.keyboard.press("Enter");
}

async function lifecycleEvents(): Promise<string[]> {
  try {
    return (await readFile(LIFECYCLE_PATH, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test.beforeAll(async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
  await mkdir(EXTENSIONS_DIR, { recursive: true });
});

test.afterAll(async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
});

test("shows redacted traffic and reuses restart and disconnect cleanup", async () => {
  const host = await launchHost();
  try {
    const window = await host.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1280, height: 800 });
    await window.waitForTimeout(3000);

    const activityItem = window.locator(
      '.action-label[aria-label="VSCode ACP"]'
    );
    await expect(activityItem).toBeVisible({ timeout: 10000 });
    await activityItem.click();
    await window.waitForTimeout(2000);
    const frame = window
      .frameLocator("iframe.webview")
      .first()
      .frameLocator("#active-frame");
    const input = frame.locator("#input");

    await frame.locator("#connect-btn").click();
    await expect(input).toBeEnabled({ timeout: 10000 });
    await input.fill(PROMPT_SECRET);
    await input.press("Enter");
    await expect(frame.getByText(`Reply ${PAYLOAD_SECRET}`)).toBeVisible();
    const showDiagnostics = window.locator(
      '.action-label[aria-label="Show Diagnostics"]'
    );
    await expect(showDiagnostics).toBeVisible();
    await showDiagnostics.click();
    const output = window.locator(".panel .monaco-editor .view-lines").last();
    await expect(output).toBeVisible({ timeout: 10000 });
    const diagnostics = await output.innerText();
    expect(diagnostics).toContain('"direction":"agent->client"');
    expect(diagnostics).toContain('"method":"session/prompt"');
    expect(diagnostics).toContain('"correlation":"rpc-');
    expect(diagnostics).toContain('"durationMs":');
    expect(diagnostics).toContain('"outcome":"ok"');
    expect(diagnostics).toContain('"method":"unknown"');
    for (const secret of [PROMPT_SECRET, PAYLOAD_SECRET, MCP_SECRET]) {
      expect(diagnostics).not.toContain(secret);
    }
    const restart = window.locator('.action-label[aria-label="Restart Agent"]');
    await expect(restart).toBeVisible();
    await restart.click();
    await expect
      .poll(
        async () =>
          (await lifecycleEvents()).filter((event) => event === "start").length
      )
      .toBe(2);
    await expect(input).toBeEnabled({ timeout: 10000 });

    const disconnect = window.locator(
      '.action-label[aria-label="Disconnect Agent"]'
    );
    await expect(disconnect).toBeVisible();
    await disconnect.click();
    await expect(frame.locator("#status-text")).toHaveText("Disconnected");
    await expect
      .poll(
        async () =>
          (await lifecycleEvents()).filter((event) => event === "stop").length
      )
      .toBe(2);
  } finally {
    await closeVSCode(host);
  }
});
