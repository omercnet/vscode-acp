import {
  test,
  expect,
  openACPView,
  getWebviewFrame,
  cmdOrCtrl,
} from "./fixtures";
import { join } from "path";

const SCREENSHOTS_DIR = join(__dirname, "..", "screenshots");

test.describe("VSCode ACP Extension", () => {
  test("extension activates and shows in activity bar", async ({ window }) => {
    await window.waitForTimeout(2000);

    const acpActivityItem = window.locator(
      '.action-label[aria-label="VSCode ACP"]'
    );
    await expect(acpActivityItem).toBeVisible({ timeout: 10000 });
  });

  test("sidebar shows welcome message when disconnected", async ({
    window,
  }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    const welcomeText = frame.locator("text=Welcome to VSCode ACP");
    await expect(welcomeText).toBeVisible({ timeout: 15000 });
  });

  test("sidebar shows Connect button", async ({ window }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    const connectButton = frame.locator("#connect-btn");
    await expect(connectButton).toBeVisible({ timeout: 15000 });
  });

  test("sidebar shows agent selector dropdown", async ({ window }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    const agentSelector = frame.locator("#agent-selector");
    await expect(agentSelector).toBeVisible({ timeout: 15000 });
  });

  test("chat input field is present", async ({ window }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    const chatInput = frame.locator("#input");
    await expect(chatInput).toBeVisible({ timeout: 15000 });
  });

  test("command palette shows ACP commands", async ({ window }) => {
    const modifier = cmdOrCtrl();
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("ACP");
    await window.waitForTimeout(500);

    const startChatCommand = window.locator("text=ACP: Start Chat");
    await expect(startChatCommand).toBeVisible({ timeout: 5000 });

    const loadSessionCommand = window.locator("text=ACP: Load Session");
    await expect(loadSessionCommand).toBeVisible({ timeout: 5000 });

    const deleteSessionCommand = window.locator("text=ACP: Delete Session");
    await expect(deleteSessionCommand).toBeVisible({ timeout: 5000 });

    await window.keyboard.press("Escape");
  });

  test("selects and sends the current file as a resource link", async ({
    window,
  }) => {
    await openACPView(window);
    await window.getByRole("tab", { name: /Explorer/ }).click();
    const packageFile = window.getByRole("treeitem", {
      name: /^package\.json/,
    });
    await packageFile.click();
    await window.waitForTimeout(1000);
    await window.getByRole("tab", { name: "VSCode ACP" }).click();

    const frame = getWebviewFrame(window);
    await frame.locator("#attach-btn").click();

    const quickPick = window.locator(".quick-input-widget");
    await expect(quickPick).toBeVisible({ timeout: 5000 });
    const packageItem = quickPick
      .getByText("package.json", { exact: false })
      .first();
    await expect(packageItem).toBeVisible({ timeout: 5000 });
    await packageItem.click();
    await window.keyboard.press("Enter");

    const selectedChip = frame.locator(
      "#attachments-bar .attachment-chip-name"
    );
    await expect(selectedChip).toHaveText("package.json", { timeout: 5000 });
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "resource-link-selected.png"),
    });

    await frame.locator("#input").fill("Review this project manifest");
    await frame.locator("#send").click();

    const sentChip = frame.locator(".message.user .attachment-chip-name");
    await expect(sentChip).toHaveText("package.json", { timeout: 5000 });
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "resource-link-sent.png"),
    });
  });
});
