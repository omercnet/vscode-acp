import { test, expect, cmdOrCtrl } from "./fixtures";

test.describe("VSCode ACP Extension", () => {
  test("extension activates and shows in activity bar", async ({ window }) => {
    await window.waitForTimeout(2000);

    const acpActivityItem = window.locator(
      '.action-item[aria-label*="VSCode ACP"]'
    );
    await expect(acpActivityItem).toBeVisible({ timeout: 10000 });
  });

  test("sidebar shows welcome message when disconnected", async ({
    window,
  }) => {
    const modifier = cmdOrCtrl();
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("View: Focus on Chat View");
    await window.waitForTimeout(300);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(3000);

    const webviewFrame = window.frameLocator("iframe.webview").first();
    const innerFrame = webviewFrame.frameLocator("#active-frame");

    const welcomeText = innerFrame.locator("text=Welcome to VSCode ACP");
    await expect(welcomeText).toBeVisible({ timeout: 15000 });
  });

  test("sidebar shows Connect button", async ({ window }) => {
    const modifier = cmdOrCtrl();
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("View: Focus on Chat View");
    await window.waitForTimeout(300);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(3000);

    const webviewFrame = window.frameLocator("iframe.webview").first();
    const innerFrame = webviewFrame.frameLocator("#active-frame");

    const connectButton = innerFrame.locator("#connect-btn");
    await expect(connectButton).toBeVisible({ timeout: 15000 });
  });

  test("sidebar shows agent selector dropdown", async ({ window }) => {
    const modifier = cmdOrCtrl();
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("View: Focus on Chat View");
    await window.waitForTimeout(300);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(3000);

    const webviewFrame = window.frameLocator("iframe.webview").first();
    const innerFrame = webviewFrame.frameLocator("#active-frame");

    const agentSelector = innerFrame.locator("#agent-selector");
    await expect(agentSelector).toBeVisible({ timeout: 15000 });
  });

  test("chat input field is present", async ({ window }) => {
    const modifier = cmdOrCtrl();
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("View: Focus on Chat View");
    await window.waitForTimeout(300);
    await window.keyboard.press("Enter");
    await window.waitForTimeout(3000);

    const webviewFrame = window.frameLocator("iframe.webview").first();
    const innerFrame = webviewFrame.frameLocator("#active-frame");

    const chatInput = innerFrame.locator("#input");
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

    await window.keyboard.press("Escape");
  });
});
