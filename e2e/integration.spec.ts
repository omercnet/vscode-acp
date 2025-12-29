import { test, expect, openACPView, getWebviewFrame } from "./fixtures";
import { Frame, Page, FrameLocator } from "@playwright/test";

async function getWebviewContentFrame(window: Page): Promise<Frame> {
  const allFrames: Frame[] = [];

  function collectFrames(frameList: Frame[]) {
    for (const f of frameList) {
      allFrames.push(f);
      collectFrames(f.childFrames());
    }
  }
  collectFrames(window.frames());

  for (const frame of allFrames) {
    try {
      const hasWelcomeView = await frame.locator("#welcome-view").count();
      if (hasWelcomeView > 0) {
        return frame;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Webview content frame not found");
}

async function selectNanoModel(
  modelSelector: ReturnType<FrameLocator["locator"]>
): Promise<void> {
  const options = await modelSelector.locator("option").allTextContents();
  console.log("Available models:", options);

  const nanoModel = options.find(
    (o) => o.toLowerCase().includes("nano") || o.toLowerCase().includes("gpt-5")
  );
  if (nanoModel) {
    await modelSelector.selectOption({ label: nanoModel });
  }
}

async function connectToOpenCode(
  frame: FrameLocator,
  window: Page
): Promise<void> {
  const agentSelector = frame.locator("#agent-selector");
  await expect(agentSelector).toBeVisible({ timeout: 15000 });
  await agentSelector.selectOption("opencode");
  await frame.locator("#connect-btn").click();

  await expect(frame.locator("#status-text")).toHaveText("Connected", {
    timeout: 30000,
  });
}

test.describe("OpenCode Integration", () => {
  test.beforeEach(async () => {
    const { execSync } = await import("child_process");
    try {
      execSync("which opencode", { stdio: "ignore" });
    } catch {
      test.skip();
    }
  });

  test("connects to OpenCode and receives session metadata", async ({
    window,
  }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    await expect(frame.locator("#connect-btn")).toBeVisible({ timeout: 15000 });

    const agentSelector = frame.locator("#agent-selector");
    await expect(agentSelector).toBeVisible();

    const openCodeOption = agentSelector.locator('option[value="opencode"]');
    const hasOpenCode = (await openCodeOption.count()) > 0;

    if (!hasOpenCode) {
      test.skip();
      return;
    }

    await agentSelector.selectOption("opencode");
    await window.waitForTimeout(500);

    await frame.locator("#connect-btn").click();

    await expect(frame.locator("#status-text")).toHaveText("Connected", {
      timeout: 30000,
    });

    await expect(frame.locator("#welcome-view")).toBeHidden({ timeout: 5000 });

    await expect(frame.locator("#mode-selector")).toBeVisible({
      timeout: 10000,
    });
  });

  test("can select gpt-5-nano model and send a message", async ({ window }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    await connectToOpenCode(frame, window);

    const modelSelector = frame.locator("#model-selector");
    await expect(modelSelector).toBeVisible({ timeout: 10000 });

    await selectNanoModel(modelSelector);

    await window.waitForTimeout(500);

    const inputEl = frame.locator("#input");
    await inputEl.fill("Say hello");
    await inputEl.press("Enter");

    await expect(frame.locator(".message.assistant")).toBeVisible({
      timeout: 60000,
    });
  });

  test("permission modal appears when agent requests permission", async ({
    window,
  }) => {
    test.setTimeout(120000);

    await openACPView(window);
    const frame = getWebviewFrame(window);

    await connectToOpenCode(frame, window);

    const modelSelector = frame.locator("#model-selector");
    await expect(modelSelector).toBeVisible({ timeout: 10000 });

    await selectNanoModel(modelSelector);

    await window.waitForTimeout(500);

    const inputEl = frame.locator("#input");
    await inputEl.fill(
      "Read the contents of package.json and tell me the name"
    );
    await inputEl.press("Enter");

    const permissionModal = frame.locator("#permission-modal");
    await expect(permissionModal).toBeVisible({ timeout: 60000 });

    const permissionDetails = frame.locator("#permission-details");
    await expect(permissionDetails).toBeVisible();

    const permissionOptions = frame.locator("#permission-options");
    await expect(permissionOptions).toBeVisible();

    const buttons = permissionOptions.locator("button");
    await expect(buttons.first()).toBeVisible();

    const allowButton = permissionOptions.locator(".permission-btn-allow");
    await expect(allowButton.first()).toBeVisible();

    await allowButton.first().click();

    await expect(permissionModal).toBeHidden({ timeout: 5000 });

    await expect(frame.locator(".message.assistant")).toBeVisible({
      timeout: 60000,
    });
  });

  test("permission modal can be cancelled with Escape", async ({ window }) => {
    test.setTimeout(120000);

    await openACPView(window);
    const frame = getWebviewFrame(window);

    await connectToOpenCode(frame, window);

    const modelSelector = frame.locator("#model-selector");
    await expect(modelSelector).toBeVisible({ timeout: 10000 });

    await selectNanoModel(modelSelector);

    await window.waitForTimeout(500);

    const inputEl = frame.locator("#input");
    await inputEl.fill("List the files in the current directory");
    await inputEl.press("Enter");

    const permissionModal = frame.locator("#permission-modal");
    await expect(permissionModal).toBeVisible({ timeout: 60000 });

    await window.keyboard.press("Escape");

    await expect(permissionModal).toBeHidden({ timeout: 5000 });
  });

  test("permission modal closes on backdrop click", async ({ window }) => {
    test.setTimeout(120000);

    await openACPView(window);

    const contentFrame = await getWebviewContentFrame(window);
    const frame = getWebviewFrame(window);

    await connectToOpenCode(frame, window);

    const modelSelector = frame.locator("#model-selector");
    await expect(modelSelector).toBeVisible({ timeout: 10000 });

    await selectNanoModel(modelSelector);

    await window.waitForTimeout(500);

    const inputEl = frame.locator("#input");
    await inputEl.fill("Check what files exist in src folder");
    await inputEl.press("Enter");

    const permissionModal = frame.locator("#permission-modal");
    await expect(permissionModal).toBeVisible({ timeout: 60000 });

    const modalBox = await permissionModal.boundingBox();
    if (modalBox) {
      await contentFrame.click("#permission-modal", {
        position: { x: 5, y: 5 },
        force: true,
      });
    }

    await expect(permissionModal).toBeHidden({ timeout: 5000 });
  });
});
