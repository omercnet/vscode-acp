import {
  test,
  expect,
  openACPView,
  getWebviewFrame,
  cmdOrCtrl,
} from "./fixtures";

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
  test("chat defaults to the secondary side bar", async ({ window }) => {
    await openACPView(window);

    const webview = window.locator("iframe.webview").first();
    await expect(webview).toBeVisible({ timeout: 15000 });
    const bounds = await webview.boundingBox();
    const viewport = window.viewportSize();

    expect(bounds).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(bounds!.x).toBeGreaterThan(viewport!.width / 2);
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
    await window.keyboard.press(`${modifier}+N`);
    await expect(
      window.locator('.tab[aria-label*="Untitled"]:visible').first()
    ).toBeVisible({ timeout: 5000 });
    await window
      .locator(".editor-group-container.active .editor-instance .monaco-editor")
      .first()
      .click();
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.waitForTimeout(500);
    await window.keyboard.type("ACP");
    await window.waitForTimeout(500);

    const startChatCommand = window.locator("text=ACP: Start Chat");
    await expect(startChatCommand).toBeVisible({ timeout: 5000 });

    const addSelectionCommand = window.locator(
      "text=ACP: Add Selection to Chat"
    );
    await expect(addSelectionCommand).toHaveCount(0);

    const loadSessionCommand = window.locator("text=ACP: Load Session");
    await expect(loadSessionCommand).toBeVisible({ timeout: 5000 });

    const deleteSessionCommand = window.locator("text=ACP: Delete Session");
    await expect(deleteSessionCommand).toBeVisible({ timeout: 5000 });

    await window.keyboard.press("Escape");
  });

  test("adds the editor selection to ACP chat with the shortcut", async ({
    window,
  }) => {
    const modifier = cmdOrCtrl();
    await window.keyboard.press(`${modifier}+P`);
    await window.waitForTimeout(300);
    await window.keyboard.type("README.md");
    const fileResult = window
      .locator(".quick-input-widget .monaco-list-row")
      .filter({ hasText: "README.md" })
      .first();
    await expect(fileResult).toBeVisible({ timeout: 5000 });
    await window.keyboard.press("Enter");
    await expect(
      window.locator('.tab[aria-label*="README.md"]:visible').first()
    ).toBeVisible({ timeout: 5000 });

    const editor = window
      .locator(".editor-group-container.active .editor-instance .monaco-editor")
      .first();
    await editor.locator(".view-lines").click();
    await window.keyboard.press(`${modifier}+G`);
    await window.keyboard.type("9");
    await window.keyboard.press("Enter");
    await window.keyboard.press("Home");
    await window.keyboard.press("Shift+End");
    await window.keyboard.press(`${modifier}+Shift+P`);
    await window.keyboard.type("ACP: Add Selection to Chat");
    const addSelectionCommand = window.locator(
      "text=ACP: Add Selection to Chat"
    );
    await expect(addSelectionCommand).toBeVisible({ timeout: 5000 });
    await window.keyboard.press("Escape");

    const shortcut =
      process.platform === "darwin"
        ? `${modifier}+Shift+I`
        : `${modifier}+Alt+Shift+I`;
    await window.keyboard.press(shortcut);

    const frame = getWebviewFrame(window);
    await expect(frame.locator(".attachment-chip-name")).toContainText(
      "README.md:L9",
      { timeout: 15000 }
    );
    await expect(frame.locator(".attachment-chip-type")).toHaveText(
      "Selection"
    );
    await expect(frame.locator("#input")).toBeFocused();
  });
});
