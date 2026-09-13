import * as vscode from "vscode";
import { spawn } from "child_process";
import { ACPClient, describeACPError, formatACPError } from "../acp/client";
import {
  getAgent,
  getAgentsWithStatus,
  getFirstAvailableAgent,
} from "../acp/agents";
import type {
  SessionNotification,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

const SELECTED_AGENT_KEY = "vscode-acp.selectedAgent";
const SELECTED_MODE_KEY = "vscode-acp.selectedMode";
const SELECTED_MODEL_KEY = "vscode-acp.selectedModel";

const SESSION_HISTORY_KEY = "vscode-acp.sessionHistory";
const DEFAULT_SESSION_HISTORY_LIMIT = 50;

interface StoredSession {
  sessionId: string;
  agentId: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  preview: string;
  messageCount: number;
}

interface ReplayMessage {
  role: "user" | "assistant";
  messageId: string | null;
  text: string;
}

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
    | "copyMessage"
    | "permissionResponse"
    | "selectSession"
    | "deleteSession";
  text?: string;
  agentId?: string;
  modeId?: string;
  modelId?: string;
  requestId?: string;
  sessionId?: string;
  optionId?: string;
  cancelled?: boolean;
}

interface ManagedTerminal {
  id: string;
  terminal?: vscode.Terminal;
  proc: ReturnType<typeof spawn> | null;
  output: string;
  outputByteLimit: number | null;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exitPromise: Promise<void>;
  exitResolve: () => void;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vscode-acp.chatView";

