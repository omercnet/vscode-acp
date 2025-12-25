interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): T;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface Tool {
  name: string;
  input: string | null;
  output: string | null;
  status: "running" | "completed" | "failed";
}

interface WebviewState {
  isConnected: boolean;
  inputValue: string;
}

interface ExtensionMessage {
  type: string;
  text?: string;
  html?: string;
  state?: string;
  agents?: Array<{ id: string; name: string; available: boolean }>;
  selected?: string;
  agentId?: string;
  modeId?: string;
  modelId?: string;
  modes?: {
    availableModes: Array<{ id: string; name: string }>;
    currentModeId: string;
  } | null;
  models?: {
    availableModels: Array<{ modelId: string; name: string }>;
    currentModelId: string;
  } | null;
  toolCallId?: string;
  name?: string;
  title?: string;
  content?: Array<{ content?: { text?: string } }>;
  rawInput?: { command?: string; description?: string };
  rawOutput?: { output?: string };
  status?: string;
}

(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages")!;
  const inputEl = document.getElementById("input") as HTMLTextAreaElement;
  const sendBtn = document.getElementById("send") as HTMLButtonElement;
  const statusDot = document.getElementById("status-dot")!;
  const statusText = document.getElementById("status-text")!;
  const agentSelector = document.getElementById(
    "agent-selector",
  ) as HTMLSelectElement;
  const connectBtn = document.getElementById(
    "connect-btn",
  ) as HTMLButtonElement;
  const welcomeConnectBtn = document.getElementById(
    "welcome-connect-btn",
  ) as HTMLButtonElement;
  const modeSelector = document.getElementById(
    "mode-selector",
  ) as HTMLSelectElement;
  const modelSelector = document.getElementById(
    "model-selector",
  ) as HTMLSelectElement;
  const welcomeView = document.getElementById("welcome-view")!;

  let currentAssistantMessage: HTMLElement | null = null;
  let currentAssistantText = "";
  let thinkingEl: HTMLElement | null = null;
  let tools: Record<string, Tool> = {};
  let isConnected = false;
  const messageTexts = new Map<HTMLElement, string>();

  const previousState = vscode.getState<WebviewState>();
  if (previousState) {
    isConnected = previousState.isConnected;
    inputEl.value = previousState.inputValue || "";
  }

  function saveState(): void {
    vscode.setState<WebviewState>({
      isConnected,
      inputValue: inputEl.value,
    });
  }

  function updateSelectLabel(select: HTMLSelectElement, prefix: string): void {
    Array.from(select.options).forEach((opt) => {
      opt.textContent = opt.dataset.label || opt.textContent;
    });
    const selected = select.options[select.selectedIndex];
    if (selected && selected.dataset.label) {
      selected.textContent = prefix + ": " + selected.dataset.label;
    }
  }

  function addMessage(
    text: string,
    type: "user" | "assistant" | "error" | "system",
  ): HTMLElement {
    const div = document.createElement("div");
    div.className = "message " + type;
    div.setAttribute("role", "article");
    div.setAttribute("tabindex", "0");

    const label =
      type === "user"
        ? "Your message"
        : type === "assistant"
          ? "Agent response"
          : type === "error"
            ? "Error message"
            : "System message";
    div.setAttribute("aria-label", label);

    if (type === "assistant" || type === "user") {
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const msgText = messageTexts.get(div) || div.textContent || "";
        vscode.postMessage({ type: "copyMessage", text: msgText });
      });
    }

    div.textContent = text;
    messageTexts.set(div, text);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    announceToScreenReader(label + ": " + text.substring(0, 100));
    return div;
  }

  function announceToScreenReader(message: string): void {
    const announcement = document.createElement("div");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    announcement.className = "sr-only";
    announcement.textContent = message;
    document.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function getToolsHtml(): string {
    const toolIds = Object.keys(tools);
    if (toolIds.length === 0) return "";
    const toolItems = toolIds
      .map((id) => {
        const tool = tools[id];
        const statusIcon =
          tool.status === "completed"
            ? "✓"
            : tool.status === "failed"
              ? "✗"
              : "⋯";
        const statusClass = tool.status === "running" ? "running" : "";
        let detailsContent = "";
        if (tool.input) {
          detailsContent +=
            '<div class="tool-input"><strong>$</strong> ' +
            escapeHtml(tool.input) +
            "</div>";
        }
        if (tool.output) {
          const truncated =
            tool.output.length > 500
              ? tool.output.slice(0, 500) + "..."
              : tool.output;
          detailsContent +=
            '<pre class="tool-output">' + escapeHtml(truncated) + "</pre>";
        }
        if (detailsContent) {
          return (
            '<li><details class="tool-item"><summary><span class="tool-status ' +
            statusClass +
            '" aria-label="' +
            tool.status +
            '">' +
            statusIcon +
            "</span> " +
            escapeHtml(tool.name) +
            "</summary>" +
            detailsContent +
            "</details></li>"
          );
        }
        return (
          '<li><span class="tool-status ' +
          statusClass +
          '" aria-label="' +
          tool.status +
          '">' +
          statusIcon +
          "</span> " +
          escapeHtml(tool.name) +
          "</li>"
        );
      })
      .join("");
    return (
      '<details class="tool-details" open><summary aria-label="' +
      toolIds.length +
      ' tools used">' +
      toolIds.length +
      " tool" +
      (toolIds.length > 1 ? "s" : "") +
      '</summary><ul class="tool-list" role="list">' +
      toolItems +
      "</ul></details>"
    );
  }

  function showThinking(): void {
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "message assistant";
      thinkingEl.setAttribute("role", "status");
      thinkingEl.setAttribute("aria-label", "Agent is thinking");
      messagesEl.appendChild(thinkingEl);
    }
    let html = '<span class="thinking" aria-label="Processing">Thinking</span>';
    html += getToolsHtml();
    thinkingEl.innerHTML = html;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideThinking(): void {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function updateStatus(state: string): void {
    statusDot.className = "status-dot " + state;
    const labels: Record<string, string> = {
      disconnected: "Disconnected",
      connecting: "Connecting...",
      connected: "Connected",
      error: "Error",
    };
    statusText.textContent = labels[state] || state;
    isConnected = state === "connected";
    updateViewState();
    saveState();
  }

  function updateViewState(): void {
    const hasMessages = messagesEl.children.length > 0;
    welcomeView.style.display = !isConnected && !hasMessages ? "flex" : "none";
    messagesEl.style.display = isConnected || hasMessages ? "flex" : "none";
  }

  function send(): void {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "sendMessage", text });
    inputEl.value = "";
    inputEl.style.height = "auto";
    sendBtn.disabled = true;
    saveState();
  }

  function clearInput(): void {
    inputEl.value = "";
    inputEl.style.height = "auto";
    inputEl.focus();
    saveState();
  }

  sendBtn.addEventListener("click", send);

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearInput();
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
    saveState();
  });

  messagesEl.addEventListener("keydown", (e) => {
    const messages = Array.from(messagesEl.querySelectorAll(".message"));
    const currentIndex = messages.indexOf(document.activeElement as Element);

    if (e.key === "ArrowDown" && currentIndex < messages.length - 1) {
      e.preventDefault();
      (messages[currentIndex + 1] as HTMLElement).focus();
    } else if (e.key === "ArrowUp" && currentIndex > 0) {
      e.preventDefault();
      (messages[currentIndex - 1] as HTMLElement).focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      (messages[0] as HTMLElement)?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      (messages[messages.length - 1] as HTMLElement)?.focus();
    }
  });

  connectBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "connect" });
  });

  welcomeConnectBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "connect" });
  });

  agentSelector.addEventListener("change", () => {
    vscode.postMessage({ type: "selectAgent", agentId: agentSelector.value });
  });

  modeSelector.addEventListener("change", () => {
    updateSelectLabel(modeSelector, "Mode");
    vscode.postMessage({ type: "selectMode", modeId: modeSelector.value });
  });

  modelSelector.addEventListener("change", () => {
    updateSelectLabel(modelSelector, "Model");
    vscode.postMessage({ type: "selectModel", modelId: modelSelector.value });
  });

  window.addEventListener("message", (e: MessageEvent<ExtensionMessage>) => {
    const msg = e.data;
    switch (msg.type) {
      case "userMessage":
        addMessage(msg.text!, "user");
        showThinking();
        updateViewState();
        break;
      case "streamStart":
        currentAssistantText = "";
        break;
      case "streamChunk":
        if (!currentAssistantMessage) {
          hideThinking();
          currentAssistantMessage = addMessage("", "assistant");
        }
        currentAssistantText += msg.text;
        currentAssistantMessage.textContent = currentAssistantText;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      case "streamEnd":
        hideThinking();
        if (currentAssistantMessage) {
          let html = msg.html || "";
          html += getToolsHtml();
          currentAssistantMessage.innerHTML = html;
          messageTexts.set(currentAssistantMessage, currentAssistantText);
        }
        currentAssistantMessage = null;
        currentAssistantText = "";
        tools = {};
        sendBtn.disabled = false;
        inputEl.focus();
        break;
      case "toolCallStart":
        tools[msg.toolCallId!] = {
          name: msg.name!,
          input: null,
          output: null,
          status: "running",
        };
        showThinking();
        break;
      case "toolCallComplete":
        if (tools[msg.toolCallId!]) {
          const output =
            msg.content?.[0]?.content?.text || msg.rawOutput?.output || "";
          const input =
            msg.rawInput?.command || msg.rawInput?.description || "";
          if (msg.title) tools[msg.toolCallId!].name = msg.title;
          tools[msg.toolCallId!].input = input;
          tools[msg.toolCallId!].output = output;
          tools[msg.toolCallId!].status = msg.status as Tool["status"];
          showThinking();
        }
        break;
      case "error":
        hideThinking();
        addMessage(msg.text!, "error");
        sendBtn.disabled = false;
        inputEl.focus();
        break;
      case "agentError":
        addMessage(msg.text!, "error");
        break;
      case "connectionState":
        updateStatus(msg.state!);
        connectBtn.style.display =
          msg.state === "connected" ? "none" : "inline-block";
        break;
      case "agents":
        agentSelector.innerHTML = "";
        msg.agents!.forEach((a) => {
          const opt = document.createElement("option");
          opt.value = a.id;
          opt.textContent = a.available ? a.name : a.name + " (not installed)";
          if (!a.available) {
            opt.style.color = "var(--vscode-disabledForeground)";
          }
          if (a.id === msg.selected) opt.selected = true;
          agentSelector.appendChild(opt);
        });
        break;
      case "agentChanged":
      case "chatCleared":
        messagesEl.innerHTML = "";
        currentAssistantMessage = null;
        messageTexts.clear();
        modeSelector.style.display = "none";
        modelSelector.style.display = "none";
        updateViewState();
        break;
      case "triggerNewChat":
        vscode.postMessage({ type: "newChat" });
        break;
      case "triggerClearChat":
        vscode.postMessage({ type: "clearChat" });
        break;
      case "sessionMetadata": {
        const hasModes =
          msg.modes &&
          msg.modes.availableModes &&
          msg.modes.availableModes.length > 0;
        const hasModels =
          msg.models &&
          msg.models.availableModels &&
          msg.models.availableModels.length > 0;

        if (hasModes) {
          modeSelector.style.display = "inline-block";
          modeSelector.innerHTML = "";
          msg.modes!.availableModes.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.name || m.id;
            opt.dataset.label = m.name || m.id;
            if (m.id === msg.modes!.currentModeId) opt.selected = true;
            modeSelector.appendChild(opt);
          });
          updateSelectLabel(modeSelector, "Mode");
        } else {
          modeSelector.style.display = "none";
        }

        if (hasModels) {
          modelSelector.style.display = "inline-block";
          modelSelector.innerHTML = "";
          msg.models!.availableModels.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = m.modelId;
            opt.textContent = m.name || m.modelId;
            opt.dataset.label = m.name || m.modelId;
            if (m.modelId === msg.models!.currentModelId) opt.selected = true;
            modelSelector.appendChild(opt);
          });
          updateSelectLabel(modelSelector, "Model");
        } else {
          modelSelector.style.display = "none";
        }
        break;
      }
      case "modeUpdate":
        if (msg.modeId) {
          modeSelector.value = msg.modeId;
          updateSelectLabel(modeSelector, "Mode");
        }
        break;
    }
  });

  updateViewState();
  vscode.postMessage({ type: "ready" });
})();
