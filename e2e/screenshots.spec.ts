import { test, openACPView, getWebviewFrame } from "./fixtures";
import { join } from "path";

const SCREENSHOTS_DIR = join(__dirname, "..", "screenshots");

test.describe("Feature Screenshots", () => {
  test("ANSI color output in tool calls", async ({ window }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    await frame.locator("#connect-btn").waitFor({ timeout: 15000 });

    const innerFrame = await frame.locator("body").elementHandle();
    await innerFrame?.evaluate(() => {
      const statusDot = document.querySelector(".status-dot");
      const statusText = document.querySelector(".status-text");
      const connectBtn = document.getElementById("connect-btn");
      const welcomeView = document.querySelector(".welcome") as HTMLElement;
      const messagesEl = document.getElementById("messages") as HTMLElement;

      if (statusDot) statusDot.className = "status-dot connected";
      if (statusText) statusText.textContent = "Connected";
      if (connectBtn) (connectBtn as HTMLElement).style.display = "none";
      if (welcomeView) welcomeView.style.display = "none";
      if (messagesEl) messagesEl.style.display = "flex";

      const userMsg = document.createElement("div");
      userMsg.className = "message user";
      userMsg.innerHTML = "<p>Run the tests please</p>";
      messagesEl?.appendChild(userMsg);

      const assistantMsg = document.createElement("div");
      assistantMsg.className = "message assistant";
      assistantMsg.innerHTML = `
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
      `;
      messagesEl?.appendChild(assistantMsg);
    });

    await window.waitForTimeout(500);

    const viewport = window.viewportSize()!;
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "ansi-output.png"),
      clip: {
        x: 48,
        y: 35,
        width: 400,
        height: viewport.height - 35 - 25,
      },
    });
  });

  test("Agent plan display", async ({ window }) => {
    await openACPView(window);
    const frame = getWebviewFrame(window);

    await frame.locator("#connect-btn").waitFor({ timeout: 15000 });

    const innerFrame = await frame.locator("body").elementHandle();
    await innerFrame?.evaluate(() => {
      const statusDot = document.querySelector(".status-dot");
      const statusText = document.querySelector(".status-text");
      const connectBtn = document.getElementById("connect-btn");
      const welcomeView = document.querySelector(".welcome") as HTMLElement;
      const messagesEl = document.getElementById("messages") as HTMLElement;

      if (statusDot) statusDot.className = "status-dot connected";
      if (statusText) statusText.textContent = "Connected";
      if (connectBtn) (connectBtn as HTMLElement).style.display = "none";
      if (welcomeView) welcomeView.style.display = "none";
      if (messagesEl) messagesEl.style.display = "flex";

      const userMsg = document.createElement("div");
      userMsg.className = "message user";
      userMsg.innerHTML = "<p>Help me refactor the authentication module</p>";
      messagesEl?.appendChild(userMsg);

      const assistantMsg = document.createElement("div");
      assistantMsg.className = "message assistant";
      assistantMsg.innerHTML =
        "<p>I'll help you refactor this module. Here's my plan:</p>";
      messagesEl?.appendChild(assistantMsg);

      const planEl = document.createElement("div");
      planEl.className = "agent-plan";
      planEl.innerHTML = `
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
      `;
      messagesEl?.appendChild(planEl);

      const contMsg = document.createElement("div");
      contMsg.className = "message assistant";
      contMsg.innerHTML = "<p>Currently analyzing the code structure...</p>";
      messagesEl?.appendChild(contMsg);
    });

    await window.waitForTimeout(500);

    const viewport = window.viewportSize()!;
    await window.screenshot({
      path: join(SCREENSHOTS_DIR, "plan-display.png"),
      clip: {
        x: 48,
        y: 35,
        width: 350,
        height: viewport.height - 35 - 25,
      },
    });
  });
});
