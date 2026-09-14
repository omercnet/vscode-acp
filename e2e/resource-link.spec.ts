import {
  test,
  expect,
  _electron as electron,
  type FrameLocator,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { delimiter, join } from "path";
import {
  cmdOrCtrl,
  findVSCodeExecutable,
  PROJECT_ROOT,
  VSCODE_TEST_DIR,
} from "./utils";

const SCREENSHOTS_DIR = join(PROJECT_ROOT, "screenshots");
const DEMO_DIR = join(VSCODE_TEST_DIR, "resource-link-demo");
const USER_DATA_DIR = join(VSCODE_TEST_DIR, "user-data-resource-link");
const WIRE_PATH = join(DEMO_DIR, "wire.json");
const BIN_DIR = join(DEMO_DIR, "bin");
const AGENT_PATH = join(BIN_DIR, "opencode");
const RICH_TEXT_PATH = join(PROJECT_ROOT, "rich-attachment-demo.ts");
const RICH_IMAGE_PATH = join(PROJECT_ROOT, "rich-attachment-demo.png");
const RICH_DROP_TEXT = "context supplied by a dropped file";

/**
 * Minimal ACP agent that records every `session/prompt` payload it receives
 * and echoes the exact content-block types and sizes back to the UI. The
 * screenshots therefore prove wire delivery, not only optimistic chip state.
 */
const AGENT_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
const wirePath = process.env.VSCODE_ACP_WIRE_LOG;
const promptCapabilities = JSON.parse(process.env.VSCODE_ACP_PROMPT_CAPABILITIES || "{}");
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
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities } } });
    } else if (message.method === "session/new") {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "attachment-demo", modes: null } });
    } else if (message.method === "session/prompt") {
      const prompt = params.prompt || [];
      const log = fs.existsSync(wirePath) ? JSON.parse(fs.readFileSync(wirePath, "utf8")) : [];
      log.push(prompt);
      fs.writeFileSync(wirePath, JSON.stringify(log, null, 2));
      const summaries = prompt.filter((block) => block.type !== "text").map((block) => {
        if (block.type === "resource_link") return "resource_link " + block.name + " (" + block.mimeType + ", " + block.size + " bytes)";
        if (block.type === "resource") return "resource " + block.resource.mimeType + " (" + Buffer.byteLength(block.resource.text || "", "utf8") + " bytes): " + block.resource.text;
        if (block.type === "image") return "image " + block.mimeType + " (" + Buffer.from(block.data, "base64").byteLength + " bytes)";
        return block.type;
      });
      const reply = summaries.length ? "Wire received " + summaries.join(" | ") : "Wire received no attachments";
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "agent-1", content: { type: "text", text: reply } });
      send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
