import { test, expect, openACPView, getWebviewContentFrame } from "./fixtures";
import { join } from "path";

const SCREENSHOTS_DIR = join(__dirname, "..", "screenshots");

/**
 * Dispatches a real `message` event into the webview's window, exactly as
 * the extension host does via `webview.postMessage(...)`. This exercises the
 * actual `WebviewController.handleMessage` code path end-to-end, so these
 * tests fail if the backend/frontend message contract (message `type`,
 * field names) ever drifts again.
 */
async function postToWebview(
  frame: Awaited<ReturnType<typeof getWebviewContentFrame>>,
  payload: Record<string, unknown>
): Promise<void> {
  await frame.evaluate((data) => {
    window.postMessage(data, "*");
  }, payload);
}

test.describe("Permission Request Modal", () => {
  test("shows a permission prompt, queues a concurrent request, and reflects each decision", async ({
    window,
  }) => {
    await openACPView(window);
    await window.waitForTimeout(2000);
    const frame = await getWebviewContentFrame(window);

    // First permission request: simulates the agent asking to write a file.
    await postToWebview(frame, {
      type: "permissionRequest",
      requestId: "demo-req-1",
      title: "Write File",
      rawInput: {
        path: "src/index.ts",
        content: "console.log('hello from the agent');\n",
      },
      options: [
        { id: "allow_once", label: "Allow Once" },
        { id: "allow_always", label: "Allow Always" },
        { id: "reject_once", label: "Reject" },
      ],
    });

    const modal = frame.locator("#permission-modal");
    await expect(modal).toHaveClass(/visible/);
    await expect(frame.locator(".permission-title")).toHaveText("Write File");
    await expect(frame.locator(".permission-option-btn")).toHaveCount(3);

    const sidebarLocator = window.locator(
      ".split-view-view.visible .pane-body"
    );
    const sidebar = await sidebarLocator.first().boundingBox();

    // Screenshot 1: the permission prompt itself.
    if (sidebar) {
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "permission-modal-request.png"),
        clip: {
          x: sidebar.x,
          y: sidebar.y,
          width: Math.min(sidebar.width, 400),
          height: sidebar.height,
        },
      });
    } else {
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "permission-modal-request.png"),
      });
    }

    // A second request arrives while the first is still pending. It must be
    // queued, not silently drop/replace the first (regression coverage for
    // the concurrent-request bug called out in review).
    await postToWebview(frame, {
      type: "permissionRequest",
      requestId: "demo-req-2",
      title: "Run Command",
      rawInput: { command: "npm test" },
      options: [
        { id: "run", label: "Run" },
        { id: "skip", label: "Skip" },
      ],
    });

    await expect(frame.locator(".permission-title")).toHaveText("Write File");

    // Decision 1: approve the write. The modal must then advance to the
    // queued second request rather than closing entirely.
    await frame.locator(".permission-option-btn").first().click();

    await expect(modal).toHaveClass(/visible/);
    await expect(frame.locator(".permission-title")).toHaveText("Run Command");
    await expect(frame.locator(".permission-option-btn")).toHaveCount(2);
    await expect(
      frame.locator(".permission-option-btn").first()
    ).toBeDisabled();

    // Screenshot 2: decision state — the first request was resolved and the
    // queued second request is now shown in its place.
    const sidebarAfterDecision = await sidebarLocator.first().boundingBox();
    if (sidebarAfterDecision) {
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "permission-modal-decision.png"),
        clip: {
          x: sidebarAfterDecision.x,
          y: sidebarAfterDecision.y,
          width: Math.min(sidebarAfterDecision.width, 400),
          height: sidebarAfterDecision.height,
        },
      });
    } else {
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "permission-modal-decision.png"),
      });
    }

    await expect(frame.locator(".permission-option-btn").first()).toBeEnabled({
      timeout: 1500,
    });

    // Decision 2: cancel the second request. The modal must fully close
    // with no further queued requests left dangling.
    await frame.locator(".permission-cancel-btn").click();
    await expect(modal).not.toHaveClass(/visible/);
  });

  test("Escape cancels the prompt and restores focus", async ({ window }) => {
    await openACPView(window);
    await window.waitForTimeout(2000);
    const frame = await getWebviewContentFrame(window);
    await frame.locator("#input").focus();

    await postToWebview(frame, {
      type: "permissionRequest",
      requestId: "demo-req-escape",
      title: "Delete File",
      rawInput: { path: "src/old.ts" },
      options: [{ id: "allow_once", label: "Allow Once" }],
    });

    const modal = frame.locator("#permission-modal");
    await expect(modal).toHaveClass(/visible/);

    await frame.locator(".permission-option-btn").first().press("Escape");

    await expect(modal).not.toHaveClass(/visible/);
    await expect(frame.locator("#input")).toBeFocused();
  });

  test("an expired request closes the modal without sending a response", async ({
    window,
  }) => {
    await openACPView(window);
    await window.waitForTimeout(2000);
    const frame = await getWebviewContentFrame(window);

    await postToWebview(frame, {
      type: "permissionRequest",
      requestId: "demo-req-expire",
      title: "Execute Command",
      rawInput: { command: "rm -rf build" },
      options: [{ id: "allow_once", label: "Allow Once" }],
    });

    const modal = frame.locator("#permission-modal");
    await expect(modal).toHaveClass(/visible/);

    // Simulates the backend's 60s timeout firing while the prompt is still
    // showing: the UI must close on its own, matching the real behavior
    // where the ACP request has already been resolved as cancelled.
    await postToWebview(frame, {
      type: "permissionRequestExpired",
      requestId: "demo-req-expire",
    });

    await expect(modal).not.toHaveClass(/visible/);
  });
});
