import {
  test,
  expect,
  _electron as electron,
  type Page,
  type Frame,
} from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import {
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const DEMO_DIR = join(VSCODE_TEST_DIR, "filesystem-boundary-demo");
const USER_DATA_DIR = join(DEMO_DIR, "user-data");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const ALLOWED_PATH = join(DEMO_DIR, "allowed.txt");
const ALLOWED_WRITE_PATH = join(DEMO_DIR, "written.txt");

const AGENT_SOURCE = `#!/usr/bin/env node
const allowedPath = process.env.VSCODE_ACP_ALLOWED_PATH;
const allowedWritePath = process.env.VSCODE_ACP_ALLOWED_WRITE_PATH;
const deniedPath = process.env.VSCODE_ACP_DENIED_PATH;
const pending = new Map();
let nextRequestId = 1000;
let buffer = "";
let writeSupported = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (sessionId, messageId, text) => send({
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text }
    }
  }
});
const requestClient = (method, params) => new Promise((resolve, reject) => {
  const id = nextRequestId++;
  pending.set(id, { resolve, reject });
  send({ jsonrpc: "2.0", id, method, params });
});
async function runFilesystemDemo(sessionId, promptId) {
  try {
    const allowed = await requestClient("fs/read_text_file", { sessionId, path: allowedPath });
    update(sessionId, "allowed-read", "Allowed workspace read: " + allowed.content);

    try {
      await requestClient("fs/read_text_file", { sessionId, path: deniedPath });
      update(sessionId, "denied-read", "\\n\\nDenied external read: unexpectedly allowed");
    } catch (error) {
      update(sessionId, "denied-read", "\\n\\nDenied external read: " + JSON.stringify(error));
    }

    if (writeSupported) {
      await requestClient("fs/write_text_file", { sessionId, path: allowedWritePath, content: "written-by-agent" });
      const readBack = await requestClient("fs/read_text_file", { sessionId, path: allowedWritePath });
      update(sessionId, "allowed-write", "\\n\\nAllowed workspace write: " + readBack.content);

      try {
        await requestClient("fs/write_text_file", { sessionId, path: deniedPath, content: "overwritten-by-agent" });
        update(sessionId, "denied-write", "\\n\\nDenied external write: unexpectedly allowed");
      } catch (error) {
        update(sessionId, "denied-write", "\\n\\nDenied external write: " + JSON.stringify(error));
      }
    } else {
      update(sessionId, "write-unavailable", "\\n\\nWorkspace write capability: unavailable on this host");
    }

    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  } catch (error) {
    send({ jsonrpc: "2.0", id: promptId, error: { code: -32603, message: String(error) } });
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === undefined && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error === undefined ? request.resolve(message.result) : request.reject(message.error);
      continue;
    }
    if (message.method === "initialize") {
      writeSupported = message.params?.clientCapabilities?.fs?.writeTextFile === true;
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "filesystem-demo", modes: null } });
    } else if (message.method === "session/prompt") {
      void runFilesystemDemo(message.params.sessionId, message.id);
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function launchHost(deniedPath: string) {
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
      VSCODE_ACP_ALLOWED_PATH: ALLOWED_PATH,
      VSCODE_ACP_ALLOWED_WRITE_PATH: ALLOWED_WRITE_PATH,
      VSCODE_ACP_DENIED_PATH: deniedPath,
      VSCODE_SKIP_PRELAUNCH: "1",
    },
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

  await expect
    .poll(
      async () => {
        for (const frame of window.frames()) {
          if ((await frame.locator("#input").count()) > 0) {
            return true;
          }
        }
        return false;
      },
      { timeout: 30000 }
    )
    .toBe(true);

  for (const frame of window.frames()) {
    if ((await frame.locator("#input").count()) > 0) {
      return frame;
    }
  }
  throw new Error("ACP chat frame disappeared after becoming ready");
}

test("allows workspace filesystem access and blocks escapes in an Extension Development Host", async () => {
  const deniedRoot = await mkdtemp(join(tmpdir(), "vscode-acp-denied-demo-"));
  const deniedPath = join(deniedRoot, "secret.txt");
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await writeFile(ALLOWED_PATH, "workspace-content");
  await writeFile(deniedPath, "outside-secret");
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const host = await launchHost(deniedPath);
  try {
    const window = await host.firstWindow();
    const frame = await focusChat(window);
    await expect(frame.locator("#connect-btn")).toBeHidden({ timeout: 30000 });
    await frame.locator("#input").fill("Exercise filesystem boundary");
    await frame.locator("#input").press("Enter");

    await expect(
      frame.getByText("Allowed workspace read: workspace-content")
    ).toBeVisible();
    await expect(frame.getByText(/Denied external read:/)).toContainText(
      "ACP file access is restricted to trusted workspace files."
    );
    const allowedWrite = frame.getByText(
      "Allowed workspace write: written-by-agent"
    );
    const unavailableWrite = frame.getByText(
      "Workspace write capability: unavailable on this host"
    );
    await expect(allowedWrite.or(unavailableWrite)).toBeVisible();
    if (await allowedWrite.isVisible()) {
      await expect(frame.getByText(/Denied external write:/)).toContainText(
        "ACP file access is restricted to trusted workspace files."
      );
      expect(await readFile(ALLOWED_WRITE_PATH, "utf8")).toBe(
        "written-by-agent"
      );
    }
    // Denials must not echo the path the agent was refused.
    await expect(frame.locator("#messages")).not.toContainText(deniedPath);

    await frame.locator("#messages").screenshot({
      path: join(SCREENSHOTS_DIR, "filesystem-boundary.png"),
    });

    // A denied write never touched the outside target.
    expect(await readFile(deniedPath, "utf8")).toBe("outside-secret");
  } finally {
    await host.close();
    await rm(DEMO_DIR, { recursive: true, force: true });
    await rm(deniedRoot, { recursive: true, force: true });
  }
});
