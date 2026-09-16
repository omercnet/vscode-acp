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
  closeVSCode,
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const DEMO_DIR = join(VSCODE_TEST_DIR, "session-config-options-demo");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");

const INITIAL_OPTIONS = [
  {
    id: "interaction",
    type: "select",
    name: "Interaction",
    category: "mode",
    currentValue: "build",
    options: [
      { value: "build", name: "Build" },
      { value: "review", name: "Review" },
    ],
  },
  {
    id: "model",
    type: "select",
    name: "Model",
    category: "model",
    currentValue: "fast",
    options: [
      {
        group: "speed",
        name: "Fast models",
        options: [{ value: "fast", name: "Fast" }],
      },
      {
        group: "quality",
        name: "Quality models",
        options: [{ value: "accurate", name: "Accurate" }],
      },
    ],
  },
  {
    id: "thought",
    type: "select",
    name: "Thought level",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
    ],
  },
];

const AGENT_SOURCE = `#!/usr/bin/env node
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const initialOptions = ${JSON.stringify(INITIAL_OPTIONS)};
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
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === "session/new") {
      const sessionId = "config-session-" + ++sessionCounter;
      const respond = () => send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId,
          modes: {
            availableModes: [{ id: "legacy", name: "Legacy" }],
            currentModeId: "legacy",
          },
          configOptions: initialOptions,
        },
      });
      if (sessionCounter === 1) respond();
      else setTimeout(respond, 800);
    } else if (message.method === "session/set_config_option") {
      const configOptions = params.configId === "interaction" && params.value === "review"
        ? [
            { ...initialOptions[0], currentValue: "review" },
            {
              id: "model",
              type: "select",
              name: "Model",
              category: "model",
              currentValue: "accurate",
              options: [
                {
                  group: "quality",
                  name: "Quality models",
                  options: [{ value: "accurate", name: "Accurate" }],
                },
              ],
            },
          ]
        : initialOptions.map((option) =>
            option.id === params.configId
              ? { ...option, currentValue: params.value }
              : option
          );
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
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
    })
  );
  return electron.launch({
    executablePath: await findVSCodeExecutable(),
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
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
});

test.afterAll(async () => {
  await rm(DEMO_DIR, { recursive: true, force: true });
});

test("renders grouped options, applies cascades, and clears replacements", async () => {
  const host = await launchHost();
  try {
    const window = await host.firstWindow();
    const frame = await openChatView(window);
    await frame.locator("#connect-btn").click();

    const configSelectors = frame.locator(".session-config-select");
    await expect(configSelectors).toHaveCount(3);
    await expect(frame.locator("#mode-selector")).toBeHidden();
    await expect(frame.locator("#model-selector")).toBeHidden();

    const model = frame.locator('[data-config-id="model"]');
    await expect(model).toHaveValue("fast");
    expect(
      await model.locator("optgroup").evaluateAll((groups) =>
        groups.map((group) => ({
          id: (group as HTMLOptGroupElement).dataset.group,
          label: (group as HTMLOptGroupElement).label,
          values: Array.from(
            (group as HTMLOptGroupElement).querySelectorAll("option"),
            (option) => (option as HTMLOptionElement).value
          ),
        }))
      )
    ).toEqual([
      { id: "speed", label: "Fast models", values: ["fast"] },
      { id: "quality", label: "Quality models", values: ["accurate"] },
    ]);

    const interaction = frame.locator('[data-config-id="interaction"]');
    await interaction.focus();
    await interaction.selectOption("review");
    await expect(configSelectors).toHaveCount(2);
    await expect(frame.locator('[data-config-id="thought"]')).toHaveCount(0);
    await expect(frame.locator('[data-config-id="interaction"]')).toHaveValue(
      "review"
    );
    await expect(frame.locator('[data-config-id="model"]')).toHaveValue(
      "accurate"
    );
    expect(
      await frame.locator('[data-config-id="interaction"]').evaluate(
        (element) => element === document.activeElement
      )
    ).toBe(true);

    await runCommand(window, "ACP: New Chat");
    await expect(configSelectors).toHaveCount(0);
    await expect(configSelectors).toHaveCount(3, { timeout: 10000 });
  } finally {
    await closeVSCode(host);
  }
});
