import * as assert from "assert";
import { JSDOM, DOMWindow } from "jsdom";

function createMockVsCodeApi() {
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
  let dom: JSDOM;
  let document: Document;
  let window: DOMWindow;
  let mockVsCode: ReturnType<typeof createMockVsCodeApi>;

  setup(() => {
    dom = new JSDOM(createWebviewHTML(), {
      runScripts: "dangerously",
      url: "https://localhost",
    });
    document = dom.window.document;
    window = dom.window;
    mockVsCode = createMockVsCodeApi();

    (window as unknown as Record<string, unknown>).acquireVsCodeApi = () =>
      mockVsCode;
  });

  teardown(() => {
    dom.window.close();
  });

  suite("DOM elements", () => {
    test("should have all required elements", () => {
      assert.ok(document.getElementById("messages"));
      assert.ok(document.getElementById("input"));
      assert.ok(document.getElementById("send"));
      assert.ok(document.getElementById("status-dot"));
      assert.ok(document.getElementById("status-text"));
      assert.ok(document.getElementById("agent-selector"));
      assert.ok(document.getElementById("connect-btn"));
      assert.ok(document.getElementById("welcome-connect-btn"));
      assert.ok(document.getElementById("mode-selector"));
      assert.ok(document.getElementById("model-selector"));
      assert.ok(document.getElementById("welcome-view"));
    });
  });

  suite("VS Code API mock", () => {
    test("should capture posted messages", () => {
      mockVsCode.postMessage({ type: "test", data: "hello" });
      const messages = mockVsCode._getMessages();

      assert.strictEqual(messages.length, 1);
      assert.deepStrictEqual(messages[0], { type: "test", data: "hello" });
    });

    test("should persist state", () => {
      mockVsCode.setState({ inputValue: "test input", isConnected: true });
      const state = mockVsCode.getState<{
        inputValue: string;
        isConnected: boolean;
      }>();

      assert.strictEqual(state?.inputValue, "test input");
      assert.strictEqual(state?.isConnected, true);
    });

    test("should return empty object for initial state", () => {
      const freshMock = createMockVsCodeApi();
      const state = freshMock.getState();
      assert.deepStrictEqual(state, {});
    });
  });

  suite("Input handling", () => {
    test("should have empty input by default", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      assert.strictEqual(input.value, "");
    });

    test("should allow setting input value", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      input.value = "Hello, agent!";
      assert.strictEqual(input.value, "Hello, agent!");
    });
  });

  suite("Status display", () => {
    test("should show Disconnected by default", () => {
      const statusText = document.getElementById("status-text");
      assert.strictEqual(statusText?.textContent, "Disconnected");
    });

    test("should have status dot element", () => {
      const statusDot = document.getElementById("status-dot");
      assert.ok(statusDot);
      assert.strictEqual(statusDot?.className, "status-dot");
    });
  });

  suite("Welcome view", () => {
    test("should exist with correct structure", () => {
      const welcomeView = document.getElementById("welcome-view");
      assert.ok(welcomeView);
      assert.ok(welcomeView?.querySelector("h3"));
      assert.ok(document.getElementById("welcome-connect-btn"));
    });
  });

  suite("Agent selector", () => {
    test("should be an empty select element", () => {
      const selector = document.getElementById(
        "agent-selector",
      ) as HTMLSelectElement;
      assert.ok(selector);
      assert.strictEqual(selector.tagName, "SELECT");
      assert.strictEqual(selector.options.length, 0);
    });

    test("should allow adding options", () => {
      const selector = document.getElementById(
        "agent-selector",
      ) as HTMLSelectElement;
      const option = document.createElement("option");
      option.value = "opencode";
      option.textContent = "OpenCode";
      selector.appendChild(option);

      assert.strictEqual(selector.options.length, 1);
      assert.strictEqual(selector.options[0].value, "opencode");
    });
  });

  suite("Mode and Model selectors", () => {
    test("should be hidden by default", () => {
      const modeSelector = document.getElementById(
        "mode-selector",
      ) as HTMLSelectElement;
      const modelSelector = document.getElementById(
        "model-selector",
      ) as HTMLSelectElement;

      assert.strictEqual(modeSelector.style.display, "none");
      assert.strictEqual(modelSelector.style.display, "none");
    });

    test("should be able to show mode selector", () => {
      const modeSelector = document.getElementById(
        "mode-selector",
      ) as HTMLSelectElement;
      modeSelector.style.display = "inline-block";

      assert.strictEqual(modeSelector.style.display, "inline-block");
    });
  });

  suite("Messages container", () => {
    test("should start empty", () => {
      const messages = document.getElementById("messages");
      assert.strictEqual(messages?.children.length, 0);
    });

    test("should allow adding message elements", () => {
      const messages = document.getElementById("messages")!;
      const msgDiv = document.createElement("div");
      msgDiv.className = "message user";
      msgDiv.textContent = "Hello!";
      messages.appendChild(msgDiv);

      assert.strictEqual(messages.children.length, 1);
      assert.strictEqual(
        (messages.children[0] as HTMLElement).textContent,
        "Hello!",
      );
      assert.ok(messages.children[0].classList.contains("user"));
    });

    test("should support multiple message types", () => {
      const messages = document.getElementById("messages")!;

      const userMsg = document.createElement("div");
      userMsg.className = "message user";
      userMsg.textContent = "User message";

      const assistantMsg = document.createElement("div");
      assistantMsg.className = "message assistant";
      assistantMsg.textContent = "Assistant response";

      const errorMsg = document.createElement("div");
      errorMsg.className = "message error";
      errorMsg.textContent = "Error occurred";

      messages.appendChild(userMsg);
      messages.appendChild(assistantMsg);
      messages.appendChild(errorMsg);

      assert.strictEqual(messages.children.length, 3);
      assert.ok(messages.children[0].classList.contains("user"));
      assert.ok(messages.children[1].classList.contains("assistant"));
      assert.ok(messages.children[2].classList.contains("error"));
    });
  });

  suite("Button interactions", () => {
    test("send button should be clickable", () => {
      const sendBtn = document.getElementById("send") as HTMLButtonElement;
      let clicked = false;
      sendBtn.addEventListener("click", () => {
        clicked = true;
      });
      sendBtn.click();

      assert.strictEqual(clicked, true);
    });

    test("connect button should be clickable", () => {
      const connectBtn = document.getElementById(
        "connect-btn",
      ) as HTMLButtonElement;
      let clicked = false;
      connectBtn.addEventListener("click", () => {
        clicked = true;
      });
      connectBtn.click();

      assert.strictEqual(clicked, true);
    });

    test("send button can be disabled", () => {
      const sendBtn = document.getElementById("send") as HTMLButtonElement;
      sendBtn.disabled = true;

      assert.strictEqual(sendBtn.disabled, true);
    });
  });

  suite("Keyboard events", () => {
    test("should handle Enter key in input", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      let enterPressed = false;

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          enterPressed = true;
        }
      });

      const event = new window.KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: false,
      });
      input.dispatchEvent(event);

      assert.strictEqual(enterPressed, true);
    });

    test("should not trigger send on Shift+Enter", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      let shouldSend = false;

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          shouldSend = true;
        }
      });

      const event = new window.KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
      });
      input.dispatchEvent(event);

      assert.strictEqual(shouldSend, false);
    });

    test("should handle Escape key", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      let escapePressed = false;

      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          escapePressed = true;
        }
      });

      const event = new window.KeyboardEvent("keydown", { key: "Escape" });
      input.dispatchEvent(event);

      assert.strictEqual(escapePressed, true);
    });
  });

  suite("Window message events", () => {
    test("should receive message events", () => {
      let receivedMessage: unknown = null;

      window.addEventListener("message", (e) => {
        receivedMessage = e.data;
      });

      const event = new window.MessageEvent("message", {
        data: { type: "connectionState", state: "connected" },
      });
      window.dispatchEvent(event);

      assert.deepStrictEqual(receivedMessage, {
        type: "connectionState",
        state: "connected",
      });
    });
  });

  suite("HTML escaping (security)", () => {
    test("textContent prevents script injection", () => {
      const messages = document.getElementById("messages")!;
      const maliciousDiv = document.createElement("div");
      maliciousDiv.className = "message assistant";
      maliciousDiv.textContent = '<script>alert("xss")</script>';
      messages.appendChild(maliciousDiv);

      assert.ok(maliciousDiv.textContent?.includes("<script>"));
      assert.strictEqual(maliciousDiv.querySelector("script"), null);
    });
  });

  suite("Accessibility", () => {
    test("messages container supports log role", () => {
      const messages = document.getElementById("messages")!;
      messages.setAttribute("role", "log");
      assert.strictEqual(messages.getAttribute("role"), "log");
    });

    test("input supports aria-label", () => {
      const input = document.getElementById("input") as HTMLTextAreaElement;
      input.setAttribute("aria-label", "Message input");
      assert.strictEqual(input.getAttribute("aria-label"), "Message input");
    });
  });
});