  private view?: vscode.WebviewView;
  private hasSession = false;
  private globalState: vscode.Memento;
  private workspaceState: vscode.Memento;
  private streamingText = "";
  private hasRestoredModeModel = false;
  private isReplaying = false;
  private replayMessages: ReplayMessage[] = [];
  private connectionStart: Promise<void> | null = null;
  private sessionStart: Promise<void> | null = null;
  private conversationGeneration = 0;
  private terminals: Map<string, ManagedTerminal> = new Map();
  private terminalCounter = 0;
  private permissionRequests: Map<
    string,
    {
      resolve: (response: RequestPermissionResponse) => void;
      timeoutId: NodeJS.Timeout;
      optionIds: Set<string>;
    }
  > = new Map();
  private readonly permissionRequestTimeoutMs = 60000;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly acpClient: ACPClient,
    globalState: vscode.Memento,
    workspaceState: vscode.Memento = globalState
  ) {
    this.globalState = globalState;
    this.workspaceState = workspaceState;

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
      if (state === "disconnected" || state === "error") {
        this.hasSession = false;
        this.connectionStart = null;
        this.sessionStart = null;
        this.expirePermissionRequests();
      }
      this.postMessage({ type: "connectionState", state });
    });

    this.acpClient.setOnSessionUpdate((update) => {
      this.handleSessionUpdate(update);
    });
    this.acpClient.setOnStderr((text) => {
      this.handleStderr(text);
    });

    this.acpClient.setOnReadTextFile(async (params: ReadTextFileRequest) => {
      return this.handleReadTextFile(params);
    });

    this.acpClient.setOnWriteTextFile(async (params: WriteTextFileRequest) => {
      return this.handleWriteTextFile(params);
    });

    this.acpClient.setOnCreateTerminal(
      async (params: CreateTerminalRequest) => {
        return this.handleCreateTerminal(params);
      }
    );

    this.acpClient.setOnTerminalOutput(
      async (params: TerminalOutputRequest) => {
        return this.handleTerminalOutput(params);
      }
    );

    this.acpClient.setOnWaitForTerminalExit(
      async (params: WaitForTerminalExitRequest) => {
        return this.handleWaitForTerminalExit(params);
      }
    );

    this.acpClient.setOnKillTerminalCommand(
      async (params: KillTerminalRequest) => {
        return this.handleKillTerminalCommand(params);
      }
    );

    this.acpClient.setOnReleaseTerminal(
      async (params: ReleaseTerminalRequest) => {
        return this.handleReleaseTerminal(params);
      }
    );

    this.acpClient.setOnRequestPermission(
      async (params: RequestPermissionRequest) => {
        return this.handleRequestPermission(params);
      }
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    if (this.view && this.view !== webviewView) {
      this.expirePermissionRequests();
    }
    this.view = webviewView;

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.expirePermissionRequests();
      }
    });

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
        case "permissionResponse":
          this.handlePermissionResponse(message);
          break;
        case "selectSession":
          if (message.sessionId) {
            await this.handleSelectStoredSession(message.sessionId);
          }
          break;
        case "deleteSession":
          if (message.sessionId) {
            await this.handleDeleteStoredSession(message.sessionId);
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

  public async connect(): Promise<void> {
    await this.handleConnect();
  }

  public async loadSession(): Promise<void> {
    await this.showSessionHistory("load");
  }

  public async deleteSession(): Promise<void> {
    await this.showSessionHistory("delete");
  }

  private async showSessionHistory(mode: "load" | "delete"): Promise<void> {
    try {
      if (mode === "load") {
        await this.ensureConnection();
      }
      if (mode === "load" && !this.acpClient.supportsSessionLoad()) {
        vscode.window.showErrorMessage(
          "The selected agent does not support loading previous sessions."
        );
        return;
      }

      const sessions = this.getStoredSessions().filter(
        (session) => session.agentId === this.acpClient.getAgentId()
      );
      if (sessions.length === 0) {
        vscode.window.showInformationMessage(
          "No saved sessions are available for the selected agent."
        );
        return;
      }

      this.postMessage({ type: "sessionHistory", mode, sessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Failed to show session history: ${message}`
      );
    }
  }

  private async handleSelectStoredSession(sessionId: string): Promise<void> {
    const session = this.getStoredSessions().find(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.agentId === this.acpClient.getAgentId()
    );
    if (!session) {
      this.postMessage({
        type: "replayFailed",
        text: "Session is no longer available.",
      });
      return;
    }
    await this.loadStoredSession(session);
  }

  private async handleDeleteStoredSession(sessionId: string): Promise<void> {
    const session = this.getStoredSessions().find(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.agentId === this.acpClient.getAgentId()
    );
    if (!session) {
      return;
    }

    try {
      await this.workspaceState.update(
        SESSION_HISTORY_KEY,
        this.getStoredSessions().filter(
          (entry) =>
            entry.sessionId !== session.sessionId ||
            entry.agentId !== session.agentId
        )
      );
      this.postMessage({ type: "sessionDeleted", sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage({
        type: "replayFailed",
        text: `Failed to delete session: ${message}`,
      });
    }
  }

  private getStoredSessions(): StoredSession[] {
    const value = this.workspaceState.get<unknown>(SESSION_HISTORY_KEY);
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter(
      (session): session is StoredSession =>
        typeof session === "object" &&
        session !== null &&
        typeof session.sessionId === "string" &&
        typeof session.agentId === "string" &&
        typeof session.cwd === "string" &&
        typeof session.createdAt === "number" &&
        typeof session.lastUsedAt === "number" &&
        typeof session.preview === "string" &&
        typeof session.messageCount === "number"
    );
  }

  private async saveCurrentSession(preview?: string): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("vscode-acp");
    if (!configuration.get<boolean>("sessions.autoSave", true)) {
      return;
    }

    const sessionId = this.acpClient.getCurrentSessionId();
    if (!sessionId) {
      return;
    }

    const configuredLimit = configuration.get<number>(
      "sessions.maxHistory",
      DEFAULT_SESSION_HISTORY_LIMIT
    );
    const limit = Number.isFinite(configuredLimit)
      ? Math.max(1, Math.min(200, Math.floor(configuredLimit)))
      : DEFAULT_SESSION_HISTORY_LIMIT;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const cwd = workspaceFolder?.uri.fsPath || process.cwd();
    const history = this.getStoredSessions();
    const existing = history.find(
      (session) =>
        session.sessionId === sessionId &&
        session.agentId === this.acpClient.getAgentId()
    );
    const normalizedPreview = preview
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const now = Date.now();
    const entry: StoredSession = {
      sessionId,
      agentId: this.acpClient.getAgentId(),
      cwd,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      preview: normalizedPreview || existing?.preview || "",
      messageCount: (existing?.messageCount ?? 0) + (preview ? 1 : 0),
    };
    const updatedHistory = [
      entry,
      ...history.filter(
        (session) =>
          session.sessionId !== sessionId ||
          session.agentId !== this.acpClient.getAgentId()
      ),
    ]
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .slice(0, limit);

    await this.workspaceState.update(SESSION_HISTORY_KEY, updatedHistory);
  }

  private async loadStoredSession(session: StoredSession): Promise<void> {
    const hadSession = this.hasSession;
    const hadRestoredModeModel = this.hasRestoredModeModel;
    this.conversationGeneration++;
    this.isReplaying = true;
    this.replayMessages = [];
    this.postMessage({ type: "replayStart" });

    try {
      await this.acpClient.loadSession(session.sessionId, session.cwd);
      this.hasSession = true;
      this.hasRestoredModeModel = false;
      const history = this.getStoredSessions().map((entry) =>
        entry.sessionId === session.sessionId &&
        entry.agentId === session.agentId
          ? { ...entry, lastUsedAt: Date.now() }
          : entry
      );
      void Promise.resolve(
        this.workspaceState.update(
          SESSION_HISTORY_KEY,
          history.sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        )
      ).catch((error: unknown) =>
        console.warn("[Chat] Failed to update session metadata:", error)
      );
      this.isReplaying = false;
      this.postMessage({
        type: "replayComplete",
        messages: this.replayMessages.map((message) => ({
          role: message.role,
          text: message.text,
        })),
      });
      this.replayMessages = [];
      this.sendSessionMetadata();
    } catch (error) {
      this.isReplaying = false;
      this.replayMessages = [];
      this.hasSession = hadSession;
      this.hasRestoredModeModel = hadRestoredModeModel;
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage({ type: "replayFailed", text: message });
      this.sendSessionMetadata();
      throw error;
    }
  }

  private appendReplayChunk(
    role: ReplayMessage["role"],
    messageId: string | null | undefined,
    text: string
  ): void {
    const previous = this.replayMessages.at(-1);
    if (
      previous &&
      previous.role === role &&
      (messageId === null ||
        messageId === undefined ||
        previous.messageId === messageId)
    ) {
      previous.text += text;
      return;
    }

    this.replayMessages.push({ role, messageId: messageId ?? null, text });
  }

  private stderrBuffer = "";

  private handleStderr(text: string): void {
    this.stderrBuffer += text;

    const errorMatch = this.stderrBuffer.match(
      /(\w+Error):\s*(\w+)?\s*\n?\s*data:\s*\{([^}]+)\}/
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

  private async handleReadTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    console.log("[Chat] Reading file:", params.path);
    try {
      const uri = vscode.Uri.file(params.path);
      const openDoc = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.fsPath === uri.fsPath
      );

      let content: string;
      if (openDoc) {
        content = openDoc.getText();
      } else {
        const fileContent = await vscode.workspace.fs.readFile(uri);
        content = new TextDecoder().decode(fileContent);
      }

      if (params.line !== undefined || params.limit !== undefined) {
        const lines = content.split("\n");
        const startLine = Math.max((params.line ?? 1) - 1, 0);
        const lineLimit = params.limit ?? lines.length;
        const selectedLines = lines.slice(startLine, startLine + lineLimit);
        content = selectedLines.join("\n");
      }

      return { content };
    } catch (error) {
      console.error("[Chat] Failed to read file:", error);
      throw error;
    }
  }

  private async handleWriteTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    console.log("[Chat] Writing file:", params.path);
    try {
      const uri = vscode.Uri.file(params.path);
      const content = new TextEncoder().encode(params.content);
      await vscode.workspace.fs.writeFile(uri, content);
      return {};
    } catch (error) {
      console.error("[Chat] Failed to write file:", error);
      throw error;
    }
  }

  private async handleCreateTerminal(
    params: CreateTerminalRequest
  ): Promise<CreateTerminalResponse> {
    console.log("[Chat] Creating terminal for:", params.command);
    const terminalId = `term-${++this.terminalCounter}-${Date.now()}`;

    let exitResolve: () => void = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });

    const managedTerminal: ManagedTerminal = {
      id: terminalId,
      proc: null,
      output: "",
      outputByteLimit: params.outputByteLimit ?? null,
      truncated: false,
      exitCode: null,
      signal: null,
      exitPromise,
      exitResolve,
    };

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const cwd =
          params.cwd && params.cwd.trim() !== ""
            ? params.cwd
            : workspaceCwd ||
              process.env.HOME ||
              process.env.USERPROFILE ||
              process.cwd();

        const proc = spawn(params.command, params.args || [], {
          cwd,
          env: {
            ...process.env,
            ...(params.env?.reduce(
              (acc, e) => ({ ...acc, [e.name]: e.value }),
              {}
            ) || {}),
          },
          shell: true,
        });

        managedTerminal.proc = proc;

        proc.stdout?.on("data", (data: Buffer) => {
          const text = data.toString();
          writeEmitter.fire(text.replace(/\n/g, "\r\n"));
          this.appendTerminalOutput(managedTerminal, text);
        });

        proc.stderr?.on("data", (data: Buffer) => {
          const text = data.toString();
          writeEmitter.fire(text.replace(/\n/g, "\r\n"));
          this.appendTerminalOutput(managedTerminal, text);
        });

        proc.on("close", (code: number | null, signal: string | null) => {
          managedTerminal.exitCode = code;
          managedTerminal.signal = signal;
          managedTerminal.exitResolve();
          closeEmitter.fire(code ?? 0);
        });

        proc.on("error", (err: Error) => {
          writeEmitter.fire(`\r\nError: ${err.message}\r\n`);
          managedTerminal.exitCode = 1;
          managedTerminal.exitResolve();
          closeEmitter.fire(1);
        });
      },
      close: () => {
        if (managedTerminal.proc && !managedTerminal.proc.killed) {
          try {
            managedTerminal.proc.kill();
          } catch {}
        }
      },
    };

    const terminal = vscode.window.createTerminal({
      name: `ACP: ${params.command}`,
      pty,
    });

    managedTerminal.terminal = terminal;
    this.terminals.set(terminalId, managedTerminal);

    terminal.show(true);

    return { terminalId };
  }

  private appendTerminalOutput(terminal: ManagedTerminal, text: string): void {
    terminal.output += text;
    if (terminal.outputByteLimit !== null) {
      const byteLength = Buffer.byteLength(terminal.output, "utf8");
      if (byteLength > terminal.outputByteLimit) {
        const encoded = Buffer.from(terminal.output, "utf8");
        let start = encoded.length - terminal.outputByteLimit;
        while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
          start++;
        }
        terminal.output = encoded.subarray(start).toString("utf8");
        terminal.truncated = true;
      }
    }
  }

  private async handleTerminalOutput(
    params: TerminalOutputRequest
  ): Promise<TerminalOutputResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    const exitStatus =
      terminal.exitCode !== null
        ? {
            exitCode: terminal.exitCode,
            ...(terminal.signal !== null && { signal: terminal.signal }),
          }
        : null;

    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus,
    };
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    await terminal.exitPromise;

    return {
      exitCode: terminal.exitCode,
      ...(terminal.signal !== null && { signal: terminal.signal }),
    };
  }

  private killTerminalProcess(terminal: ManagedTerminal): void {
    if (terminal.proc && !terminal.proc.killed) {
      try {
        terminal.proc.kill();
      } catch {}
    }
  }

  private async handleKillTerminalCommand(
    params: KillTerminalRequest
  ): Promise<KillTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }

    this.killTerminalProcess(terminal);
    terminal.terminal?.dispose();
    return {};
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest
  ): Promise<ReleaseTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      return {};
    }

    this.killTerminalProcess(terminal);
    terminal.terminal?.dispose();
    this.terminals.delete(params.terminalId);
    return {};
  }

  private async handleRequestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    console.log("[Chat] Permission request:", params.toolCall?.toolCallId);

    if (!this.view) {
      console.log("[Chat] No webview available, cancelling permission request");
      return { outcome: { outcome: "cancelled" } };
    }

    const currentSessionId = this.acpClient.getCurrentSessionId();
    if (!currentSessionId || params.sessionId !== currentSessionId) {
      console.log(
        "[Chat] Permission request belongs to a stale session, cancelling",
        { requestSessionId: params.sessionId, currentSessionId }
      );
      return { outcome: { outcome: "cancelled" } };
    }

    if (!params.options || params.options.length === 0) {
      console.log("[Chat] No options provided, cancelling permission request");
      return { outcome: { outcome: "cancelled" } };
    }

    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const response = new Promise<RequestPermissionResponse>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (this.permissionRequests.delete(requestId)) {
          console.log("[Chat] Permission request timed out:", requestId);
          this.postMessage({ type: "permissionRequestExpired", requestId });
          resolve({ outcome: { outcome: "cancelled" } });
        }
      }, this.permissionRequestTimeoutMs);

      this.permissionRequests.set(requestId, {
        resolve,
        timeoutId,
        optionIds: new Set(params.options.map((opt) => opt.optionId)),
      });
    });

    const cancelUndeliveredRequest = (error?: unknown): void => {
      if (error) {
        console.error("[Chat] Failed to deliver permission request", error);
      }
      const pending = this.permissionRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.permissionRequests.delete(requestId);
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
    };

    // The view is kept alive while hidden, so a prompt posted to a collapsed
    // sidebar is delivered but never seen and would silently expire. Reveal it
    // without stealing focus from the editor.
    try {
      this.view.show?.(true);
    } catch (error) {
      console.error("[Chat] Failed to reveal the chat view", error);
    }

    try {
      const delivery = this.view.webview.postMessage({
        type: "permissionRequest",
        requestId,
        title: params.toolCall?.title || "Permission Required",
        rawInput: params.toolCall?.rawInput,
        options: params.options.map((opt) => ({
          id: opt.optionId,
          label: opt.name,
        })),
      });
      void Promise.resolve(delivery).then(
        (delivered) => {
          if (!delivered) {
            cancelUndeliveredRequest();
          }
        },
        (error) => cancelUndeliveredRequest(error)
      );
    } catch (error) {
      cancelUndeliveredRequest(error);
    }

    return response;
  }

  private handlePermissionResponse(message: WebviewMessage): void {
    if (!message.requestId) {
      return;
    }
    const pending = this.permissionRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.permissionRequests.delete(message.requestId);

    if (message.cancelled) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    } else if (message.optionId && pending.optionIds.has(message.optionId)) {
      pending.resolve({
        outcome: { outcome: "selected", optionId: message.optionId },
      });
    } else {
      console.error(
        "[Chat] Malformed permissionResponse; treating as cancelled",
        { requestId: message.requestId, optionId: message.optionId }
      );
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  private expirePermissionRequests(): void {
    for (const [requestId, pending] of this.permissionRequests.entries()) {
      clearTimeout(pending.timeoutId);
      this.postMessage({ type: "permissionRequestExpired", requestId });
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionRequests.clear();
  }

  public dispose(): void {
    for (const terminal of this.terminals.values()) {
      this.killTerminalProcess(terminal);
      try {
        terminal.terminal?.dispose();
      } catch {}
    }
    this.terminals.clear();

    this.expirePermissionRequests();
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    console.log("[Chat] Session update received:", update.sessionUpdate);

    if (this.isReplaying) {
      if (
        (update.sessionUpdate === "user_message_chunk" ||
          update.sessionUpdate === "agent_message_chunk") &&
        update.content.type === "text"
      ) {
        this.appendReplayChunk(
          update.sessionUpdate === "user_message_chunk" ? "user" : "assistant",
          update.messageId,
          update.content.text
        );
      }
      return;
    }

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
        kind: update.kind,
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      if (update.status === "completed" || update.status === "failed") {
        let terminalOutput: string | undefined;

        if (update.content && update.content.length > 0) {
          const terminalContent = update.content.find(
            (c: { type: string; terminalId?: string }) => c.type === "terminal"
          );
          if (terminalContent && "terminalId" in terminalContent) {
            terminalOutput = `[Terminal: ${terminalContent.terminalId}]`;
          }
        }

        this.postMessage({
          type: "toolCallComplete",
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          content: update.content,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          status: update.status,
          terminalOutput,
        });
      }
    } else if (update.sessionUpdate === "current_mode_update") {
      this.postMessage({ type: "modeUpdate", modeId: update.currentModeId });
    } else if (update.sessionUpdate === "config_option_update") {
      this.sendSessionMetadata();
    } else if (update.sessionUpdate === "available_commands_update") {
      this.postMessage({
        type: "availableCommands",
        commands: update.availableCommands,
      });
    } else if (update.sessionUpdate === "plan") {
      this.postMessage({
        type: "plan",
        plan: { entries: update.entries },
      });
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content?.type === "text") {
        this.postMessage({
          type: "thoughtChunk",
          text: update.content.text,
        });
      }
    }
  }
  private postACPError(context: string, error: unknown): void {
    console.error(`[Chat] ${context}:`, error);
    this.postMessage({ type: "error", text: formatACPError(error) });
  }

  private async ensureConnection(): Promise<void> {
    if (this.acpClient.isConnected()) {
      return;
    }
    if (!this.connectionStart) {
      this.connectionStart = this.acpClient
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connectionStart = null;
        });
    }
    await this.connectionStart;
  }

  private async ensureSession(): Promise<void> {
    await this.ensureConnection();

    if (this.hasSession) {
      return;
    }
    if (!this.sessionStart) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
      this.sessionStart = this.acpClient
        .newSession(workingDir)
        .then(() => {
          this.hasSession = true;
          this.sendSessionMetadata();
        })
        .finally(() => {
          this.sessionStart = null;
        });
    }
    await this.sessionStart;
  }

  private async handleUserMessage(text: string): Promise<void> {
    this.postMessage({ type: "userMessage", text });

    try {
      await this.ensureSession();
      const promptGeneration = this.conversationGeneration;
      const promptSessionId = this.acpClient.getCurrentSessionId();
      this.streamingText = "";
      this.stderrBuffer = "";
      this.postMessage({ type: "streamStart" });
      console.log("[Chat] Sending message to ACP...");
      const response = await this.acpClient.sendMessage(text);
      console.log(
        "[Chat] Prompt response received:",
        JSON.stringify(response, null, 2)
      );

      if (this.streamingText.length === 0) {
        console.warn("[Chat] No streaming text received from agent");
        console.warn("[Chat] stderr buffer:", this.stderrBuffer);
        console.warn("[Chat] Response:", JSON.stringify(response, null, 2));
        this.postMessage({
          type: "error",
          text: "Agent returned no response. Check the ACP output channel for details.",
        });
        this.postMessage({ type: "streamEnd", stopReason: "error" });
      } else {
        this.postMessage({
          type: "streamEnd",
          stopReason: response.stopReason,
        });
      }
      if (
        promptGeneration === this.conversationGeneration &&
        promptSessionId === this.acpClient.getCurrentSessionId()
      ) {
        void this.saveCurrentSession(text).catch((error) =>
          console.warn("[Chat] Failed to save session metadata:", error)
        );
      }
      this.streamingText = "";
    } catch (error) {
      const { kind } = describeACPError(error);
      if (kind === "cancelled") {
        console.log("[Chat] Prompt cancelled:", error);
      } else {
        this.postACPError("Error in handleUserMessage", error);
      }
      this.postMessage({
        type: "streamEnd",
        stopReason: kind === "cancelled" ? "cancelled" : "error",
      });

      this.streamingText = "";
      this.stderrBuffer = "";
    }
  }

  private handleAgentChange(agentId: string): void {
    const agent = getAgent(agentId);
    if (agent) {
      this.expirePermissionRequests();
      this.acpClient.setAgent(agent);
      this.conversationGeneration++;
      this.globalState.update(SELECTED_AGENT_KEY, agentId);
      this.hasSession = false;
      this.postMessage({ type: "agentChanged", agentId });
      this.postMessage({ type: "sessionMetadata", modes: null, models: null });
    }
  }

  private async handleModeChange(modeId: string): Promise<void> {
    try {
      await this.acpClient.setMode(modeId);
      await this.globalState.update(SELECTED_MODE_KEY, modeId);
      this.sendSessionMetadata();
    } catch (error) {
      this.postACPError("Failed to set mode", error);
      this.sendSessionMetadata();
    }
  }

  private async handleModelChange(modelId: string): Promise<void> {
    try {
      await this.acpClient.setModel(modelId);
      await this.globalState.update(SELECTED_MODEL_KEY, modelId);
      this.sendSessionMetadata();
    } catch (error) {
      this.postACPError("Failed to set model", error);
      this.sendSessionMetadata();
    }
  }

  private async handleConnect(): Promise<void> {
    try {
      await this.ensureSession();
    } catch (error) {
      this.postACPError("Failed to connect", error);
      throw error;
    }
  }

  private async handleNewChat(): Promise<void> {
    this.expirePermissionRequests();
    this.conversationGeneration++;
    const hadSession = this.hasSession;
    const hadRestoredModeModel = this.hasRestoredModeModel;
    this.streamingText = "";

    if (!this.acpClient.isConnected()) {
      this.hasSession = false;
      this.hasRestoredModeModel = false;
      this.postMessage({ type: "chatCleared" });
      this.postMessage({ type: "sessionMetadata", modes: null, models: null });
      return;
    }

    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
      await this.acpClient.newSession(workingDir);
      this.hasSession = true;
      this.hasRestoredModeModel = false;
      this.postMessage({ type: "chatCleared" });
      this.sendSessionMetadata();
    } catch (error) {
      this.hasSession = hadSession;
      this.hasRestoredModeModel = hadRestoredModeModel;
      this.postACPError("Failed to create new session", error);
      this.sendSessionMetadata();
    }
  }

  private handleClearChat(): void {
    this.expirePermissionRequests();
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

    if (!this.hasRestoredModeModel && this.hasSession) {
      this.hasRestoredModeModel = true;
      this.restoreSavedModeAndModel().catch((error) =>
        this.postACPError("Failed to restore saved mode/model", error)
      );
    }
  }

  private async restoreSavedModeAndModel(): Promise<void> {
    const metadata = this.acpClient.getSessionMetadata();
    const availableModes = Array.isArray(metadata?.modes?.availableModes)
      ? metadata.modes.availableModes
      : [];
    const availableModels = Array.isArray(metadata?.models?.availableModels)
      ? metadata.models.availableModels
      : [];

    const savedModeId = this.globalState.get<string>(SELECTED_MODE_KEY);
    const savedModelId = this.globalState.get<string>(SELECTED_MODEL_KEY);

    let modeRestored = false;
    let modelRestored = false;

    if (savedModeId && availableModes.some((mode) => mode.id === savedModeId)) {
      await this.acpClient.setMode(savedModeId);
      console.log(`[Chat] Restored mode: ${savedModeId}`);
      modeRestored = true;
    }

    if (
      savedModelId &&
      availableModels.some((model) => model.modelId === savedModelId)
    ) {
      await this.acpClient.setModel(savedModelId);
      console.log(`[Chat] Restored model: ${savedModelId}`);
      modelRestored = true;
    }

    if (modeRestored || modelRestored) {
      this.postMessage({ type: "sessionMetadata", ...metadata });
    }
  }

  private postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const styleResetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "reset.css")
    );
    const styleVSCodeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "vscode.css")
    );
    const styleMainUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css")
    );
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; form-action 'none'; frame-src 'none'; object-src 'none';">
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
  
  <div id="agent-plan-container"></div>
  
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
  <div id="session-picker" class="session-picker" role="dialog" aria-modal="true" aria-labelledby="session-picker-title" tabindex="-1"></div>

  <div id="permission-modal" class="permission-modal" role="dialog" aria-modal="true" aria-labelledby="permission-title" aria-describedby="permission-content" tabindex="-1">
    <div class="permission-modal-content">
      <h3 class="permission-title" id="permission-title">Permission Required</h3>
      <pre class="permission-content" id="permission-content"></pre>
      <div class="permission-options" role="group" aria-label="Permission options"></div>
      <button class="permission-cancel-btn" type="button">Cancel</button>
    </div>
  </div>
  
<script src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}
