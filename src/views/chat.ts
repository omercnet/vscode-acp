import * as vscode from "vscode";
import { marked } from "marked";
import { ACPClient, type SessionMetadata } from "../acp/client";
import {
  getAgent,
  getAgentsWithStatus,
  getFirstAvailableAgent,
} from "../acp/agents";
import type { SessionNotification } from "@agentclientprotocol/sdk";

marked.setOptions({
  breaks: true,
  gfm: true,
});

const SELECTED_AGENT_KEY = "vscode-acp.selectedAgent";

interface WebviewMessage {
  type:
    | "sendMessage"
    | "ready"
    | "selectAgent"
    | "selectMode"
    | "selectModel"
    | "connect";
  text?: string;
  agentId?: string;
  modeId?: string;
  modelId?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private hasSession = false;
  private globalState: vscode.Memento;
  private streamingText = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly acpClient: ACPClient,
    globalState: vscode.Memento,
  ) {
    this.globalState = globalState;

    const savedAgentId = this.globalState.get<string>(SELECTED_AGENT_KEY);
    if (savedAgentId) {
      const agent = getAgent(savedAgentId);
      if (agent) {
        this.acpClient.setAgent(agent);
      }
    } else {
      this.acpClient.setAgent(getFirstAvailableAgent());
    }

    this.acpClient.setOnStateChange((state) => {
      this.postMessage({ type: "connectionState", state });
    });

    this.acpClient.setOnSessionUpdate((update) => {
      this.handleSessionUpdate(update);
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case "sendMessage":
          if (message.text) {
            await this.handleUserMessage(message.text);
          }
          break;
        case "selectAgent":
          if (message.agentId) {
            this.handleAgentChange(message.agentId);
          }
          break;
        case "selectMode":
          if (message.modeId) {
            await this.handleModeChange(message.modeId);
          }
          break;
        case "selectModel":
          if (message.modelId) {
            await this.handleModelChange(message.modelId);
          }
          break;
        case "connect":
          await this.handleConnect();
          break;
        case "ready":
          this.postMessage({
            type: "connectionState",
            state: this.acpClient.getState(),
          });
          const agentsWithStatus = getAgentsWithStatus();
          this.postMessage({
            type: "agents",
            agents: agentsWithStatus.map((a) => ({
              id: a.id,
              name: a.name,
              available: a.available,
            })),
            selected: this.acpClient.getAgentId(),
          });
          this.sendSessionMetadata();
          break;
      }
    });
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    console.log(
      "[Chat] Handling update type:",
      update.sessionUpdate,
      JSON.stringify(update, null, 2),
    );

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        this.streamingText += update.content.text;
        this.postMessage({ type: "streamChunk", text: update.content.text });
      }
    } else if (update.sessionUpdate === "tool_call") {
      this.postMessage({
        type: "toolCallStart",
        name: update.title,
        toolCallId: update.toolCallId,
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      if (update.status === "completed" || update.status === "failed") {
        this.postMessage({
          type: "toolCallComplete",
          toolCallId: update.toolCallId,
          title: update.title,
          content: update.content,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          status: update.status,
        });
      }
    } else if (update.sessionUpdate === "current_mode_update") {
      this.postMessage({ type: "modeUpdate", modeId: update.currentModeId });
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    this.postMessage({ type: "userMessage", text });

    try {
      if (!this.acpClient.isConnected()) {
        await this.acpClient.connect();
      }

      if (!this.hasSession) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        await this.acpClient.newSession(workingDir);
        this.hasSession = true;
        this.sendSessionMetadata();
      }

      this.streamingText = "";
      this.postMessage({ type: "streamStart" });
      console.log("[Chat] Sending message to ACP...");
      const response = await this.acpClient.sendMessage(text);
      console.log(
        "[Chat] Prompt response received:",
        JSON.stringify(response, null, 2),
      );
      const renderedHtml = marked.parse(this.streamingText) as string;
      this.postMessage({
        type: "streamEnd",
        stopReason: response.stopReason,
        html: renderedHtml,
      });
      this.streamingText = "";
    } catch (error) {
      this.postMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private handleAgentChange(agentId: string): void {
    const agent = getAgent(agentId);
    if (agent) {
      this.acpClient.setAgent(agent);
      this.globalState.update(SELECTED_AGENT_KEY, agentId);
      this.hasSession = false;
      this.postMessage({ type: "agentChanged", agentId });
      this.postMessage({ type: "sessionMetadata", modes: null, models: null });
    }
  }

  private async handleModeChange(modeId: string): Promise<void> {
    try {
      await this.acpClient.setMode(modeId);
      this.sendSessionMetadata();
    } catch (error) {
      console.error("[Chat] Failed to set mode:", error);
    }
  }

  private async handleModelChange(modelId: string): Promise<void> {
    try {
      await this.acpClient.setModel(modelId);
      this.sendSessionMetadata();
    } catch (error) {
      console.error("[Chat] Failed to set model:", error);
    }
  }

  private async handleConnect(): Promise<void> {
    try {
      if (!this.acpClient.isConnected()) {
        await this.acpClient.connect();
      }
      if (!this.hasSession) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        await this.acpClient.newSession(workingDir);
        this.hasSession = true;
        this.sendSessionMetadata();
      }
    } catch (error) {
      this.postMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to connect",
      });
    }
  }

  private sendSessionMetadata(): void {
    const metadata = this.acpClient.getSessionMetadata();
    this.postMessage({
      type: "sessionMetadata",
      modes: metadata?.modes ?? null,
      models: metadata?.models ?? null,
    });
  }

  private postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>OpenCode Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    #top-bar {
      padding: 6px 10px;
      font-size: 11px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .status-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-errorForeground);
    }
    .status-dot.connected { background: var(--vscode-testing-iconPassed); }
    .status-dot.connecting { background: var(--vscode-editorWarning-foreground); }
    .inline-select {
      padding: 2px 6px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 3px;
      font-size: 11px;
      cursor: pointer;
      max-width: 140px;
      text-overflow: ellipsis;
    }
    .inline-select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .inline-select:disabled { opacity: 0.5; cursor: default; }
    #connect-btn {
      padding: 2px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }
    #connect-btn:hover { background: var(--vscode-button-hoverBackground); }
    .spacer { flex: 1; }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .message {
      padding: 10px 14px;
      border-radius: 8px;
      max-width: 90%;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .message.user {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      align-self: flex-end;
    }
    .message.assistant {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      align-self: flex-start;
    }
    .message.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-errorForeground);
      align-self: center;
    }
    .message.tool {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textLink-foreground);
      font-size: 0.9em;
      align-self: flex-start;
    }
    .message.assistant code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 0.9em;
    }
    .message.assistant pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .message.assistant pre code {
      background: none;
      padding: 0;
      font-size: 0.85em;
      line-height: 1.4;
    }
    .message.assistant h1, .message.assistant h2, .message.assistant h3 {
      margin: 12px 0 6px 0;
      font-weight: 600;
    }
    .message.assistant h1 { font-size: 1.3em; }
    .message.assistant h2 { font-size: 1.15em; }
    .message.assistant h3 { font-size: 1.05em; }
    .message.assistant p { margin: 6px 0; }
    .message.assistant ul, .message.assistant ol {
      margin: 6px 0;
      padding-left: 20px;
    }
    .message.assistant li { margin: 3px 0; }
    .message.assistant blockquote {
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      margin: 8px 0;
      padding-left: 10px;
      color: var(--vscode-textBlockQuote-foreground);
    }
    .message.assistant a {
      color: var(--vscode-textLink-foreground);
    }
    .message.assistant hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 12px 0;
    }
    #input-container {
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
    }
    #input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
    }
    #input:focus { outline: 1px solid var(--vscode-focusBorder); }
    #send {
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    #send:hover { background: var(--vscode-button-hoverBackground); }
    #send:disabled { opacity: 0.5; cursor: not-allowed; }
    #options-bar {
      padding: 6px 10px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .thinking { display: inline-block; }
    .thinking::after {
      content: '';
      animation: dots 1.5s steps(4, end) infinite;
    }
    @keyframes dots {
      0%, 20% { content: ''; }
      40% { content: '.'; }
      60% { content: '..'; }
      80%, 100% { content: '...'; }
    }
    .tool-details {
      margin-top: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .tool-details summary {
      cursor: pointer;
      user-select: none;
      list-style: none;
    }
    .tool-details summary::-webkit-details-marker { display: none; }
    .tool-details summary::before {
      content: '▶';
      display: inline-block;
      margin-right: 4px;
      font-size: 9px;
      transition: transform 0.15s;
    }
    .tool-details[open] summary::before { transform: rotate(90deg); }
    .tool-list {
      margin: 4px 0 0 14px;
      padding: 0;
      list-style: none;
    }
    .tool-list li {
      padding: 2px 0;
      font-family: var(--vscode-editor-font-family), monospace;
    }
    .tool-status {
      display: inline-block;
      width: 14px;
      text-align: center;
      margin-right: 4px;
    }
    .tool-item {
      margin: 2px 0;
    }
    .tool-item summary {
      cursor: pointer;
      list-style: none;
    }
    .tool-item summary::-webkit-details-marker { display: none; }
    .tool-input {
      font-family: var(--vscode-editor-font-family), monospace;
      color: var(--vscode-terminal-ansiGreen);
      margin-bottom: 4px;
      font-size: 11px;
    }
    .tool-output {
      margin: 4px 0 0 18px;
      padding: 6px 8px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 3px;
      font-size: 10px;
      line-height: 1.3;
      overflow-x: auto;
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div id="top-bar">
    <span class="status-indicator">
      <span class="status-dot" id="status-dot"></span>
      <span id="status-text">Disconnected</span>
    </span>
    <button id="connect-btn">Connect</button>
    <select id="agent-selector" class="inline-select"></select>
  </div>
  <div id="messages"></div>
  <div id="input-container">
    <textarea id="input" rows="1" placeholder="Ask OpenCode..."></textarea>
    <button id="send">Send</button>
  </div>
  <div id="options-bar">
    <select id="mode-selector" class="inline-select" style="display: none;"></select>
    <select id="model-selector" class="inline-select" style="display: none;"></select>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const agentSelector = document.getElementById('agent-selector');
    const connectBtn = document.getElementById('connect-btn');
    const modeSelector = document.getElementById('mode-selector');
    const modelSelector = document.getElementById('model-selector');

    let currentAssistantMessage = null;
    let currentAssistantText = '';
    let thinkingEl = null;
    let tools = {};

    function updateSelectLabel(select, prefix) {
      Array.from(select.options).forEach(opt => {
        opt.textContent = opt.dataset.label || opt.textContent;
      });
      const selected = select.options[select.selectedIndex];
      if (selected && selected.dataset.label) {
        selected.textContent = prefix + ': ' + selected.dataset.label;
      }
    }

    function addMessage(text, type) {
      const div = document.createElement('div');
      div.className = 'message ' + type;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function getToolsHtml() {
      const toolIds = Object.keys(tools);
      if (toolIds.length === 0) return '';
      const toolItems = toolIds.map(id => {
        const tool = tools[id];
        const statusIcon = tool.status === 'completed' ? '✓' : tool.status === 'failed' ? '✗' : '⋯';
        let detailsContent = '';
        if (tool.input) {
          detailsContent += '<div class="tool-input"><strong>$</strong> ' + escapeHtml(tool.input) + '</div>';
        }
        if (tool.output) {
          const truncated = tool.output.length > 500 ? tool.output.slice(0, 500) + '...' : tool.output;
          detailsContent += '<pre class="tool-output">' + escapeHtml(truncated) + '</pre>';
        }
        if (detailsContent) {
          return '<li><details class="tool-item"><summary><span class="tool-status">' + statusIcon + '</span> ' + escapeHtml(tool.name) + '</summary>' + detailsContent + '</details></li>';
        }
        return '<li><span class="tool-status">' + statusIcon + '</span> ' + escapeHtml(tool.name) + '</li>';
      }).join('');
      return '<details class="tool-details" open><summary>' + toolIds.length + ' tool' + (toolIds.length > 1 ? 's' : '') + '</summary><ul class="tool-list">' + toolItems + '</ul></details>';
    }

    function showThinking() {
      if (!thinkingEl) {
        thinkingEl = document.createElement('div');
        thinkingEl.className = 'message assistant';
        messagesEl.appendChild(thinkingEl);
      }
      let html = '<span class="thinking">Thinking</span>';
      html += getToolsHtml();
      thinkingEl.innerHTML = html;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function hideThinking() {
      if (thinkingEl) {
        thinkingEl.remove();
        thinkingEl = null;
      }
    }

    function updateStatus(state) {
      statusDot.className = 'status-dot ' + state;
      const labels = {
        disconnected: 'Disconnected',
        connecting: 'Connecting...',
        connected: 'Connected',
        error: 'Error'
      };
      statusText.textContent = labels[state] || state;
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'sendMessage', text });
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendBtn.disabled = true;
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'userMessage':
          addMessage(msg.text, 'user');
          showThinking();
          break;
        case 'streamStart':
          currentAssistantText = '';
          break;
        case 'streamChunk':
          if (!currentAssistantMessage) {
            hideThinking();
            currentAssistantMessage = addMessage('', 'assistant');
          }
          currentAssistantText += msg.text;
          currentAssistantMessage.textContent = currentAssistantText;
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case 'streamEnd':
          hideThinking();
          if (currentAssistantMessage) {
            let html = msg.html || '';
            html += getToolsHtml();
            currentAssistantMessage.innerHTML = html;
          }
          currentAssistantMessage = null;
          currentAssistantText = '';
          tools = {};
          sendBtn.disabled = false;
          break;
        case 'toolCallStart':
          tools[msg.toolCallId] = { name: msg.name, input: null, output: null, status: 'running' };
          showThinking();
          break;
        case 'toolCallComplete':
          if (tools[msg.toolCallId]) {
            const output = msg.content?.[0]?.content?.text || msg.rawOutput?.output || '';
            const input = msg.rawInput?.command || msg.rawInput?.description || '';
            if (msg.title) tools[msg.toolCallId].name = msg.title;
            tools[msg.toolCallId].input = input;
            tools[msg.toolCallId].output = output;
            tools[msg.toolCallId].status = msg.status;
            showThinking();
          }
          break;
        case 'error':
          hideThinking();
          addMessage(msg.text, 'error');
          sendBtn.disabled = false;
          break;
        case 'connectionState':
          updateStatus(msg.state);
          connectBtn.style.display = msg.state === 'connected' ? 'none' : 'inline-block';
          break;
        case 'agents':
          agentSelector.innerHTML = '';
          msg.agents.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.available ? a.name : a.name + ' (not installed)';
            if (!a.available) {
              opt.style.color = 'var(--vscode-disabledForeground)';
            }
            if (a.id === msg.selected) opt.selected = true;
            agentSelector.appendChild(opt);
          });
          break;
        case 'agentChanged':
          messagesEl.innerHTML = '';
          currentAssistantMessage = null;
          modeSelector.style.display = 'none';
          modelSelector.style.display = 'none';
          break;
        case 'sessionMetadata':
          const hasModes = msg.modes && msg.modes.availableModes && msg.modes.availableModes.length > 0;
          const hasModels = msg.models && msg.models.availableModels && msg.models.availableModels.length > 0;
          
          if (hasModes) {
            modeSelector.style.display = 'inline-block';
            modeSelector.innerHTML = '';
            msg.modes.availableModes.forEach(m => {
              const opt = document.createElement('option');
              opt.value = m.id;
              opt.textContent = m.name || m.id;
              opt.dataset.label = m.name || m.id;
              if (m.id === msg.modes.currentModeId) opt.selected = true;
              modeSelector.appendChild(opt);
            });
            updateSelectLabel(modeSelector, 'Mode');
          } else {
            modeSelector.style.display = 'none';
          }
          
          if (hasModels) {
            modelSelector.style.display = 'inline-block';
            modelSelector.innerHTML = '';
            msg.models.availableModels.forEach(m => {
              const opt = document.createElement('option');
              opt.value = m.modelId;
              opt.textContent = m.name || m.modelId;
              opt.dataset.label = m.name || m.modelId;
              if (m.modelId === msg.models.currentModelId) opt.selected = true;
              modelSelector.appendChild(opt);
            });
            updateSelectLabel(modelSelector, 'Model');
          } else {
            modelSelector.style.display = 'none';
          }
          break;
        case 'modeUpdate':
          if (msg.modeId) {
            modeSelector.value = msg.modeId;
            updateSelectLabel(modeSelector, 'Mode');
          }
          break;
      }
    });

    agentSelector.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectAgent', agentId: agentSelector.value });
    });

    connectBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'connect' });
    });

    modeSelector.addEventListener('change', () => {
      updateSelectLabel(modeSelector, 'Mode');
      vscode.postMessage({ type: 'selectMode', modeId: modeSelector.value });
    });

    modelSelector.addEventListener('change', () => {
      updateSelectLabel(modelSelector, 'Model');
      vscode.postMessage({ type: 'selectModel', modelId: modelSelector.value });
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 32; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
