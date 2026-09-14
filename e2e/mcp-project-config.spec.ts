import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { delimiter, join } from "path";
import {
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";
import { getWebviewContentFrame } from "./fixtures";

const DEMO_DIR = join(VSCODE_TEST_DIR, "mcp-project-config-demo");
const USER_DATA_DIR = join(DEMO_DIR, "user-data");
const WORKSPACE_DIR = join(DEMO_DIR, "workspace");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const JOURNAL_PATH = join(DEMO_DIR, "agent-requests.jsonl");
const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const RESOLVED_SECRET = "project-secret-that-must-not-persist";

interface AgentRequest {
  method: string;
  params?: Record<string, unknown>;
}

const AGENT_SOURCE = `#!/usr/bin/env node
const { appendFileSync } = require("fs");
const journal = process.env.VSCODE_ACP_AGENT_JOURNAL;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const update = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
let authenticated = false;
let acceptedSession;
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
      appendFileSync(journal, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
        authMethods: [{ id: "browser", name: "Browser sign-in" }]
      }});
    } else if (message.method === "authenticate") {
      authenticated = true;
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "session/new") {
      if (!authenticated) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
      } else {
        acceptedSession = params;
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "mcp-project-demo", modes: null } });
      }
    } else if (message.method === "session/prompt") {
      const servers = acceptedSession.mcpServers;
      const shared = servers.find((server) => server.name.toLowerCase() === "shared");
      const secretServer = servers.find((server) => server.name === "projectSecret");
      const auth = secretServer.headers.find((header) => header.name === "Authorization").value;
      const summary = "Configured MCP invocation: " + servers.map((server) => server.name).join(" > ") +
        "; shared source=" + shared.headers.find((header) => header.name === "X-Source").value +
        "; secret=" + (auth === "Bearer " + process.env.MCP_PROJECT_TOKEN ? "resolved, not displayed" : "missing");
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "configured", content: { type: "text", text: summary } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.method === "session/load") {
      update(params.sessionId, { sessionUpdate: "user_message_chunk", messageId: "loaded-user", content: { type: "text", text: "Inspect configured MCP invocation" } });
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "loaded-agent", content: { type: "text", text: "Loaded the same validated MCP snapshot without persisting its resolved secret." } });
      send({ jsonrpc: "2.0", id: message.id, result: { modes: null } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function readRequestJournal(): Promise<AgentRequest[]> {
  return (await readFile(JOURNAL_PATH, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentRequest);
}

async function containsText(
  directory: string,
  needle: string
): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await containsText(entryPath, needle)) return true;
    } else if (
      entry.isFile() &&
      (await readFile(entryPath)).includes(Buffer.from(needle))
    ) {
      return true;
    }
  }
  return false;
}

async function runCommand(window: Page, command: string): Promise<void> {
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  await window.waitForTimeout(300);
  await window.keyboard.type(command);
  await window.waitForTimeout(300);
  await window.keyboard.press("Enter");
}

async function openChat(window: Page) {
  await window.waitForLoadState("domcontentloaded");
  await window.setViewportSize({ width: 1280, height: 800 });
  await window.waitForTimeout(3000);
  await runCommand(window, "VSCode ACP: Focus on Chat View");
  await window.waitForTimeout(3000);
  return getWebviewContentFrame(window);
}

test("passes trusted project MCP configuration unchanged through auth retry and load", async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(join(USER_DATA_DIR, "User"), { recursive: true });
  await mkdir(join(WORKSPACE_DIR, ".vscode"), { recursive: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  await writeFile(JOURNAL_PATH, "");
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
  await writeFile(
    join(USER_DATA_DIR, "User", "settings.json"),
    JSON.stringify({
      "workbench.colorTheme": "Default Dark+",
      "window.titleBarStyle": "custom",
      "vscode-acp.mcpServers": [
        { name: "userOnly", command: process.execPath, args: ["user"] },
        {
          type: "http",
          name: "Shared",
          url: "https://user.example.com/mcp",
          headers: [{ name: "X-Source", value: "user" }],
        },
      ],
    })
  );
  await writeFile(
    join(WORKSPACE_DIR, ".vscode", "settings.json"),
    JSON.stringify({
      "vscode-acp.mcpServers": [
        {
          name: "workspaceOnly",
          command: process.execPath,
          args: ["workspace"],
        },
        {
          type: "http",
          name: "shared",
          url: "https://workspace.example.com/mcp",
          headers: [{ name: "X-Source", value: "workspace" }],
        },
      ],
    })
  );
  await writeFile(
    join(WORKSPACE_DIR, ".vscode", "mcp.json"),
    `{
      // The project source uses VS Code's established mcp.json object shape.
      "servers": {
        "SHARED": {
          "type": "http",
          "url": "https://project.example.com/mcp",
          "headers": { "X-Source": "project" },
        },
        "projectSecret": {
          "type": "http",
          "url": "https://secret.example.com/mcp",
          "headers": { "Authorization": "Bearer \${env:MCP_PROJECT_TOKEN}" },
        },
      },
    }`
  );

  const executablePath = await findVSCodeExecutable();
  const host = await electron.launch({
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
      MCP_PROJECT_TOKEN: RESOLVED_SECRET,
      VSCODE_ACP_TEST_AGENT_COMMAND: AGENT_PATH,
      VSCODE_ACP_AGENT_JOURNAL: JOURNAL_PATH,
      VSCODE_SKIP_PRELAUNCH: "1",
    },
  });
  let hostClosed = false;

  try {
    const window = await host.firstWindow();
    const frame = await openChat(window);
    await frame.locator("#connect-btn").click();

    const authPicker = window.locator(".quick-input-widget");
    await expect(authPicker.locator(".quick-input-title")).toHaveText(
      "Authentication required"
    );
    await window.keyboard.press("Enter");
    await expect(frame.locator("#input")).toBeEnabled({ timeout: 10000 });

    await frame.locator("#input").fill("Inspect configured MCP invocation");
    await frame.locator("#input").press("Enter");
    await expect
      .poll(async () =>
        (await readRequestJournal()).map((request) => request.method)
      )
      .toEqual([
        "initialize",
        "session/new",
        "authenticate",
        "session/new",
        "session/prompt",
      ]);
    const promptedRequests = await readRequestJournal();
    const promptedSession = promptedRequests.find(
      (request) => request.method === "session/new" && request.params
    )!.params as { mcpServers: Array<{ name: string }> };
    expect(promptedSession.mcpServers.map((server) => server.name)).toEqual([
      "userOnly",
      "SHARED",
      "workspaceOnly",
      "projectSecret",
    ]);
    const summary = frame.getByText(/Configured MCP invocation:/);
    await expect(summary).toContainText(
      "userOnly > SHARED > workspaceOnly > projectSecret"
    );
    await expect(summary).toContainText("shared source=project");
    await expect(summary).toContainText("secret=resolved, not displayed");
    await frame.locator("body").screenshot({
      path: join(SCREENSHOTS_DIR, "mcp-project-config.png"),
    });

    await window.waitForTimeout(500);
    await runCommand(window, "ACP: Load Session");
    const sessionItem = frame.locator("#session-picker").getByRole("button", {
      name: "Load Inspect configured MCP invocation",
    });
    await expect(sessionItem).toBeVisible();
    await sessionItem.click();
    await expect(
      frame.getByText(
        "Loaded the same validated MCP snapshot without persisting its resolved secret."
      )
    ).toBeVisible();
    await frame.locator("body").screenshot({
      path: join(SCREENSHOTS_DIR, "mcp-project-load.png"),
    });

    const requests = await readRequestJournal();
    const newRequests = requests.filter(
      (request) => request.method === "session/new"
    );
    const loadRequest = requests.find(
      (request) => request.method === "session/load"
    );
    expect(newRequests).toHaveLength(2);
    expect(loadRequest).toBeDefined();
    expect(JSON.stringify(newRequests[0].params)).toBe(
      JSON.stringify(newRequests[1].params)
    );
    const newSnapshot = newRequests[1].params as {
      cwd: string;
      mcpServers: unknown[];
    };
    const loaded = loadRequest!.params as {
      cwd: string;
      mcpServers: unknown[];
    };
    expect(
      JSON.stringify({ cwd: loaded.cwd, mcpServers: loaded.mcpServers })
    ).toBe(JSON.stringify(newSnapshot));
    expect(JSON.stringify(newSnapshot)).toContain(RESOLVED_SECRET);
    await host.close();
    hostClosed = true;
    expect(await containsText(USER_DATA_DIR, RESOLVED_SECRET)).toBe(false);
    expect(await containsText(WORKSPACE_DIR, RESOLVED_SECRET)).toBe(false);
  } finally {
    if (!hostClosed) await host.close();
    await rm(DEMO_DIR, { recursive: true, force: true });
  }
});
