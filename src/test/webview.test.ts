import * as assert from "assert";
import { JSDOM, DOMWindow } from "jsdom";
import {
  escapeHtml,
  getToolsHtml,
  updateSelectLabel,
  getElements,
  WebviewController,
  initWebview,
  type VsCodeApi,
  type Tool,
  type WebviewElements,
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
  
  <div id="messages"></div>
  
  <div id="input-container">
    <div id="command-autocomplete" role="listbox"></div>
    <textarea id="input" rows="1" placeholder="Ask your agent..."></textarea>
    <button id="send">Send</button>
  </div>
  
  <div id="options-bar">
    <select id="mode-selector" style="display: none;"></select>
    <select id="model-selector" style="display: none;"></select>
  </div>
</body>
</html>`;
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
        "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
      );
    });

    test("escapes double quotes", () => {
      assert.strictEqual(
        escapeHtml('a "quoted" string'),
        "a &quot;quoted&quot; string",
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
        '<!DOCTYPE html><select id="test"><option value="1" data-label="First">First</option><option value="2" data-label="Second">Second</option></select>',
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
        window as unknown as Window,
      );
    });

    teardown(() => {
      dom.window.close();
    });

    test("sends ready message on initialization", () => {
      const messages = mockVsCode._getMessages();
      assert.ok(
        messages.some((m: unknown) => (m as { type: string }).type === "ready"),
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

      test("handles connectionState", () => {
        controller.handleMessage({
          type: "connectionState",
          state: "connected",
        });
        assert.strictEqual(elements.statusText.textContent, "Connected");
        assert.strictEqual(elements.connectBtn.style.display, "none");
      });

      test("handles error", () => {
        controller.handleMessage({
          type: "error",
          text: "Something went wrong",
        });
        const msgs = elements.messagesEl.querySelectorAll(".message.error");
        assert.strictEqual(msgs.length, 1);
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

      test("handles streamEnd with HTML", () => {
        controller.handleMessage({ type: "streamStart" });
        controller.handleMessage({ type: "streamChunk", text: "**bold**" });
        controller.handleMessage({
          type: "streamEnd",
          html: "<strong>bold</strong>",
        });

        const msgs = elements.messagesEl.querySelectorAll(".message.assistant");
        assert.ok(msgs[0].innerHTML.includes("<strong>"));
      });
    });

    suite("button interactions", () => {
      test("connect button posts connect message", () => {
        mockVsCode._clearMessages();
        elements.connectBtn.click();
        const messages = mockVsCode._getMessages();
        assert.ok(
          messages.some(
            (m: unknown) => (m as { type: string }).type === "connect",
          ),
        );
      });

      test("welcome connect button posts connect message", () => {
        mockVsCode._clearMessages();
        elements.welcomeConnectBtn.click();
        const messages = mockVsCode._getMessages();
        assert.ok(
          messages.some(
            (m: unknown) => (m as { type: string }).type === "connect",
          ),
        );
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
              (m as { type: string; text?: string }).text === "Test message",
          ),
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
            (m: unknown) => (m as { type: string }).type === "sendMessage",
          ),
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
            (m: unknown) => (m as { type: string }).type === "sendMessage",
          ),
        );
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
          3,
        );
      });

      test("showCommandAutocomplete hides when empty", () => {
        controller.showCommandAutocomplete(testCommands);
        controller.showCommandAutocomplete([]);
        assert.ok(!elements.commandAutocomplete.classList.contains("visible"));
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

      test("sessionMetadata with commands updates commands", () => {
        controller.handleMessage({
          type: "sessionMetadata",
          commands: testCommands,
          modes: null,
          models: null,
        });
        const result = controller.getFilteredCommands("/");
        assert.strictEqual(result.length, 3);
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
          ".command-item.selected",
        );
        assert.ok(selectedItem);
      });
    });

    suite("state persistence", () => {
      test("restores input value from state", () => {
        mockVsCode.setState({ isConnected: false, inputValue: "saved text" });
        new WebviewController(
          mockVsCode,
          elements,
          document,
          window as unknown as Window,
        );
        assert.strictEqual(elements.inputEl.value, "saved text");
      });

      test("restores connection state from state", () => {
        mockVsCode.setState({ isConnected: true, inputValue: "" });
        const restoredController = new WebviewController(
          mockVsCode,
          elements,
          document,
          window as unknown as Window,
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
        dom.window as unknown as Window,
      );
      assert.ok(controller instanceof WebviewController);
    });
  });
});
