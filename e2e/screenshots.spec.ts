import { test, openACPView } from "./fixtures";
import { join } from "path";
import { Page, Frame } from "@playwright/test";

const SCREENSHOTS_DIR = join(__dirname, "..", "screenshots");

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
        console.log("Found webview content frame:", frame.url());
        return frame;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Webview content frame not found");
}

async function injectMockState(frame: Frame, setupFn: string): Promise<void> {
  const result = await frame.evaluate((fn) => {
    try {
      new Function(fn)();
      const messages = document.getElementById("messages");
      return {
        success: true,
        hasMessages: !!messages,
        childCount: messages?.childNodes.length || 0,
        welcomeHidden:
          document.getElementById("welcome-view")?.style.display === "none",
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }, setupFn);
  console.log("Injection result:", result);
}

const TOOL_ICONS_SETUP = `
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.querySelector(".status-text");
  const connectBtn = document.getElementById("connect-btn");
  const welcomeView = document.getElementById("welcome-view");
  const messagesEl = document.getElementById("messages");

  if (statusDot) statusDot.className = "status-dot connected";
  if (statusText) statusText.textContent = "Connected";
  if (connectBtn) connectBtn.style.display = "none";
  if (welcomeView) welcomeView.style.display = "none";
  if (messagesEl) messagesEl.style.display = "flex";

  const userMsg = document.createElement("div");
  userMsg.className = "message user";
  userMsg.innerHTML = "<p>Read config.json, then run the build</p>";
  messagesEl?.appendChild(userMsg);

  const assistantMsg = document.createElement("div");
  assistantMsg.className = "message assistant";
  assistantMsg.innerHTML = \`
    <p>I'll read the config and run the build for you.</p>
    <div class="tools-container">
      <details class="tool">
        <summary>
          <span class="tool-status">✓</span>
          <span class="tool-kind-icon" title="read">📖</span>
          <span class="tool-name">read_file</span>
        </summary>
      </details>
      <details class="tool">
        <summary>
          <span class="tool-status">✓</span>
          <span class="tool-kind-icon" title="execute">▶️</span>
          <span class="tool-name">bash</span>
        </summary>
      </details>
      <details class="tool">
        <summary>
          <span class="tool-status">✓</span>
          <span class="tool-kind-icon" title="edit">✏️</span>
          <span class="tool-name">write_file</span>
        </summary>
      </details>
      <details class="tool">
        <summary>
          <span class="tool-status">✓</span>
          <span class="tool-kind-icon" title="search">🔍</span>
          <span class="tool-name">grep</span>
        </summary>
      </details>
    </div>
    <p>Build completed successfully!</p>
  \`;
  messagesEl?.appendChild(assistantMsg);
`;

const ANSI_OUTPUT_SETUP = `
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.querySelector(".status-text");
  const connectBtn = document.getElementById("connect-btn");
  const welcomeView = document.getElementById("welcome-view");
  const messagesEl = document.getElementById("messages");

  if (statusDot) statusDot.className = "status-dot connected";
  if (statusText) statusText.textContent = "Connected";
  if (connectBtn) connectBtn.style.display = "none";
  if (welcomeView) welcomeView.style.display = "none";
  if (messagesEl) messagesEl.style.display = "flex";

  const userMsg = document.createElement("div");
  userMsg.className = "message user";
  userMsg.innerHTML = "<p>Run the tests please</p>";
  messagesEl?.appendChild(userMsg);

  const assistantMsg = document.createElement("div");
  assistantMsg.className = "message assistant";
  assistantMsg.innerHTML = \`
    <p>Running tests to check the codebase...</p>
    <details class="tool" open>
      <summary>
        <span class="tool-status">✓</span>
        <span class="tool-name">npm test</span>
      </summary>
      <div class="tool-content">
        <div class="tool-section">
          <div class="tool-label">Command</div>
          <pre class="tool-output">npm test</pre>
        </div>
        <div class="tool-section">
          <div class="tool-label">Output</div>
          <pre class="tool-output">
<span class="ansi-bold"> PASS </span> <span class="ansi-dim">src/test/</span>webview.test.ts
  ansiToHtml
    <span class="ansi-green">✓</span> converts red foreground color <span class="ansi-dim">(2ms)</span>
    <span class="ansi-green">✓</span> converts green foreground color
    <span class="ansi-green">✓</span> converts bold style <span class="ansi-dim">(1ms)</span>
    <span class="ansi-green">✓</span> handles nested styles
    <span class="ansi-green">✓</span> escapes HTML in plain text

<span class="ansi-bold"> FAIL </span> <span class="ansi-dim">src/test/</span>client.test.ts
  ACPClient
    <span class="ansi-green">✓</span> connects successfully
    <span class="ansi-red">✗</span> <span class="ansi-red">handles timeout correctly</span> <span class="ansi-dim">(5002ms)</span>

<span class="ansi-bold">Test Suites:</span> <span class="ansi-red">1 failed</span>, <span class="ansi-green">1 passed</span>, 2 total
<span class="ansi-bold">Tests:</span>       <span class="ansi-red">1 failed</span>, <span class="ansi-green">6 passed</span>, 7 total
<span class="ansi-dim">Time:</span>        <span class="ansi-cyan">3.456s</span>
          </pre>
        </div>
      </div>
    </details>
    <p>Tests completed. Found 1 failing test in <code>client.test.ts</code>.</p>
  \`;
  messagesEl?.appendChild(assistantMsg);
`;

const PLAN_DISPLAY_SETUP = `
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.querySelector(".status-text");
  const connectBtn = document.getElementById("connect-btn");
  const welcomeView = document.getElementById("welcome-view");
  const messagesEl = document.getElementById("messages");

  if (statusDot) statusDot.className = "status-dot connected";
  if (statusText) statusText.textContent = "Connected";
  if (connectBtn) connectBtn.style.display = "none";
  if (welcomeView) welcomeView.style.display = "none";
  if (messagesEl) messagesEl.style.display = "flex";

  const userMsg = document.createElement("div");
  userMsg.className = "message user";
  userMsg.innerHTML = "<p>Help me refactor the authentication module</p>";
  messagesEl?.appendChild(userMsg);

  const assistantMsg = document.createElement("div");
  assistantMsg.className = "message assistant";
  assistantMsg.innerHTML = "<p>I'll help you refactor this module. Here's my plan:</p>";
  messagesEl?.appendChild(assistantMsg);

  const planEl = document.createElement("div");
  planEl.className = "agent-plan";
  planEl.innerHTML = \`
    <div class="plan-header">
      <span class="plan-icon">📋</span>
      <span class="plan-title">Agent Plan</span>
      <span class="plan-progress">1/4</span>
    </div>
    <div class="plan-entries">
      <div class="plan-entry plan-entry-completed plan-priority-medium">
        <span class="plan-status-icon">✓</span>
        <span class="plan-content">Read existing implementation</span>
      </div>
      <div class="plan-entry plan-entry-in_progress plan-priority-high">
        <span class="plan-status-icon">⋯</span>
        <span class="plan-content">Identify code smells and improvements</span>
      </div>
      <div class="plan-entry plan-entry-pending plan-priority-medium">
        <span class="plan-status-icon">○</span>
        <span class="plan-content">Extract shared utilities</span>
      </div>
      <div class="plan-entry plan-entry-pending plan-priority-low">
        <span class="plan-status-icon">○</span>
        <span class="plan-content">Update imports across codebase</span>
      </div>
    </div>
  \`;
  messagesEl?.appendChild(planEl);

  const contMsg = document.createElement("div");
  contMsg.className = "message assistant";
  contMsg.innerHTML = "<p>Currently analyzing the code structure...</p>";
  messagesEl?.appendChild(contMsg);
`;

test.describe("Feature Screenshots", () => {
  test("ANSI color output in tool calls", async ({ window }) => {
    await openACPView(window);

    await window.waitForTimeout(2000);
    const frame = await getWebviewContentFrame(window);

    await injectMockState(frame, ANSI_OUTPUT_SETUP);
    await window.waitForTimeout(1000);

    const sidebarLocator = window.locator(
      ".split-view-view.visible .pane-body"
    );
    const sidebar = await sidebarLocator.first().boundingBox();

    if (sidebar) {
      console.log("Sidebar bounds:", sidebar);
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "ansi-output.png"),
        clip: {
          x: sidebar.x,
          y: sidebar.y,
          width: Math.min(sidebar.width, 450),
          height: sidebar.height,
        },
      });
    } else {
      console.log("Falling back to full window screenshot");
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "ansi-output.png"),
      });
    }
  });

  test("Agent plan display", async ({ window }) => {
    await openACPView(window);

    await window.waitForTimeout(2000);
    const frame = await getWebviewContentFrame(window);

    await injectMockState(frame, PLAN_DISPLAY_SETUP);
    await window.waitForTimeout(1000);

    const sidebarLocator = window.locator(
      ".split-view-view.visible .pane-body"
    );
    const sidebar = await sidebarLocator.first().boundingBox();

    if (sidebar) {
      console.log("Sidebar bounds:", sidebar);
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "plan-display.png"),
        clip: {
          x: sidebar.x,
          y: sidebar.y,
          width: Math.min(sidebar.width, 400),
          height: sidebar.height,
        },
      });
    } else {
      console.log("Falling back to full window screenshot");
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "plan-display.png"),
      });
    }
  });

  test("Tool kind icons", async ({ window }) => {
    await openACPView(window);

    await window.waitForTimeout(2000);
    const frame = await getWebviewContentFrame(window);

    await injectMockState(frame, TOOL_ICONS_SETUP);
    await window.waitForTimeout(1000);

    const sidebarLocator = window.locator(
      ".split-view-view.visible .pane-body"
    );
    const sidebar = await sidebarLocator.first().boundingBox();

    if (sidebar) {
      console.log("Sidebar bounds:", sidebar);
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "tool-icons.png"),
        clip: {
          x: sidebar.x,
          y: sidebar.y,
          width: Math.min(sidebar.width, 400),
          height: sidebar.height,
        },
      });
    } else {
      console.log("Falling back to full window screenshot");
      await window.screenshot({
        path: join(SCREENSHOTS_DIR, "tool-icons.png"),
      });
    }
  });
});
