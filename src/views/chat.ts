import * as vscode from "vscode";
import { marked } from "marked";
import { ACPClient } from "../acp/client";
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
    | "connect"
    | "newChat"
    | "clearChat"
    | "copyMessage";
  text?: string;
  agentId?: string;
  modeId?: string;
  modelId?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vscode-acp.chatView";

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

    this.acpClient.setOnStderr((text) => {
      this.handleStderr(text);
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
        case "newChat":
          await this.handleNewChat();
          break;
        case "clearChat":
          this.handleClearChat();
          break;
        case "copyMessage":
          if (message.text) {
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage("Message copied to clipboard");
          }
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

  public newChat(): void {
    this.postMessage({ type: "triggerNewChat" });
  }

  public clearChat(): void {
    this.postMessage({ type: "triggerClearChat" });
  }

  private stderrBuffer = "";

  private handleStderr(text: string): void {
    this.stderrBuffer += text;

    const errorMatch = this.stderrBuffer.match(
      /(\w+Error):\s*(\w+)?\s*\n?\s*data:\s*\{([^}]+)\}/,
    );
    if (errorMatch) {
      const errorType = errorMatch[1];
      const errorData = errorMatch[3];
      const providerMatch = errorData.match(/providerID:\s*"([^"]+)"/);
      const modelMatch = errorData.match(/modelID:\s*"([^"]+)"/);

      let message = `Agent error: ${errorType}`;
      if (providerMatch && modelMatch) {
        message = `Model not found: ${providerMatch[1]}/${modelMatch[1]}`;
      }

      this.postMessage({ type: "agentError", text: message });
      this.stderrBuffer = "";
    }

    if (this.stderrBuffer.length > 10000) {
      this.stderrBuffer = this.stderrBuffer.slice(-5000);
    }
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    console.log("[Chat] Session update received:", update.sessionUpdate);

    if (update.sessionUpdate === "agent_message_chunk") {
      console.log("[Chat] Chunk content:", JSON.stringify(update.content));
      if (update.content.type === "text") {
        this.streamingText += update.content.text;
        this.postMessage({ type: "streamChunk", text: update.content.text });
      } else {
        console.log("[Chat] Non-text chunk type:", update.content.type);
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
    } else if (update.sessionUpdate === "available_commands_update") {
      this.postMessage({
        type: "availableCommands",
        commands: update.availableCommands,
      });
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
      this.stderrBuffer = "";
      this.postMessage({ type: "streamStart" });
      console.log("[Chat] Sending message to ACP...");
      const response = await this.acpClient.sendMessage(text);
      console.log(
        "[Chat] Prompt response received:",
        JSON.stringify(response, null, 2),
      );

      if (this.streamingText.length === 0) {
        console.warn("[Chat] No streaming text received from agent");
        console.warn("[Chat] stderr buffer:", this.stderrBuffer);
        console.warn("[Chat] Response:", JSON.stringify(response, null, 2));
        this.postMessage({
          type: "error",
          text: "Agent returned no response. Check the ACP output channel for details.",
        });
        this.postMessage({ type: "streamEnd", stopReason: "error", html: "" });
      } else {
        const renderedHtml = marked.parse(this.streamingText) as string;
        this.postMessage({
          type: "streamEnd",
          stopReason: response.stopReason,
          html: renderedHtml,
        });
      }
      this.streamingText = "";
    } catch (error) {
      console.error("[Chat] Error in handleUserMessage:", error);
      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      this.postMessage({
        type: "error",
        text: `Error: ${errorMessage}`,
      });
      this.postMessage({ type: "streamEnd", stopReason: "error", html: "" });
      this.streamingText = "";
      this.stderrBuffer = "";
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

  private async handleNewChat(): Promise<void> {
    this.hasSession = false;
    this.streamingText = "";
    this.postMessage({ type: "chatCleared" });
    this.postMessage({ type: "sessionMetadata", modes: null, models: null });

    try {
      if (this.acpClient.isConnected()) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        await this.acpClient.newSession(workingDir);
        this.hasSession = true;
        this.sendSessionMetadata();
      }
    } catch (error) {
      console.error("[Chat] Failed to create new session:", error);
    }
  }

  private handleClearChat(): void {
    this.postMessage({ type: "chatCleared" });
  }

  private sendSessionMetadata(): void {
    const metadata = this.acpClient.getSessionMetadata();
    this.postMessage({
      type: "sessionMetadata",
      modes: metadata?.modes ?? null,
      models: metadata?.models ?? null,
      commands: metadata?.commands ?? null,
    });
  }

  private postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const styleResetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "reset.css"),
    );
    const styleVSCodeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "vscode.css"),
    );
    const styleMainUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css"),
    );
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${styleResetUri}" rel="stylesheet">
  <link href="${styleVSCodeUri}" rel="stylesheet">
  <link href="${styleMainUri}" rel="stylesheet">
  <title>VSCode ACP Chat</title>
</head>
<body>
  <div id="top-bar" role="toolbar" aria-label="Chat controls">
    <span class="status-indicator" role="status" aria-live="polite">
      <span class="status-dot" id="status-dot" aria-hidden="true"></span>
      <span id="status-text">Disconnected</span>
    </span>
    <button id="connect-btn" aria-label="Connect to agent">Connect</button>
    <select id="agent-selector" class="inline-select" aria-label="Select AI agent"></select>
  </div>
  
  <div id="welcome-view" class="welcome-view" role="main" aria-label="Welcome">
    <h3>Welcome to VSCode ACP</h3>
    <p>Chat with AI coding agents directly in VS Code.</p>
    <button class="welcome-btn" id="welcome-connect-btn">Connect to Agent</button>
    <p class="help-links">
      <a href="https://github.com/sst/opencode" target="_blank" rel="noopener">Install OpenCode</a>
      <span aria-hidden="true">·</span>
      <a href="https://claude.ai/code" target="_blank" rel="noopener">Install Claude Code</a>
    </p>
  </div>
  
  <div id="messages" role="log" aria-label="Chat messages" aria-live="polite" tabindex="0"></div>
  
  <div id="input-container">
    <div id="command-autocomplete" role="listbox" aria-label="Slash commands"></div>
    <textarea 
      id="input" 
      rows="1" 
      placeholder="Ask your agent... (type / for commands)" 
      aria-label="Message input"
      aria-describedby="input-hint"
      aria-autocomplete="list"
      aria-controls="command-autocomplete"
    ></textarea>
    <button id="send" aria-label="Send message" title="Send (Enter)">Send</button>
  </div>
  <span id="input-hint" class="sr-only">Press Enter to send, Shift+Enter for new line, Escape to clear. Type / for slash commands.</span>
  
  <div id="options-bar" role="toolbar" aria-label="Session options">
    <select id="mode-selector" class="inline-select" style="display: none;" aria-label="Select mode"></select>
    <select id="model-selector" class="inline-select" style="display: none;" aria-label="Select model"></select>
  </div>
  
<script src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}
