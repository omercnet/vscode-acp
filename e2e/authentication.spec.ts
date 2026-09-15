import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { delimiter, join } from "path";
import {
  closeVSCode,
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const DEMO_DIR = join(VSCODE_TEST_DIR, "authentication-demo");
const USER_DATA_DIR = join(DEMO_DIR, "user-data");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const SCREENSHOT_PATH = join(PROJECT_ROOT, "screenshots", "authentication.png");
const JOURNAL_PATH = join(DEMO_DIR, "agent-requests.jsonl");

interface AgentRequest {
  method: string;
  params?: unknown;
}

async function readRequestJournal(): Promise<AgentRequest[]> {
  return (await readFile(JOURNAL_PATH, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("method" in parsed) ||
        typeof parsed.method !== "string"
      ) {
        throw new Error(`Invalid agent journal entry: ${line}`);
      }
      return {
        method: parsed.method,
        ...("params" in parsed ? { params: parsed.params } : {}),
      };
    });
}

const AGENT_SOURCE = `#!/usr/bin/env node
const { appendFileSync } = require("fs");
const journal = process.env.VSCODE_ACP_AGENT_JOURNAL;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let authenticated = false;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method) {
      appendFileSync(journal, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [
          { id: "terminal", name: "Terminal sign-in", type: "terminal" },
          { id: "future", name: "Future sign-in", type: "terminal-v2" },
          { id: "browser", name: "$(verified) Browser sign-in", description: "Continue in your browser" }
        ]
      }});
    } else if (message.method === "authenticate") {
      if (message.params?.methodId !== "browser") {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unsupported authentication method" } });
      } else {
        authenticated = true;
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    } else if (message.method === "session/new") {
      if (!authenticated) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "authenticated-session", modes: null } });
      }
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
      VSCODE_ACP_AGENT_JOURNAL: JOURNAL_PATH,
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

test("authenticates through the Extension Development Host before creating a session", async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await writeFile(JOURNAL_PATH, "");
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });

  const host = await launchHost();
  try {
    const window = await host.firstWindow();
    const frame = await focusChat(window);

    const picker = window.locator(".quick-input-widget");
    await expect(picker.locator(".quick-input-title")).toHaveText(
      "Authentication required"
    );
    const offered = picker.locator(".quick-input-list .monaco-list-row");
    await expect(offered).toHaveCount(1);
    // The terminal method and the unknown `terminal-v2` type are client-executed
    // kinds this client cannot run, and agent icon syntax must stay literal.
    await expect(offered.first()).toContainText("$(verified) Browser sign-in");
    await window.screenshot({ path: SCREENSHOT_PATH });

    await window.keyboard.press("Enter");

    await expect
      .poll(async () =>
        (await readRequestJournal()).map((request) => request.method)
      )
      .toEqual(["initialize", "session/new", "authenticate", "session/new"]);

    await expect(frame.locator("#status-text")).toHaveText("Connected");
    await expect(frame.locator("#input")).toBeVisible();

    const requests = await readRequestJournal();
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/new",
      "authenticate",
      "session/new",
    ]);
    expect(requests[2].params).toEqual({ methodId: "browser" });
  } finally {
    await closeVSCode(host);
    await rm(DEMO_DIR, { recursive: true, force: true });
  }
});
