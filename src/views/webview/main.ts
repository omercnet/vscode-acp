export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): T;
}

declare function acquireVsCodeApi(): VsCodeApi;

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface Tool {
  name: string;
  input: string | null;
  output: string | null;
  status: "running" | "completed" | "failed";
  kind?: ToolKind;
}

export interface WebviewState {
  isConnected: boolean;
  inputValue: string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface ExtensionMessage {
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
  commands?: AvailableCommand[] | null;
  plan?: { entries: PlanEntry[] };
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: ToolKind;
  content?: Array<{ content?: { text?: string } }>;
  rawInput?: { command?: string; description?: string };
  rawOutput?: { output?: string };
  status?: string;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TOOL_KIND_ICONS: Record<ToolKind, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑️",
  move: "📦",
  search: "🔍",
  execute: "▶️",
  think: "🧠",
  fetch: "🌐",
  switch_mode: "🔄",
  other: "⚙️",
};

export function getToolKindIcon(kind?: ToolKind): string {
  return kind ? TOOL_KIND_ICONS[kind] || TOOL_KIND_ICONS.other : "";
}

const ANSI_FOREGROUND: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

const ANSI_BACKGROUND: Record<number, string> = {
  40: "ansi-bg-black",
  41: "ansi-bg-red",
  42: "ansi-bg-green",
  43: "ansi-bg-yellow",
  44: "ansi-bg-blue",
  45: "ansi-bg-magenta",
  46: "ansi-bg-cyan",
  47: "ansi-bg-white",
  100: "ansi-bg-bright-black",
  101: "ansi-bg-bright-red",
  102: "ansi-bg-bright-green",
  103: "ansi-bg-bright-yellow",
  104: "ansi-bg-bright-blue",
  105: "ansi-bg-bright-magenta",
  106: "ansi-bg-bright-cyan",
  107: "ansi-bg-bright-white",
};

const ANSI_STYLES: Record<number, string> = {
  1: "ansi-bold",
  2: "ansi-dim",
  3: "ansi-italic",
  4: "ansi-underline",
};

const ANSI_ESCAPE_REGEX = /\x1b\[([0-9;]*)m/g;

function isForegroundClass(cls: string): boolean {
  return (
    cls.startsWith("ansi-") &&
    !cls.startsWith("ansi-bg-") &&
    !cls.startsWith("ansi-bold") &&
    !cls.startsWith("ansi-dim") &&
    !cls.startsWith("ansi-italic") &&
    !cls.startsWith("ansi-underline")
  );
}

function isBackgroundClass(cls: string): boolean {
  return cls.startsWith("ansi-bg-");
}

export function ansiToHtml(text: string): string {
  let result = "";
  let lastIndex = 0;
  let currentClasses: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = ANSI_ESCAPE_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const textContent = escapeHtml(text.slice(lastIndex, match.index));
      if (currentClasses.length > 0) {
        result += `<span class="${currentClasses.join(" ")}">${textContent}</span>`;
      } else {
        result += textContent;
      }
    }

    const codes = match[1].split(";").map((c) => parseInt(c, 10) || 0);

    for (const code of codes) {
      if (code === 0) {
        currentClasses = [];
      } else if (ANSI_STYLES[code]) {
        const styleClass = ANSI_STYLES[code];
        if (!currentClasses.includes(styleClass)) {
          currentClasses.push(styleClass);
        }
      } else if (ANSI_FOREGROUND[code]) {
        currentClasses = currentClasses.filter((c) => !isForegroundClass(c));
        currentClasses.push(ANSI_FOREGROUND[code]);
      } else if (ANSI_BACKGROUND[code]) {
        currentClasses = currentClasses.filter((c) => !isBackgroundClass(c));
        currentClasses.push(ANSI_BACKGROUND[code]);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  ANSI_ESCAPE_REGEX.lastIndex = 0;

  if (lastIndex < text.length) {
    const textContent = escapeHtml(text.slice(lastIndex));
    if (currentClasses.length > 0) {
      result += `<span class="${currentClasses.join(" ")}">${textContent}</span>`;
    } else {
      result += textContent;
    }
  }

  return result;
}

export function hasAnsiCodes(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}

export function getToolsHtml(
  tools: Record<string, Tool>,
  expandedToolId?: string | null
): string {
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
      const isExpanded = id === expandedToolId;
      const kindIcon = getToolKindIcon(tool.kind);
      const kindSpan = kindIcon
        ? '<span class="tool-kind-icon" title="' +
          escapeHtml(tool.kind || "other") +
          '">' +
          kindIcon +
          "</span> "
        : "";
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
        const hasAnsi = hasAnsiCodes(truncated);
        const outputHtml = hasAnsi
          ? ansiToHtml(truncated)
          : escapeHtml(truncated);
        const terminalClass = hasAnsi ? " terminal" : "";
        detailsContent +=
          '<pre class="tool-output' +
          terminalClass +
          '">' +
          outputHtml +
          "</pre>";
      }
      const escapedStatus = escapeHtml(tool.status);
      const inputPreview = tool.input
        ? '<span class="tool-input-preview">' +
          escapeHtml(tool.input) +
          "</span>"
        : "";
      if (detailsContent) {
        const openAttr = isExpanded ? " open" : "";
        return (
          '<li><details class="tool-item"' +
          openAttr +
          '><summary><span class="tool-status ' +
          statusClass +
          '" aria-label="' +
          escapedStatus +
          '">' +
          statusIcon +
          "</span> " +
          kindSpan +
          escapeHtml(tool.name) +
          inputPreview +
          "</summary>" +
          detailsContent +
          "</details></li>"
        );
      }
      return (
        '<li><span class="tool-status ' +
        statusClass +
        '" aria-label="' +
        escapedStatus +
        '">' +
        statusIcon +
        "</span> " +
        kindSpan +
        escapeHtml(tool.name) +
        inputPreview +
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

export function updateSelectLabel(
  select: HTMLSelectElement,
  prefix: string
): void {
  Array.from(select.options).forEach((opt) => {
    opt.textContent = opt.dataset.label || opt.textContent;
  });
  const selected = select.options[select.selectedIndex];
  if (selected && selected.dataset.label) {
    selected.textContent = prefix + ": " + selected.dataset.label;
  }
}

export interface WebviewElements {
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  statusDot: HTMLElement;
  statusText: HTMLElement;
  agentSelector: HTMLSelectElement;
  connectBtn: HTMLButtonElement;
  welcomeConnectBtn: HTMLButtonElement;
  modeSelector: HTMLSelectElement;
  modelSelector: HTMLSelectElement;
  welcomeView: HTMLElement;
  commandAutocomplete: HTMLElement;
}

export function getElements(doc: Document): WebviewElements {
  return {
    messagesEl: doc.getElementById("messages")!,
    inputEl: doc.getElementById("input") as HTMLTextAreaElement,
    sendBtn: doc.getElementById("send") as HTMLButtonElement,
    statusDot: doc.getElementById("status-dot")!,
    statusText: doc.getElementById("status-text")!,
    agentSelector: doc.getElementById("agent-selector") as HTMLSelectElement,
    connectBtn: doc.getElementById("connect-btn") as HTMLButtonElement,
    welcomeConnectBtn: doc.getElementById(
      "welcome-connect-btn"
    ) as HTMLButtonElement,
    modeSelector: doc.getElementById("mode-selector") as HTMLSelectElement,
    modelSelector: doc.getElementById("model-selector") as HTMLSelectElement,
    welcomeView: doc.getElementById("welcome-view")!,
    commandAutocomplete: doc.getElementById("command-autocomplete")!,
  };
}

export class WebviewController {
  private vscode: VsCodeApi;
  private elements: WebviewElements;
  private doc: Document;
  private win: Window;

  private currentAssistantMessage: HTMLElement | null = null;
  private currentAssistantText = "";
  private thinkingEl: HTMLElement | null = null;
  private planEl: HTMLElement | null = null;
  private tools: Record<string, Tool> = {};
  private isConnected = false;
  private messageTexts = new Map<HTMLElement, string>();
  private availableCommands: AvailableCommand[] = [];
  private selectedCommandIndex = -1;
  private hasActiveTool = false;
  private expandedToolId: string | null = null;

  constructor(
    vscode: VsCodeApi,
    elements: WebviewElements,
    doc: Document,
    win: Window
  ) {
    this.vscode = vscode;
    this.elements = elements;
    this.doc = doc;
    this.win = win;

    this.restoreState();
    this.setupEventListeners();
    this.updateViewState();
    this.vscode.postMessage({ type: "ready" });
  }

  private restoreState(): void {
    const previousState = this.vscode.getState<WebviewState>();
    if (previousState) {
      this.isConnected = previousState.isConnected;
      this.elements.inputEl.value = previousState.inputValue || "";
    }
  }

  private saveState(): void {
    this.vscode.setState<WebviewState>({
      isConnected: this.isConnected,
      inputValue: this.elements.inputEl.value,
    });
  }

  private setupEventListeners(): void {
    const { sendBtn, inputEl, messagesEl, connectBtn, welcomeConnectBtn } =
      this.elements;
    const { agentSelector, modeSelector, modelSelector } = this.elements;

    const { commandAutocomplete } = this.elements;

    sendBtn.addEventListener("click", () => this.send());

    inputEl.addEventListener("keydown", (e) => {
      const isAutocompleteVisible =
        commandAutocomplete.classList.contains("visible");
      const commands = this.getFilteredCommands(inputEl.value.split(/\s/)[0]);

      if (isAutocompleteVisible && commands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.selectedCommandIndex = Math.min(
            this.selectedCommandIndex + 1,
            commands.length - 1
          );
          this.showCommandAutocomplete(commands);
          return;
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.selectedCommandIndex = Math.max(
            this.selectedCommandIndex - 1,
            0
          );
          this.showCommandAutocomplete(commands);
          return;
        } else if (
          e.key === "Tab" ||
          (e.key === "Enter" && this.selectedCommandIndex >= 0)
        ) {
          e.preventDefault();
          this.selectCommand(this.selectedCommandIndex);
          return;
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.hideCommandAutocomplete();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.clearInput();
      }
    });

    inputEl.addEventListener("input", () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
      this.updateAutocomplete();
      this.saveState();
    });

    commandAutocomplete.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        const index = parseInt(item.getAttribute("data-index") || "0", 10);
        this.selectCommand(index);
      }
    });

    commandAutocomplete.addEventListener("mouseover", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        this.selectedCommandIndex = parseInt(
          item.getAttribute("data-index") || "0",
          10
        );
        const commands = this.getFilteredCommands(inputEl.value.split(/\s/)[0]);
        this.showCommandAutocomplete(commands);
      }
    });

    messagesEl.addEventListener("keydown", (e) => {
      const messages = Array.from(messagesEl.querySelectorAll(".message"));
      const currentIndex = messages.indexOf(this.doc.activeElement as Element);

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
      this.vscode.postMessage({ type: "connect" });
    });

    welcomeConnectBtn.addEventListener("click", () => {
      this.vscode.postMessage({ type: "connect" });
    });

    agentSelector.addEventListener("change", () => {
      this.vscode.postMessage({
        type: "selectAgent",
        agentId: agentSelector.value,
      });
    });

    modeSelector.addEventListener("change", () => {
      updateSelectLabel(modeSelector, "Mode");
      this.vscode.postMessage({
        type: "selectMode",
        modeId: modeSelector.value,
      });
    });

    modelSelector.addEventListener("change", () => {
      updateSelectLabel(modelSelector, "Model");
      this.vscode.postMessage({
        type: "selectModel",
        modelId: modelSelector.value,
      });
    });

    this.win.addEventListener("message", (e: MessageEvent<ExtensionMessage>) =>
      this.handleMessage(e.data)
    );
  }

  addMessage(
    text: string,
    type: "user" | "assistant" | "error" | "system"
  ): HTMLElement {
    const div = this.doc.createElement("div");
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
        const msgText = this.messageTexts.get(div) || div.textContent || "";
        this.vscode.postMessage({ type: "copyMessage", text: msgText });
      });
    }

    div.textContent = text;
    this.messageTexts.set(div, text);
    this.elements.messagesEl.appendChild(div);
    this.elements.messagesEl.scrollTop = this.elements.messagesEl.scrollHeight;

    this.announceToScreenReader(label + ": " + text.substring(0, 100));
    return div;
  }

  private announceToScreenReader(message: string): void {
    const announcement = this.doc.createElement("div");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    announcement.className = "sr-only";
    announcement.textContent = message;
    this.doc.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  showThinking(): void {
    if (!this.thinkingEl) {
      this.thinkingEl = this.doc.createElement("div");
      this.thinkingEl.className = "message assistant";
      this.thinkingEl.setAttribute("role", "status");
      this.thinkingEl.setAttribute("aria-label", "Agent is thinking");
      this.elements.messagesEl.appendChild(this.thinkingEl);
    }
    let html = '<span class="thinking" aria-label="Processing">Thinking</span>';
    html += getToolsHtml(this.tools, this.expandedToolId);
    this.thinkingEl.innerHTML = html;
    this.elements.messagesEl.scrollTop = this.elements.messagesEl.scrollHeight;
  }

  hideThinking(): void {
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
  }

  updateStatus(state: string): void {
    this.elements.statusDot.className = "status-dot " + state;
    const labels: Record<string, string> = {
      disconnected: "Disconnected",
      connecting: "Connecting...",
      connected: "Connected",
      error: "Error",
    };
    this.elements.statusText.textContent = labels[state] || state;
    this.isConnected = state === "connected";
    this.updateViewState();
    this.saveState();
  }

  updateViewState(): void {
    const hasMessages = this.elements.messagesEl.children.length > 0;
    this.elements.welcomeView.style.display =
      !this.isConnected && !hasMessages ? "flex" : "none";
    this.elements.messagesEl.style.display =
      this.isConnected || hasMessages ? "flex" : "none";
  }

  private send(): void {
    const text = this.elements.inputEl.value.trim();
    if (!text) return;
    this.vscode.postMessage({ type: "sendMessage", text });
    this.elements.inputEl.value = "";
    this.elements.inputEl.style.height = "auto";
    this.elements.sendBtn.disabled = true;
    this.saveState();
  }

  private clearInput(): void {
    this.elements.inputEl.value = "";
    this.elements.inputEl.style.height = "auto";
    this.elements.inputEl.focus();
    this.hideCommandAutocomplete();
    this.saveState();
  }

  getFilteredCommands(query: string): AvailableCommand[] {
    if (!query.startsWith("/")) return [];
    const search = query.slice(1).toLowerCase();
    return this.availableCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().startsWith(search) ||
        cmd.description?.toLowerCase().includes(search)
    );
  }

  showCommandAutocomplete(commands: AvailableCommand[]): void {
    const { commandAutocomplete, inputEl } = this.elements;
    if (commands.length === 0) {
      this.hideCommandAutocomplete();
      return;
    }

    commandAutocomplete.innerHTML = commands
      .map((cmd, i) => {
        const hint = cmd.input?.hint
          ? '<div class="command-hint">' + escapeHtml(cmd.input.hint) + "</div>"
          : "";
        return (
          '<div class="command-item' +
          (i === this.selectedCommandIndex ? " selected" : "") +
          '" data-index="' +
          i +
          '" role="option" aria-selected="' +
          (i === this.selectedCommandIndex) +
          '">' +
          '<div class="command-name">' +
          escapeHtml(cmd.name) +
          "</div>" +
          '<div class="command-description">' +
          escapeHtml(cmd.description || "") +
          "</div>" +
          hint +
          "</div>"
        );
      })
      .join("");

    commandAutocomplete.classList.add("visible");
    inputEl.setAttribute("aria-expanded", "true");
  }

  hideCommandAutocomplete(): void {
    const { commandAutocomplete, inputEl } = this.elements;
    commandAutocomplete.classList.remove("visible");
    commandAutocomplete.innerHTML = "";
    this.selectedCommandIndex = -1;
    inputEl.setAttribute("aria-expanded", "false");
  }

  selectCommand(index: number): void {
    const firstWord = this.elements.inputEl.value.split(/\s/)[0];
    const commands = this.getFilteredCommands(firstWord);
    if (index >= 0 && index < commands.length) {
      const cmd = commands[index];
      this.elements.inputEl.value = "/" + cmd.name + " ";
      this.elements.inputEl.focus();
      this.hideCommandAutocomplete();
    }
  }

  showPlan(entries: PlanEntry[]): void {
    if (entries.length === 0) {
      this.hidePlan();
      return;
    }

    if (!this.planEl) {
      this.planEl = this.doc.createElement("div");
      this.planEl.className = "agent-plan";
      this.planEl.setAttribute("role", "status");
      this.planEl.setAttribute("aria-live", "polite");
      this.planEl.setAttribute("aria-label", "Agent execution plan");
      this.elements.messagesEl.appendChild(this.planEl);
    }

    const completedCount = entries.filter(
      (e) => e.status === "completed"
    ).length;
    const totalCount = entries.length;

    this.planEl.innerHTML = `
      <div class="plan-header">
        <span class="plan-icon">📋</span>
        <span class="plan-title">Agent Plan</span>
        <span class="plan-progress">${completedCount}/${totalCount}</span>
      </div>
      <div class="plan-entries">
        ${entries
          .map(
            (entry) => `
          <div class="plan-entry plan-entry-${entry.status} plan-priority-${entry.priority}">
            <span class="plan-status-icon">${this.getPlanStatusIcon(entry.status)}</span>
            <span class="plan-content">${escapeHtml(entry.content)}</span>
          </div>
        `
          )
          .join("")}
      </div>
    `;

    this.elements.messagesEl.scrollTop = this.elements.messagesEl.scrollHeight;
  }

  private getPlanStatusIcon(status: string): string {
    switch (status) {
      case "completed":
        return "✓";
      case "in_progress":
        return "⋯";
      case "pending":
      default:
        return "○";
    }
  }

  hidePlan(): void {
    if (this.planEl) {
      this.planEl.remove();
      this.planEl = null;
    }
  }

  private updateAutocomplete(): void {
    const text = this.elements.inputEl.value;
    const firstWord = text.split(/\s/)[0];

    if (firstWord.startsWith("/") && !text.includes(" ")) {
      const filtered = this.getFilteredCommands(firstWord);
      this.selectedCommandIndex = filtered.length > 0 ? 0 : -1;
      this.showCommandAutocomplete(filtered);
    } else {
      this.hideCommandAutocomplete();
    }
  }

  handleMessage(msg: ExtensionMessage): void {
    const { modeSelector, modelSelector, agentSelector, connectBtn } =
      this.elements;

    switch (msg.type) {
      case "userMessage":
        if (msg.text) {
          this.addMessage(msg.text, "user");
          this.showThinking();
          this.updateViewState();
        }
        break;
      case "streamStart":
        this.currentAssistantText = "";
        this.hasActiveTool = false;
        break;
      case "streamChunk":
        if (this.hasActiveTool && msg.text) {
          this.hideThinking();
          if (Object.keys(this.tools).length > 0) {
            const toolMessage = this.addMessage("", "assistant");
            toolMessage.innerHTML = getToolsHtml(
              this.tools,
              this.expandedToolId
            );
          }
          this.currentAssistantMessage = null;
          this.currentAssistantText = "";
          this.tools = {};
          this.expandedToolId = null;
          this.hasActiveTool = false;
        }

        if (!this.currentAssistantMessage) {
          this.hideThinking();
          this.currentAssistantMessage = this.addMessage("", "assistant");
        }
        if (msg.text) {
          this.currentAssistantText += msg.text;
          this.currentAssistantMessage.textContent = this.currentAssistantText;
          this.elements.messagesEl.scrollTop =
            this.elements.messagesEl.scrollHeight;
        }
        break;
      case "streamEnd":
        this.hideThinking();

        if (this.currentAssistantMessage) {
          let html = msg.html || "";
          if (this.currentAssistantText.trim()) {
            html = this.currentAssistantText + html;
          }
          html += getToolsHtml(this.tools, this.expandedToolId);
          this.currentAssistantMessage.innerHTML = html;
          this.messageTexts.set(
            this.currentAssistantMessage,
            this.currentAssistantText
          );
        }

        this.currentAssistantMessage = null;
        this.currentAssistantText = "";
        this.tools = {};
        this.hasActiveTool = false;
        this.expandedToolId = null;
        this.elements.sendBtn.disabled = false;
        this.elements.inputEl.focus();
        break;
      case "toolCallStart":
        if (msg.toolCallId && msg.name) {
          // Finalize current text message before showing tools
          if (this.currentAssistantText.trim()) {
            this.finalizeCurrentMessage();
            this.currentAssistantMessage = null;
            this.currentAssistantText = "";
          }

          this.tools[msg.toolCallId] = {
            name: msg.name,
            input: null,
            output: null,
            status: "running",
            kind: msg.kind,
          };
          this.hasActiveTool = true;
          this.showThinking();
        }
        break;
      case "toolCallComplete":
        if (msg.toolCallId && this.tools[msg.toolCallId]) {
          const tool = this.tools[msg.toolCallId];
          const output =
            msg.content?.[0]?.content?.text || msg.rawOutput?.output || "";
          const input =
            msg.rawInput?.command || msg.rawInput?.description || "";
          if (msg.title) tool.name = msg.title;
          if (msg.kind) tool.kind = msg.kind;
          tool.input = input;
          tool.output = output;
          tool.status = (msg.status as Tool["status"]) || "completed";
          this.expandedToolId = msg.toolCallId;
          this.showThinking();
        }
        break;
      case "error":
        this.hideThinking();
        if (msg.text) this.addMessage(msg.text, "error");
        this.elements.sendBtn.disabled = false;
        this.elements.inputEl.focus();
        break;
      case "agentError":
        if (msg.text) this.addMessage(msg.text, "error");
        break;
      case "connectionState":
        if (msg.state) {
          this.updateStatus(msg.state);
          connectBtn.style.display =
            msg.state === "connected" ? "none" : "inline-block";
        }
        break;
      case "agents":
        if (!msg.agents) break;
        agentSelector.innerHTML = "";
        msg.agents.forEach((a) => {
          const opt = this.doc.createElement("option");
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
        this.elements.messagesEl.innerHTML = "";
        this.currentAssistantMessage = null;
        this.messageTexts.clear();
        modeSelector.style.display = "none";
        modelSelector.style.display = "none";
        this.availableCommands = [];
        this.hideCommandAutocomplete();
        this.hidePlan();
        this.updateViewState();
        break;
      case "triggerNewChat":
        this.vscode.postMessage({ type: "newChat" });
        break;
      case "triggerClearChat":
        this.vscode.postMessage({ type: "clearChat" });
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

        if (hasModes && msg.modes) {
          modeSelector.style.display = "inline-block";
          modeSelector.innerHTML = "";
          msg.modes.availableModes.forEach((m) => {
            const opt = this.doc.createElement("option");
            opt.value = m.id;
            opt.textContent = m.name || m.id;
            opt.dataset.label = m.name || m.id;
            if (m.id === msg.modes?.currentModeId) opt.selected = true;
            modeSelector.appendChild(opt);
          });
          updateSelectLabel(modeSelector, "Mode");
        } else {
          modeSelector.style.display = "none";
        }

        if (hasModels && msg.models) {
          modelSelector.style.display = "inline-block";
          modelSelector.innerHTML = "";
          msg.models.availableModels.forEach((m) => {
            const opt = this.doc.createElement("option");
            opt.value = m.modelId;
            opt.textContent = m.name || m.modelId;
            opt.dataset.label = m.name || m.modelId;
            if (m.modelId === msg.models?.currentModelId) opt.selected = true;
            modelSelector.appendChild(opt);
          });
          updateSelectLabel(modelSelector, "Model");
        } else {
          modelSelector.style.display = "none";
        }

        if (msg.commands && Array.isArray(msg.commands)) {
          this.availableCommands = msg.commands;
        }
        break;
      }
      case "modeUpdate":
        if (msg.modeId) {
          modeSelector.value = msg.modeId;
          updateSelectLabel(modeSelector, "Mode");
        }
        break;
      case "availableCommands":
        if (msg.commands && Array.isArray(msg.commands)) {
          this.availableCommands = msg.commands;
        }
        break;
      case "plan":
        if (msg.plan && msg.plan.entries) {
          this.showPlan(msg.plan.entries);
        }
        break;
      case "planComplete":
        this.hidePlan();
        break;
    }
  }

  private finalizeCurrentMessage(): void {
    if (this.currentAssistantMessage && this.currentAssistantText.trim()) {
      const html =
        this.currentAssistantText +
        getToolsHtml(this.tools, this.expandedToolId);
      this.currentAssistantMessage.innerHTML = html;
      this.messageTexts.set(
        this.currentAssistantMessage,
        this.currentAssistantText
      );
    }
  }

  getTools(): Record<string, Tool> {
    return this.tools;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }
}

export function initWebview(
  vscode: VsCodeApi,
  doc: Document,
  win: Window
): WebviewController {
  const elements = getElements(doc);
  return new WebviewController(vscode, elements, doc, win);
}

if (typeof acquireVsCodeApi !== "undefined") {
  const vscode = acquireVsCodeApi();
  initWebview(vscode, document, window);
}
