import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdir, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import {
  closeVSCode,
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const DEMO_DIR = join(VSCODE_TEST_DIR, "terminal-permission-demo");
const USER_DATA_DIR = join(VSCODE_TEST_DIR, "user-data-terminal-e2e");
const WORKSPACE_DIR = join(DEMO_DIR, "workspace");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const SENTINEL_PATH = join(WORKSPACE_DIR, "terminal-ran.txt");
const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const HOST_SECRET_NAME = "VSCODE_ACP_E2E_HOST_SECRET";

/**
 * Stub ACP agent that exercises the full terminal capability: it asks for
 * permission with a structured, reviewable payload and then attempts
 * `terminal/create` regardless of the answer, so a denial is only safe if the
 * extension refuses it. The command it wants to run writes a sentinel file,
 * which makes "nothing executed" an observable fact rather than a claim.
 */
const AGENT_SOURCE = `#!/usr/bin/env node
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (sessionId, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "agent-" + Date.now(), content: { type: "text", text } } } });
const pending = new Map();
let nextId = 1000;
const call = (method, params) => {
  const { promise, resolve, reject } = Promise.withResolvers();
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ jsonrpc: "2.0", id, method, params });
  return promise;
};
const COMMAND = {
  command: process.env.VSCODE_ACP_E2E_NODE,
  args: [
    "-e",
    "require('fs').writeFileSync(process.argv[1], 'ran'); process.stdout.write('ACP-RAN|' + (process.env.${HOST_SECRET_NAME} ?? 'no-secret'))",
    process.env.VSCODE_ACP_E2E_SENTINEL,
  ],
  cwd: process.env.VSCODE_ACP_E2E_WORKSPACE,
};
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry) {
        message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      }
      continue;
    }
    const params = message.params || {};
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "terminal-demo", modes: null } });
    } else if (message.method === "session/prompt") {
      const sessionId = params.sessionId;
      let decision = "none";
      try {
        const outcome = await call("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "terminal-1", title: "Run a command", kind: "execute", rawInput: COMMAND },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        decision = outcome && outcome.outcome ? (outcome.outcome.optionId || outcome.outcome.outcome) : "none";
      } catch (error) {
        decision = "error:" + error.message;
      }
      update(sessionId, "DECISION: " + decision);
      try {
        const created = await call("terminal/create", { sessionId, ...COMMAND });
        await call("terminal/wait_for_exit", { sessionId, terminalId: created.terminalId });
        const result = await call("terminal/output", { sessionId, terminalId: created.terminalId });
        update(sessionId, "TERMINAL OUTPUT: " + result.output);
        await call("terminal/release", { sessionId, terminalId: created.terminalId });
      } catch (error) {
        update(sessionId, "TERMINAL REFUSED: " + error.message);
      }
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function prepareHost(): Promise<void> {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await rm(USER_DATA_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await writeFile(join(WORKSPACE_DIR, "README.md"), "# terminal demo\n");
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
  const settingsDir = join(USER_DATA_DIR, "User");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": "Default Dark+",
      "window.titleBarStyle": "custom",
    })
  );
}

async function launchHost() {
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
      WORKSPACE_DIR,
    ],
    timeout: 60000,
    env: {
      ...process.env,
      PATH: `${BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
      VSCODE_ACP_TEST_AGENT_COMMAND: AGENT_PATH,
      VSCODE_ACP_E2E_NODE: process.execPath,
      VSCODE_ACP_E2E_SENTINEL: SENTINEL_PATH,
      VSCODE_ACP_E2E_WORKSPACE: WORKSPACE_DIR,
      // Present in the extension host, and outside the inheritance allowlist:
      // the approved command must never observe it.
      [HOST_SECRET_NAME]: "host-secret-must-not-leak",
      VSCODE_SKIP_PRELAUNCH: "1",
    },
  });
}

async function focusChat(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await window.setViewportSize({ width: 1280, height: 900 });
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

test.describe("Terminal permission enforcement", () => {
  test.beforeEach(async () => {
    await prepareHost();
  });

  test.afterAll(async () => {
    await rm(DEMO_DIR, { recursive: true, force: true });
  });

  test("an approved command runs with a scrubbed environment", async () => {
    const host = await launchHost();
    try {
      const window = await host.firstWindow();
      const frame = await focusChat(window);
      await expect(frame.locator("#status-text")).toHaveText("Connected");

      await frame.locator("#input").fill("Run the build check");
      await frame.locator("#input").press("Enter");

      const modal = frame.locator("#permission-modal");
      await expect(modal).toHaveClass(/visible/);
      await expect(frame.locator(".permission-warning")).toHaveText(
        "Approving runs this program on your machine with your permissions."
      );
      await expect(frame.locator(".permission-content")).toContainText(
        "ACP-RAN"
      );
      await expect(frame.locator(".permission-content")).toContainText("PATH");
      await expect(frame.locator(".permission-content")).toContainText(
        DEMO_DIR
      );
      await expect(frame.locator(".permission-warning")).toContainText(
        "Scroll to the end of the details to enable approval."
      );
      await frame.locator("#permission-modal").screenshot({
        path: join(SCREENSHOTS_DIR, "terminal-permission-review.png"),
      });

      // The prompt starts inert for PERMISSION_GUARD_MS; wait it out instead of
      // clicking into a disabled button.
      await frame.locator(".permission-content").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      const allowOnce = frame.locator(".permission-option-btn").first();
      await expect(allowOnce).toBeEnabled();
      await allowOnce.click();

      await expect(frame.getByText("DECISION: once")).toBeVisible();
      await expect(
        frame.getByText("TERMINAL OUTPUT: ACP-RAN|no-secret")
      ).toBeVisible();
      expect(existsSync(SENTINEL_PATH)).toBe(true);

      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "terminal-permission-allowed.png"),
      });
    } finally {
      await closeVSCode(host);
    }
  });

  test("a denied command never executes even if the agent retries", async () => {
    const host = await launchHost();
    try {
      const window = await host.firstWindow();
      const frame = await focusChat(window);
      await expect(frame.locator("#status-text")).toHaveText("Connected");

      await frame.locator("#input").fill("Run the build check");
      await frame.locator("#input").press("Enter");

      const modal = frame.locator("#permission-modal");
      await expect(modal).toHaveClass(/visible/);
      const deny = frame.locator(".permission-option-btn").last();
      await expect(deny).toBeEnabled();
      await deny.click();

      await expect(frame.getByText("DECISION: deny")).toBeVisible();
      const refusal = frame.locator(".message.assistant").filter({
        hasText: "TERMINAL REFUSED:",
      });
      await expect(refusal).toContainText(
        "requires an approved permission request"
      );
      await expect(frame.getByText("TERMINAL OUTPUT:")).toHaveCount(0);
      expect(existsSync(SENTINEL_PATH)).toBe(false);

      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "terminal-permission-denied.png"),
      });
    } finally {
      await closeVSCode(host);
    }
  });
});