`;

async function launchHost(
  promptCapabilities: { image?: boolean; embeddedContext?: boolean } = {}
) {
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
      VSCODE_ACP_WIRE_LOG: WIRE_PATH,
      VSCODE_ACP_PROMPT_CAPABILITIES: JSON.stringify(promptCapabilities),
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

async function openFileInEditor(window: Page, name: string) {
  await window.keyboard.press(`${cmdOrCtrl()}+P`);
  await window.waitForTimeout(500);
  await window.keyboard.type(name);
  await window.waitForTimeout(800);
  await window.keyboard.press("Enter");
  await window.waitForTimeout(1000);
}

async function attachFromQuickPick(window: Page, label: string) {
  const quickPick = window.locator(".quick-input-widget");
  await expect(quickPick).toBeVisible({ timeout: 10000 });
  const item = quickPick.getByLabel(label, { exact: false }).first();
  await expect(item).toBeVisible({ timeout: 10000 });
  await item.click();
  await window.keyboard.press("Enter");
}

async function focusChatView(window: Page): Promise<void> {
  await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
  await window.waitForTimeout(500);
  await window.keyboard.type("VSCode ACP: Focus on Chat View");
  await window.waitForTimeout(300);
  await window.keyboard.press("Enter");
  await window.waitForTimeout(1000);
}

async function dispatchWebviewFile(
  frame: FrameLocator,
  eventType: "paste" | "drop",
  name: string,
  mimeType: string,
  base64: string
): Promise<void> {
  const selector = eventType === "paste" ? "#input" : "#input-container";
  await frame.locator(selector).evaluate(
    (element, attachment) => {
      const binary = atob(attachment.base64);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0)
      );
      const file = new File([bytes], attachment.name, {
        type: attachment.mimeType,
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const event = new Event(attachment.eventType, {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(
        event,
        attachment.eventType === "paste" ? "clipboardData" : "dataTransfer",
        { value: transfer }
      );
      element.dispatchEvent(event);
    },
    { eventType, name, mimeType, base64 }
  );
}

test("sends a selected file as a resource_link block on the ACP wire", async ({}) => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });

  const host = await launchHost();
  try {
    const window = await host.firstWindow();
    const frame = await focusChat(window);
    await expect(frame.locator("#connect-btn")).toBeHidden();

    await openFileInEditor(window, "package.json");
    await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("VSCode ACP: Focus on Chat View");
    await window.waitForTimeout(300);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(1500);

    await frame.locator("#attach-btn").click();
    await attachFromQuickPick(window, "package.json");

    await expect(
      frame.locator("#attachments-bar .attachment-chip-name")
    ).toHaveText("package.json", { timeout: 10000 });
    await expect(window.locator(".quick-input-widget")).toBeHidden();
    await window.waitForTimeout(500);
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "resource-link-selected.png"),
    });

    await frame.locator("#input").fill("Review this project manifest");
    await frame.locator("#send").click();

    await expect(
      frame.locator(".message.user .attachment-chip-name")
    ).toHaveText("package.json", { timeout: 10000 });
    await expect(
      frame.locator(".message.assistant").filter({ hasText: "resource_link" })
    ).toBeVisible({ timeout: 15000 });
    await window.waitForTimeout(500);
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "resource-link-sent.png"),
    });

    const manifest = await readFile(join(PROJECT_ROOT, "package.json"), "utf8");
    const wireText = await readFile(WIRE_PATH, "utf8");
    const wire = JSON.parse(wireText) as Array<Array<Record<string, unknown>>>;
    expect(wire).toHaveLength(1);
    expect(wire[0]).toEqual([
      {
        type: "text",
        text: "Review this project manifest",
      },
      {
        type: "resource_link",
        uri: `file://${PROJECT_ROOT.split("/").map(encodeURIComponent).join("/")}/package.json`,
        name: "package.json",
        mimeType: "application/json",
        size: Buffer.byteLength(manifest),
      },
    ]);
    // Exact equality above proves there is no content-bearing third block or
    // extra field; this assertion also guards against embedding the raw file.
    expect(wireText).not.toContain(manifest);
  } finally {
    await host.close();
  }
});

