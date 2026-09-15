import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
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

const DEMO_DIR = join(VSCODE_TEST_DIR, "session-browser-demo");
const USER_DATA_DIR = join(DEMO_DIR, "user-data");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const JOURNAL_PATH = join(DEMO_DIR, "agent-requests.jsonl");

interface AgentRequest {
  method: string;
  params?: Record<string, unknown>;
}

const AGENT_SOURCE = `#!/usr/bin/env node
const { appendFileSync } = require("fs");
const journal = process.env.VSCODE_ACP_AGENT_JOURNAL;
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
    if (message.method) {
      appendFileSync(journal, JSON.stringify({ method: message.method, params }) + "\\n");
    }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, additionalDirectories: {} }
        }
      }});
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "active-session", modes: null } });
    } else if (message.method === "session/list") {
      if (params.cursor === "page-2") {
        send({ jsonrpc: "2.0", id: message.id, result: { sessions: [
          { sessionId: "agent-session-2", cwd: process.cwd(), title: "Second agent session", updatedAt: "2026-09-15T12:00:00.000Z" }
        ] }});
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { sessions: [
          { sessionId: "agent-session-1", cwd: process.cwd(), title: "First agent session", updatedAt: "2026-09-15T11:00:00.000Z" }
        ], nextCursor: "page-2" }});
      }
    } else if (message.method === "session/resume") {
      send({ jsonrpc: "2.0", id: message.id, result: { modes: null, configOptions: [] } });
    } else if (message.method === "session/load") {
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", messageId: "history", content: { type: "text", text: "Loaded session history" } }
      }});
      send({ jsonrpc: "2.0", id: message.id, result: { modes: null, configOptions: [] } });
    } else if (message.method === "session/prompt") {
      const text = params.prompt?.[0]?.text || "";
      send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", messageId: "reply", content: { type: "text", text: "Reply " + params.sessionId + ": " + text } }
      }});
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function launchHost(): Promise<ElectronApplication> {
  const settingsDir = join(USER_DATA_DIR, "User");
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

async function runCommand(window: Page, command: string): Promise<void> {
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  await window.waitForTimeout(300);
  await window.keyboard.type(command);
  await window.waitForTimeout(300);
  await window.keyboard.press("Enter");
}

async function chatFrame(window: Page) {
  await runCommand(window, "VSCode ACP: Focus on Chat View");
  await window.waitForTimeout(1500);
  return window
    .frameLocator("iframe.webview")
    .first()
    .frameLocator("#active-frame");
}

async function readJournal(): Promise<AgentRequest[]> {
  return (await readFile(JOURNAL_PATH, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentRequest);
}

test("browses paginated agent sessions without replacing the active session and resumes explicitly", async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await writeFile(JOURNAL_PATH, "");
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
  const host = await launchHost();
  try {
    const window = await host.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1400, height: 900 });
    await window.waitForTimeout(2500);
    let frame = await chatFrame(window);
    await frame.locator("#connect-btn").click();
    await expect(frame.locator("#input")).toBeEnabled({ timeout: 10000 });
    await frame.locator("#input").fill("Before discovery");
    await frame.locator("#input").press("Enter");
    await expect(frame.getByText("Reply active-session: Before discovery")).toBeVisible();
    await runCommand(window, "VSCode ACP: Focus on Agent Sessions View");
    const agentRow = window.getByRole("treeitem").filter({ hasText: "OpenCode" }).first();
    await expect(agentRow).toBeVisible({ timeout: 10000 });
    await agentRow.click();
    await window.keyboard.press("ArrowRight");
    await expect(window.getByText("First agent session", { exact: true })).toBeVisible({ timeout: 10000 });
    await window.getByText("Load more…", { exact: true }).click();
    await expect(window.getByText("Second agent session", { exact: true })).toBeVisible({ timeout: 10000 });
    frame = await chatFrame(window);
    await frame.locator("#input").fill("After discovery");
    await frame.locator("#input").press("Enter");
    await expect(frame.getByText("Reply active-session: After discovery")).toBeVisible();
    await runCommand(window, "VSCode ACP: Focus on Agent Sessions View");
    await window.getByText("First agent session", { exact: true }).click();
    const picker = window.locator(".quick-input-widget");
    await expect(picker).toBeVisible();
    await picker.getByText("Resume without history", { exact: true }).click();
    frame = window
      .frameLocator("iframe.webview")
      .first()
      .frameLocator("#active-frame");
    await expect(frame.locator("#input")).toBeEnabled({ timeout: 10000 });
    await frame.locator("#input").fill("After resume");
    await frame.locator("#input").press("Enter");
    await expect(
      frame.getByText("Reply agent-session-1: After resume")
    ).toBeVisible({ timeout: 10000 });
    const requests = await readJournal();
    const methods = requests.map((request) => request.method);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(
      requests
        .filter((request) => request.method === "session/list")
        .map((request) => request.params?.cursor ?? null)
    ).toEqual([null, "page-2"]);
    expect(
      requests
        .filter((request) => request.method === "session/prompt")
        .map((request) => request.params?.sessionId)
    ).toEqual(["active-session", "active-session", "agent-session-1"]);
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/load");
  } finally {
    await closeVSCode(host);
    await rm(DEMO_DIR, { recursive: true, force: true });
  }
});