test("acknowledges embedded buffers and image prompts received on the ACP wire", async ({}) => {
  await rm(DEMO_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });
  await writeFile(RICH_TEXT_PATH, "const savedContext = true;\n");
  const imageData = (
    await readFile(join(PROJECT_ROOT, "assets/icon.png"))
  ).toString("base64");
  await writeFile(RICH_IMAGE_PATH, Buffer.from(imageData, "base64"));

  const host = await launchHost({ image: true, embeddedContext: true });
  try {
    const window = await host.firstWindow();
    const frame = await focusChat(window);
    await expect(frame.locator("#connect-btn")).toBeHidden();

    await openFileInEditor(window, "rich-attachment-demo.ts");
    await window.keyboard.press(`${cmdOrCtrl()}+A`);
    await window.keyboard.type("const unsavedContext = true;\n");
    await focusChatView(window);
    await frame.locator("#attach-btn").click();
    await attachFromQuickPick(window, "rich-attachment-demo.ts");
    await expect(
      frame.locator("#attachments-bar .attachment-chip-type")
    ).toHaveText("Embedded", { timeout: 10000 });

    await openFileInEditor(window, "rich-attachment-demo.png");
    await focusChatView(window);
    await frame.locator("#attach-btn").click();
    await attachFromQuickPick(window, "rich-attachment-demo.png");
    const imageChip = frame
      .locator("#attachments-bar .attachment-chip")
      .filter({ hasText: "rich-attachment-demo.png" });
    await expect(imageChip.locator(".attachment-chip-type")).toHaveText(
      "Image",
      { timeout: 10000 }
    );
    await expect(imageChip.locator("img")).toBeVisible();
    await imageChip.locator(".attachment-chip-remove").click();
    await expect(imageChip).toHaveCount(0);

    await frame.locator("#attach-btn").click();
    await attachFromQuickPick(window, "rich-attachment-demo.png");
    await frame.locator("#input").fill("Inspect the unsaved buffer and image");
    await frame.locator("#send").click();
    await expect(
      frame.locator(".message.assistant").filter({
        hasText: "Wire received resource text/typescript",
      })
    ).toContainText("image image/png", { timeout: 15000 });
    await frame.locator("body").screenshot({
      path: join(SCREENSHOTS_DIR, "embedded-resource-image-upload-ack.png"),
    });

    await dispatchWebviewFile(
      frame,
      "drop",
      "dropped.txt",
      "text/plain",
      Buffer.from(RICH_DROP_TEXT).toString("base64")
    );
    await dispatchWebviewFile(
      frame,
      "paste",
      "pasted.png",
      "image/png",
      imageData
    );
    await expect(
      frame.locator("#attachments-bar .attachment-chip")
    ).toHaveCount(2, { timeout: 10000 });
    await frame.locator("#input").fill("Inspect dropped and pasted content");
    await frame.locator("#send").click();
    await expect(frame.locator(".message.assistant").last()).toContainText(
      "Wire received resource text/plain",
      { timeout: 15000 }
    );
    await expect(frame.locator(".message.assistant").last()).toContainText(
      "image image/png"
    );
    await frame.locator("body").screenshot({
      path: join(SCREENSHOTS_DIR, "dropped-context-pasted-image-ack.png"),
    });

    const wire = JSON.parse(await readFile(WIRE_PATH, "utf8")) as Array<
      Array<Record<string, unknown>>
    >;
    expect(wire).toHaveLength(2);
    expect(wire[0][0]).toEqual({
      type: "text",
      text: "Inspect the unsaved buffer and image",
    });
    expect(wire[0][1]).toMatchObject({
      type: "resource",
      resource: {
        mimeType: "text/typescript",
        text: "const unsavedContext = true;\n",
      },
    });
    expect(wire[0][2]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: imageData,
    });
    expect(wire[1][0]).toEqual({
      type: "text",
      text: "Inspect dropped and pasted content",
    });
    expect(wire[1][1]).toMatchObject({
      type: "resource",
      resource: { mimeType: "text/plain", text: RICH_DROP_TEXT },
    });
    expect(wire[1][2]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: imageData,
    });
  } finally {
    await host.close();
    await rm(RICH_TEXT_PATH, { force: true });
    await rm(RICH_IMAGE_PATH, { force: true });
    await rm(DEMO_DIR, { recursive: true, force: true });
  }
});

test("reattaching a file after the composer reloads still attaches it", async ({}) => {
  await rm(WIRE_PATH, { force: true });
  await mkdir(BIN_DIR, { recursive: true });
  await writeFile(AGENT_PATH, AGENT_SOURCE, { mode: 0o755 });

  const host = await launchHost();
  try {
    const window = await host.firstWindow();
    const frame = await focusChat(window);
    await expect(frame.locator("#connect-btn")).toBeHidden();

    await openFileInEditor(window, "package.json");
    await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("VSCode ACP: Focus on Chat View");
    await window.waitForTimeout(300);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(1500);

    await frame.locator("#attach-btn").click();
    await attachFromQuickPick(window, "package.json");
    await expect(
      frame.locator("#attachments-bar .attachment-chip-name")
    ).toHaveText("package.json", { timeout: 10000 });

    // Force the composer webview to reload by switching the sidebar away and
    // back. The chip disappears with the webview; the extension host draft
    // must not keep holding the file.
    await window.keyboard.press(`${cmdOrCtrl()}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("Developer: Reload Webviews");
    await window.waitForTimeout(500);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(3000);

    const reloadedFrame = window
      .frameLocator("iframe.webview")
      .first()
      .frameLocator("#active-frame");
    await reloadedFrame.locator("#attach-btn").click();
    await attachFromQuickPick(window, "package.json");

    // Whether or not the reloaded webview kept the chip, selecting the file
    // again must leave exactly one live chip and raise no "not attached"
    // notice from a draft the composer can no longer see.
    await expect(
      reloadedFrame.locator("#attachments-bar .attachment-chip-name")
    ).toHaveText("package.json", { timeout: 10000 });
    await expect(reloadedFrame.locator(".message.system")).toHaveCount(0);
  } finally {
    await host.close();
    await rm(DEMO_DIR, { recursive: true, force: true });
  }
});
