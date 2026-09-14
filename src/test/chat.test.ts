import * as assert from "assert";
import { EventEmitter } from "events";
import * as vscode from "vscode";
import fsPromises, {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import type { FileHandle } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import {
  buildWindowsBatchCommandLine,
  ChatViewProvider,
  DIRTY_EDITOR_WRITE_CONFLICT,
} from "../views/chat";
import { McpSecretRedactor } from "../acp/mcp";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ACPClient } from "../acp/client";
import {
  openTrustedWorkspaceFile,
  workspaceFileCapabilities,
  type WorkspaceFileAccessContext,
} from "../acp/workspace-files";
import type {
  AuthMethod,
  AuthMethodId,
  LoadSessionRequest,
  McpCapabilities,
  NewSessionRequest,
  PromptCapabilities,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import * as attachmentHelpers from "../attachments";
import type { FileAttachment } from "../shared/attachments";

interface MockMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

interface MockACPClient {
  setAgent: (config: any) => void;
  getAgentId: () => string;
  getCurrentSessionId: () => string | null;
  getAgentInfo: () => {
    name: string;
    title?: string | null;
    version: string;
  } | null;
  getAuthenticationMethods: () => readonly AuthMethod[];
  getConnectionGeneration: () => number;
  authenticate: (
    methodId: AuthMethodId,
    selectedGeneration: number
  ) => Promise<void>;
  setOnStateChange: (callback: any) => () => void;
  setOnSessionUpdate: (callback: any) => () => void;
  setOnStderr: (callback: any) => () => void;
  setOnReadTextFile: (callback: any) => void;
  setOnWriteTextFile: (callback: any) => void;
  setFileSystemCapabilities: (
    callback: () => Promise<{
      readTextFile: boolean;
      writeTextFile: boolean;
    }>
  ) => void;
  setOnCreateTerminal: (callback: any) => void;
  setOnTerminalOutput: (callback: any) => void;
  setOnWaitForTerminalExit: (callback: any) => void;
  setOnKillTerminalCommand: (callback: any) => void;
  setOnReleaseTerminal: (callback: any) => void;
  setOnRequestPermission: (callback: any) => void;
  isConnected: () => boolean;
  connect: () => Promise<void>;
  newSession: (params: NewSessionRequest) => Promise<void>;
  sendMessage: (text: string) => Promise<{ stopReason: string }>;
  loadSession: (params: LoadSessionRequest) => Promise<void>;
  supportsSessionLoad: () => boolean;
  getMcpCapabilities: () => McpCapabilities;
  getPromptCapabilities: () => PromptCapabilities;
  setMode: (modeId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  getSessionMetadata: () => any;
  dispose: () => void;
}

interface TestManagedTerminal {
  id: string;
  sessionId: string;
  generation: number;
  proc: null;
  closing: boolean;
  output: string;
  outputByteLimit: number;
  truncated: boolean;
  exitCode: null;
  signal: null;
  exitPromise: Promise<void>;
  exitResolve: () => undefined;
}

interface TestableCapabilityHandlers {
  handleReadTextFile(params: {
    sessionId: string;
    path: string;
    line?: number;
    limit?: number;
  }): Promise<{ content: string }>;
  handleWriteTextFile(params: {
    sessionId: string;
    path: string;
    content: string;
  }): Promise<Record<string, never>>;
  appendTerminalOutput(terminal: TestManagedTerminal, text: string): void;
  handleTerminalOutput(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<{ output: string; truncated: boolean; exitStatus: null }>;
  terminals: Map<string, TestManagedTerminal>;
}

interface AuthenticationTestProvider {
  selectAuthenticationMethod(): Promise<AuthMethodId | null>;
  ensureSession(): Promise<void>;
  hasSession: boolean;
  handleUserMessage(text: string): Promise<void>;
}

class TestMemento implements MockMemento {
  private state = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.state.set(key, value);
  }

  keys(): readonly string[] {
    return Array.from(this.state.keys());
  }

  clear(): void {
    this.state.clear();
  }
}

class TestACPClient implements MockACPClient {
  private agentIdValue = "test-agent";
  private setModeCallCount = 0;
  public agentInfo: {
    name: string;
    title?: string | null;
    version: string;
  } | null = null;
  private setModelCallCount = 0;
  private stateChangeCallback:
    | ((state: "disconnected" | "connecting" | "connected" | "error") => void)
    | null = null;
  private sessionUpdateCallback:
    ((update: SessionNotification) => void) | null = null;
  private stderrCallback: ((text: string) => void) | null = null;
  public lastSetModeId: string | null = null;
  public lastSetModelId: string | null = null;
  public currentSessionId: string | null = "test-session";

  setAgent(): void {}
  getAgentId(): string {
    return this.agentIdValue;
  }
  getAgentInfo() {
    return this.agentInfo ? { ...this.agentInfo } : null;
  }
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  public connectionGeneration = 1;

  getAuthenticationMethods(): readonly AuthMethod[] {
    return [];
  }

  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  async authenticate(
    _methodId: AuthMethodId,
    _selectedGeneration: number
  ): Promise<void> {
    throw new Error("Authentication method is not available");
  }
  setOnStateChange(
    callback: (
      state: "disconnected" | "connecting" | "connected" | "error"
    ) => void
  ): () => void {
    this.stateChangeCallback = callback;
    return () => {
      if (this.stateChangeCallback === callback) {
        this.stateChangeCallback = null;
      }
    };
  }
  setOnSessionUpdate(
    callback: (update: SessionNotification) => void
  ): () => void {
    this.sessionUpdateCallback = callback;
    return () => {
      if (this.sessionUpdateCallback === callback) {
        this.sessionUpdateCallback = null;
      }
    };
  }
  setOnStderr(callback: (text: string) => void): () => void {
    this.stderrCallback = callback;
    return () => {
      if (this.stderrCallback === callback) {
        this.stderrCallback = null;
      }
    };
  }
  setOnReadTextFile(): void {}
  setOnWriteTextFile(): void {}
  setFileSystemCapabilities(): void {}
  setOnCreateTerminal(): void {}
  setOnTerminalOutput(): void {}
  setOnWaitForTerminalExit(): void {}
  setOnKillTerminalCommand(): void {}
  setOnReleaseTerminal(): void {}
  setOnRequestPermission(): void {}
  isConnected(): boolean {
    return false;
  }
  async connect(): Promise<void> {}
  async newSession(_params: NewSessionRequest): Promise<void> {}
  async sendMessage(): Promise<{ stopReason: string }> {
    return { stopReason: "end_turn" };
  }

  async loadSession(_params: LoadSessionRequest): Promise<void> {
    throw new Error("Session loading is unavailable");
  }

  supportsSessionLoad(): boolean {
    return false;
  }
  getMcpCapabilities(): McpCapabilities {
    return {};
  }
  getPromptCapabilities(): PromptCapabilities {
    return {};
  }

  async setMode(modeId: string): Promise<void> {
    this.setModeCallCount++;
    this.lastSetModeId = modeId;
  }

  async setModel(modelId: string): Promise<void> {
    this.setModelCallCount++;
    this.lastSetModelId = modelId;
  }

  getSessionMetadata(): any {
    return {
      modes: null,
      models: null,
      commands: null,
    };
  }

  dispose(): void {}

  getSetModeCallCount(): number {
    return this.setModeCallCount;
  }

  getSetModelCallCount(): number {
    return this.setModelCallCount;
  }

  resetCallCounts(): void {
    this.setModeCallCount = 0;
    this.setModelCallCount = 0;
    this.lastSetModeId = null;
    this.lastSetModelId = null;
  }

  emitStateChange(
    state: "disconnected" | "connecting" | "connected" | "error"
  ): void {
    this.stateChangeCallback?.(state);
  }

  emitSessionUpdate(update: SessionNotification): void {
    this.sessionUpdateCallback?.(update);
  }

  emitStderr(text: string): void {
    this.stderrCallback?.(text);
  }
}

interface FakeWebview {
  view: {
    webview: {
      postMessage: (message: Record<string, unknown>) => Promise<boolean>;
    };
    show: (preserveFocus?: boolean) => void;
  };
  messages: Record<string, unknown>[];
  messageEvents: EventEmitter;
  shownWith: (boolean | undefined)[];
}

function createFakeWebview(
  delivery: boolean | Promise<boolean> = true
): FakeWebview {
  const messages: Record<string, unknown>[] = [];
  const shownWith: (boolean | undefined)[] = [];
  const messageEvents = new EventEmitter();
  return {
    view: {
      webview: {
        postMessage: async (message: Record<string, unknown>) => {
          const index = messages.push(message) - 1;
          messageEvents.emit(`message:${index}`, message);
          return delivery;
        },
      },
      show: (preserveFocus?: boolean) => {
        shownWith.push(preserveFocus);
      },
    },
    messages,
    shownWith,
    messageEvents,
  };
}

interface PostedPermissionRequest extends Record<string, unknown> {
  requestId: string;
}

async function waitForPermissionRequest(
  webview: FakeWebview,
  index: number,
  decision: Promise<RequestPermissionResponse>
): Promise<PostedPermissionRequest> {
  const eventName = `message:${index}`;
  const existing = webview.messages[index];
  let listener: ((message: Record<string, unknown>) => void) | undefined;
  const posted = existing
    ? Promise.resolve(existing)
    : new Promise<Record<string, unknown>>((resolve) => {
        listener = resolve;
        webview.messageEvents.once(eventName, listener);
      });

  let waiting = true;
  const prematureSettlement = new Promise<Record<string, unknown>>(
    (_, reject) => {
      void decision.then(
        (outcome) => {
          if (waiting) {
            reject(
              new assert.AssertionError({
                message: `permission request settled before posting: ${JSON.stringify(outcome)}`,
              })
            );
          }
        },
        (error) => {
          if (waiting) {
            reject(error);
          }
        }
      );
    }
  );

  try {
    const message = await Promise.race([posted, prematureSettlement]);
    if (typeof message.requestId !== "string") {
      assert.fail("permission request must include a string request id");
    }
    return message as PostedPermissionRequest;
  } finally {
    waiting = false;
    if (listener) {
      webview.messageEvents.off(eventName, listener);
    }
  }
}

async function waitForDocumentContent(
  document: vscode.TextDocument,
  expected: string
): Promise<void> {
  if (document.getText() === expected) {
    return;
  }
  await new Promise<void>((resolve) => {
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document && document.getText() === expected) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

function makePermissionRequest(
  overrides: Partial<RequestPermissionRequest> = {}
): RequestPermissionRequest {
  return {
    sessionId: "test-session",
    toolCall: { toolCallId: "tool-1", title: "Write file" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    ...overrides,
  };
}

/**
 * The extension host's `process.execPath` is the Electron binary, which needs
 * a display and is not a usable stand-in for a command an agent would run.
 */
const NODE_EXECUTABLE = process.env.npm_node_execpath ?? "node";

interface TerminalCreateRequest {
  command: string;
  args?: string[];
  cwd?: string | null;
  outputByteLimit?: number;
}

interface TerminalTestHarness {
  view: FakeWebview["view"];
  handleRequestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse>;
  handlePermissionResponse(message: {
    requestId: string;
    optionId?: string;
  }): void;
  expirePermissionRequests(): void;
  handleCreateTerminal(
    params: TerminalCreateRequest & { sessionId: string }
  ): Promise<{ terminalId: string }>;
  handleTerminalOutput(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<{ output: string }>;
  handleWaitForTerminalExit(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<unknown>;
  handleKillTerminalCommand(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<unknown>;
  handleReleaseTerminal(params: {
    sessionId: string;
    terminalId: string;
  }): Promise<unknown>;
  disposeTerminals(): Promise<void>;
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.find(
    (candidate) => candidate.uri.scheme === "file"
  );
  if (!folder) {
    throw new Error(
      "Integration tests require the workspace folder configured in .vscode-test.mjs"
    );
  }
  return folder.uri.fsPath;
}

/**
 * Drives the real permission path an agent must traverse before a terminal can
 * run and returns the exact launch descriptor shown to the user.
 */
async function decideTerminalRequest(
  provider: TerminalTestHarness,
  webview: FakeWebview,
  rawInput: TerminalCreateRequest,
  decisionId: "once" | "always" | "deny" = "once"
): Promise<Record<string, unknown>> {
  const pendingCount = webview.messages.length;
  const decision = provider.handleRequestPermission(
    makePermissionRequest({
      toolCall: { toolCallId: `tool-${pendingCount}`, rawInput },
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    })
  );
  const posted = await waitForPermissionRequest(
    webview,
    pendingCount,
    decision
  );
  const requestId = posted.requestId;
  provider.handlePermissionResponse({ requestId, optionId: decisionId });
  assert.deepStrictEqual(await decision, {
    outcome: { outcome: "selected", optionId: decisionId },
  });
  return posted;
}

suite("ChatViewProvider", () => {
  let memento: TestMemento;
  let acpClient: TestACPClient;
  let mockExtensionUri: vscode.Uri;

  setup(() => {
    memento = new TestMemento();
    acpClient = new TestACPClient();
    mockExtensionUri = vscode.Uri.file("/mock/extension");
  });

  teardown(() => {
    memento.clear();
    acpClient.resetCallCounts();
  });

  suite("Mode/Model Persistence with Validation", () => {
    test("should validate and restore saved mode against available modes", async () => {
      await memento.update("vscode-acp.selectedMode", "test-mode");

      class ACPClientWithModes extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: {
              availableModes: [
                { id: "test-mode", name: "Test Mode" },
                { id: "other-mode", name: "Other Mode" },
              ],
              currentModeId: "other-mode",
            },
            models: null,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModes();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSavedModeAndModel;
      await restoreMethod.call(provider);

      assert.strictEqual(client.lastSetModeId, "test-mode");
      assert.strictEqual(client.getSetModeCallCount(), 1);
    });

    test("should validate and restore saved model against available models", async () => {
      await memento.update("vscode-acp.selectedModel", "gpt-4");

      class ACPClientWithModels extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [
                { modelId: "gpt-4", name: "GPT-4" },
                { modelId: "gpt-3.5", name: "GPT-3.5" },
              ],
              currentModelId: "gpt-3.5",
            },
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModels();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSavedModeAndModel;
      await restoreMethod.call(provider);

      assert.strictEqual(client.lastSetModelId, "gpt-4");
      assert.strictEqual(client.getSetModelCallCount(), 1);
    });

    test("should skip invalid mode IDs not in available modes", async () => {
      await memento.update("vscode-acp.selectedMode", "removed-mode");

      class ACPClientWithModes extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: {
              availableModes: [
                { id: "valid-mode-1", name: "Valid Mode 1" },
                { id: "valid-mode-2", name: "Valid Mode 2" },
              ],
              currentModeId: "valid-mode-1",
            },
            models: null,
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModes();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSavedModeAndModel;
      await restoreMethod.call(provider);

      assert.strictEqual(client.getSetModeCallCount(), 0);
    });

    test("should skip invalid model IDs not in available models", async () => {
      await memento.update("vscode-acp.selectedModel", "removed-model");

      class ACPClientWithModels extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: null,
            models: {
              availableModels: [
                { modelId: "valid-model-1", name: "Valid Model 1" },
                { modelId: "valid-model-2", name: "Valid Model 2" },
              ],
              currentModelId: "valid-model-1",
            },
            commands: null,
          };
        }
      }

      const client = new ACPClientWithModels();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSavedModeAndModel;
      await restoreMethod.call(provider);

      assert.strictEqual(client.getSetModelCallCount(), 0);
    });

    test("should not restore if nothing is saved", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSavedModeAndModel;
      await restoreMethod.call(provider);

      assert.strictEqual(acpClient.getSetModeCallCount(), 0);
      assert.strictEqual(acpClient.getSetModelCallCount(), 0);
    });

    test("should throw but be caught by caller if restoration fails", async () => {
      await memento.update("vscode-acp.selectedMode", "test-mode");

      class FailingACPClient extends TestACPClient {
        getSessionMetadata() {
          return {
            modes: {
              availableModes: [{ id: "test-mode", name: "Test Mode" }],
              currentModeId: "test-mode",
            },
            models: null,
            commands: null,
          };
        }

        async setMode(): Promise<void> {
          throw new Error("Failed to set mode");
        }
      }

      const client = new FailingACPClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as any,
        memento as any
      );

      const restoreMethod = (provider as any).restoreSavedModeAndModel;

      await assert.rejects(() => restoreMethod.call(provider));
    });
  });

  suite("Mode/Model Storage on Change", () => {
    test("should persist mode to globalState when changed", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const handleModeChange = (provider as any).handleModeChange;
      await handleModeChange.call(provider, "new-mode");

      const savedMode = memento.get<string>("vscode-acp.selectedMode");
      assert.strictEqual(savedMode, "new-mode");
    });

    test("should persist model to globalState when changed", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const handleModelChange = (provider as any).handleModelChange;
      await handleModelChange.call(provider, "new-model");

      const savedModel = memento.get<string>("vscode-acp.selectedModel");
      assert.strictEqual(savedModel, "new-model");
    });

    test("should call ACP client setMode before persisting", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      acpClient.resetCallCounts();
      const handleModeChange = (provider as any).handleModeChange;
      await handleModeChange.call(provider, "new-mode");

      assert.strictEqual(acpClient.lastSetModeId, "new-mode");
      assert.ok(acpClient.getSetModeCallCount() >= 1);
      assert.strictEqual(
        memento.get<string>("vscode-acp.selectedMode"),
        "new-mode"
      );
    });

    test("should call ACP client setModel before persisting", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      acpClient.resetCallCounts();
      const handleModelChange = (provider as any).handleModelChange;
      await handleModelChange.call(provider, "new-model");

      assert.strictEqual(acpClient.lastSetModelId, "new-model");
      assert.ok(acpClient.getSetModelCallCount() >= 1);
      assert.strictEqual(
        memento.get<string>("vscode-acp.selectedModel"),
        "new-model"
      );
    });

    test("should handle mode change errors gracefully", async () => {
      class FailingACPClient extends TestACPClient {
        async setMode(): Promise<void> {
          throw new Error("Failed to set mode");
        }
      }

      const failingClient = new FailingACPClient();

      const provider = new ChatViewProvider(
        mockExtensionUri,
        failingClient as any,
        memento as any
      );

      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const handleModeChange = (provider as any).handleModeChange;

      await handleModeChange.call(provider, "new-mode");

      assert.strictEqual(memento.get("vscode-acp.selectedMode"), undefined);
      assert.deepStrictEqual(messages.at(-1), {
        type: "sessionMetadata",
        modes: null,
        models: null,
        commands: null,
        promptCapabilities: {},
      });
    });

    test("should handle model change errors gracefully", async () => {
      class FailingACPClient extends TestACPClient {
        async setModel(): Promise<void> {
          throw new Error("Failed to set model");
        }
      }

      const failingClient = new FailingACPClient();

      const provider = new ChatViewProvider(
        mockExtensionUri,
        failingClient as any,
        memento as any
      );

      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const handleModelChange = (provider as any).handleModelChange;

      await handleModelChange.call(provider, "new-model");

      assert.strictEqual(memento.get("vscode-acp.selectedModel"), undefined);
      assert.deepStrictEqual(messages.at(-1), {
        type: "sessionMetadata",
        modes: null,
        models: null,
        commands: null,
        promptCapabilities: {},
      });
    });

    test("should update memento with new values when changed multiple times", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const handleModeChange = (provider as any).handleModeChange;

      await handleModeChange.call(provider, "mode-1");
      assert.strictEqual(memento.get("vscode-acp.selectedMode"), "mode-1");

      acpClient.resetCallCounts();

      await handleModeChange.call(provider, "mode-2");
      assert.strictEqual(memento.get("vscode-acp.selectedMode"), "mode-2");
    });
  });

  test("restores session metadata when a replacement chat fails", async () => {
    const metadata = { modes: null, models: null, commands: [] };
    class FailingReplacementClient extends TestACPClient {
      newSessionCalls = 0;
      sentMessages: string[] = [];

      isConnected(): boolean {
        return true;
      }

      async newSession(): Promise<void> {
        this.newSessionCalls++;
        throw new RequestError(-32000, "Sign in to continue");
      }

      async sendMessage(text = ""): Promise<{ stopReason: string }> {
        this.sentMessages.push(text);
        return { stopReason: "end_turn" };
      }

      getSessionMetadata() {
        return metadata;
      }
    }

    const client = new FailingReplacementClient();
    const provider = new ChatViewProvider(
      mockExtensionUri,
      client as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(provider, "postMessage", {
      value: (message: Record<string, unknown>) => messages.push(message),
    });
    const lifecycle = provider as unknown as AuthenticationTestProvider & {
      handleNewChat(): Promise<void>;
    };
    lifecycle.hasSession = true;

    await lifecycle.handleNewChat();

    assert.deepStrictEqual(
      messages.find((message) => message.type === "error"),
      {
        type: "error",
        text: "Authentication required: Sign in to continue",
      }
    );
    assert.ok(!messages.some((message) => message.type === "chatCleared"));
    assert.deepStrictEqual(
      messages.find((message) => message.type === "sessionMetadata"),
      { type: "sessionMetadata", ...metadata, promptCapabilities: {} }
    );
    assert.deepStrictEqual(messages.at(-1), {
      type: "sessionTransition",
      active: false,
    });

    await lifecycle.handleUserMessage("Continue old session");
    assert.strictEqual(client.newSessionCalls, 1);
    assert.deepStrictEqual(client.sentMessages, ["Continue old session"]);
  });

  suite("Session transition races", () => {
    test("serializes a replacement chat behind initial session creation", async () => {
      let finishFirstSession!: () => void;
      let markFirstSessionStarted!: () => void;
      const firstSessionStarted = new Promise<void>((resolve) => {
        markFirstSessionStarted = resolve;
      });

      class DelayedSessionClient extends TestACPClient {
        private sessionRequestActive = false;
        public sessionCount = 0;

        isConnected(): boolean {
          return true;
        }

        async newSession(): Promise<void> {
          if (this.sessionRequestActive) {
            throw new Error("Session creation already in progress");
          }
          this.sessionRequestActive = true;
          this.sessionCount++;
          if (this.sessionCount === 1) {
            markFirstSessionStarted();
            await new Promise<void>((resolve) => {
              finishFirstSession = resolve;
            });
          }
          this.currentSessionId = `session-${this.sessionCount}`;
          this.sessionRequestActive = false;
        }
      }

      const client = new DelayedSessionClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const lifecycle = provider as unknown as {
        handleConnect(): Promise<void>;
        handleNewChat(): Promise<void>;
      };

      const connecting = lifecycle.handleConnect();
      await firstSessionStarted;
      const replacing = lifecycle.handleNewChat();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(client.sessionCount, 1);
      assert.ok(
        !messages.some((message) =>
          String(message.text).includes("Session creation already in progress")
        )
      );

      finishFirstSession();
      await Promise.all([connecting, replacing]);
      assert.strictEqual(client.sessionCount, 2);
    });

    test("drops a configuration snapshot completed after an agent restart", async () => {
      let finishConfiguration!: (request: NewSessionRequest) => void;
      let markConfigurationStarted!: () => void;
      const configurationStarted = new Promise<void>((resolve) => {
        markConfigurationStarted = resolve;
      });
      const configuration = new Promise<NewSessionRequest>((resolve) => {
        finishConfiguration = resolve;
      });

      class RestartedClient extends TestACPClient {
        public newSessionCalls = 0;

        isConnected(): boolean {
          return true;
        }

        async newSession(): Promise<void> {
          this.newSessionCalls++;
        }
      }

      const client = new RestartedClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const lifecycle = provider as unknown as {
        ensureSession(): Promise<void>;
        hasSession: boolean;
      };
      let requestedCwd = "";
      let requestedResource: string | undefined;
      Object.defineProperty(provider, "getSessionParameters", {
        value: async (cwd: string, resource?: vscode.Uri) => {
          requestedCwd = cwd;
          requestedResource = resource?.toString();
          markConfigurationStarted();
          return configuration;
        },
      });

      const starting = lifecycle.ensureSession();
      await configurationStarted;
      client.emitStateChange("disconnected");
      finishConfiguration({ cwd: requestedCwd, mcpServers: [] });
      await starting;

      assert.strictEqual(client.newSessionCalls, 0);
      assert.strictEqual(lifecycle.hasSession, false);
      assert.strictEqual(
        requestedResource,
        vscode.workspace.workspaceFolders?.[0]?.uri.toString()
      );
    });

    test("does not load a stale folder snapshot after the connection drops", async () => {
      let finishConfiguration!: (request: NewSessionRequest) => void;
      let markConfigurationStarted!: () => void;
      const configurationStarted = new Promise<void>((resolve) => {
        markConfigurationStarted = resolve;
      });
      const configuration = new Promise<NewSessionRequest>((resolve) => {
        finishConfiguration = resolve;
      });

      class RestartedLoadClient extends TestACPClient {
        public loadSessionCalls = 0;

        isConnected(): boolean {
          return true;
        }

        supportsSessionLoad(): boolean {
          return true;
        }

        async loadSession(): Promise<void> {
          this.loadSessionCalls++;
        }
      }

      const exactResource = vscode.workspace.workspaceFolders?.[0]?.uri;
      assert.ok(exactResource);
      const client = new RestartedLoadClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const lifecycle = provider as unknown as {
        hasSession: boolean;
        loadStoredSession(session: {
          sessionId: string;
          agentId: string;
          cwd: string;
          configurationResource: string;
          createdAt: number;
          lastUsedAt: number;
          preview: string;
          messageCount: number;
        }): Promise<void>;
      };
      lifecycle.hasSession = true;
      let requestedResource: string | undefined;
      Object.defineProperty(provider, "getSessionParameters", {
        value: async (_cwd: string, resource?: vscode.Uri) => {
          requestedResource = resource?.toString();
          markConfigurationStarted();
          return configuration;
        },
      });

      const loading = lifecycle.loadStoredSession({
        sessionId: "stored-session",
        agentId: "test-agent",
        cwd: "/stored-workspace",
        configurationResource: exactResource.toString(),
        createdAt: 1,
        lastUsedAt: 1,
        preview: "Stored conversation",
        messageCount: 1,
      });
      await configurationStarted;
      client.emitStateChange("disconnected");
      finishConfiguration({ cwd: "/stored-workspace", mcpServers: [] });
      await loading;

      assert.strictEqual(requestedResource, exactResource.toString());
      assert.strictEqual(client.loadSessionCalls, 0);
      assert.strictEqual(lifecycle.hasSession, false);
    });

    test("drops an in-flight replacement snapshot after an agent switch", async () => {
      let finishConfiguration!: (request: NewSessionRequest) => void;
      let markConfigurationStarted!: () => void;
      const configurationStarted = new Promise<void>((resolve) => {
        markConfigurationStarted = resolve;
      });
      const configuration = new Promise<NewSessionRequest>((resolve) => {
        finishConfiguration = resolve;
      });

      class SwitchedAgentClient extends TestACPClient {
        public newSessionCalls = 0;

        isConnected(): boolean {
          return true;
        }

        async newSession(): Promise<void> {
          this.newSessionCalls++;
        }
      }

      const client = new SwitchedAgentClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      Object.defineProperty(provider, "getConfiguredAgent", {
        value: () => ({}),
      });
      Object.defineProperty(provider, "getSessionParameters", {
        value: async () => {
          markConfigurationStarted();
          return configuration;
        },
      });
      const lifecycle = provider as unknown as {
        hasSession: boolean;
        handleAgentChange(agentId: string): void;
        handleNewChat(): Promise<void>;
      };
      lifecycle.hasSession = true;

      const replacement = lifecycle.handleNewChat();
      await configurationStarted;
      lifecycle.handleAgentChange("replacement-agent");
      finishConfiguration({ cwd: "/replacement", mcpServers: [] });
      await replacement;

      assert.strictEqual(client.newSessionCalls, 0);
      assert.strictEqual(lifecycle.hasSession, false);
    });

    test("does not finish session creation after the provider is disposed", async () => {
      let finishConfiguration!: (request: NewSessionRequest) => void;
      let markConfigurationStarted!: () => void;
      const configurationStarted = new Promise<void>((resolve) => {
        markConfigurationStarted = resolve;
      });
      const configuration = new Promise<NewSessionRequest>((resolve) => {
        finishConfiguration = resolve;
      });

      class DisposedClient extends TestACPClient {
        public newSessionCalls = 0;

        isConnected(): boolean {
          return true;
        }

        async newSession(): Promise<void> {
          this.newSessionCalls++;
        }
      }

      const client = new DisposedClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      Object.defineProperty(provider, "getSessionParameters", {
        value: async () => {
          markConfigurationStarted();
          return configuration;
        },
      });
      const lifecycle = provider as unknown as {
        ensureSession(): Promise<void>;
        hasSession: boolean;
      };

      const starting = lifecycle.ensureSession();
      await configurationStarted;
      provider.dispose();
      finishConfiguration({ cwd: "/disposed", mcpServers: [] });
      await starting;

      assert.strictEqual(client.newSessionCalls, 0);
      assert.strictEqual(lifecycle.hasSession, false);
    });

    test("queues a prompt until session restore finishes", async () => {
      let finishLoad!: () => void;
      let markLoadStarted!: () => void;
      const loadStarted = new Promise<void>((resolve) => {
        markLoadStarted = resolve;
      });

      class DelayedLoadClient extends TestACPClient {
        public promptSent = false;

        isConnected(): boolean {
          return true;
        }

        supportsSessionLoad(): boolean {
          return true;
        }

        async loadSession(params: LoadSessionRequest): Promise<void> {
          this.currentSessionId = null;
          markLoadStarted();
          await new Promise<void>((resolve) => {
            finishLoad = resolve;
          });
          this.currentSessionId = params.sessionId;
        }

        async sendMessage(): Promise<{ stopReason: string }> {
          assert.strictEqual(this.currentSessionId, "restored-session");
          this.promptSent = true;
          this.emitSessionUpdate({
            sessionId: "restored-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "agent-1",
              content: { type: "text", text: "Restored reply" },
            },
          } satisfies SessionNotification);
          return { stopReason: "end_turn" };
        }
      }

      const client = new DelayedLoadClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const lifecycle = provider as unknown as {
        hasSession: boolean;
        handleUserMessage(text: string): Promise<void>;
        loadStoredSession(session: {
          sessionId: string;
          agentId: string;
          cwd: string;
          createdAt: number;
          lastUsedAt: number;
          preview: string;
          messageCount: number;
        }): Promise<void>;
      };
      lifecycle.hasSession = true;

      const loading = lifecycle.loadStoredSession({
        sessionId: "restored-session",
        agentId: "test-agent",
        cwd: process.cwd(),
        createdAt: 1,
        lastUsedAt: 1,
        preview: "Restored conversation",
        messageCount: 1,
      });
      await loadStarted;
      const prompt = lifecycle.handleUserMessage("Continue restored work");
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(client.promptSent, false);
      finishLoad();
      await Promise.all([loading, prompt]);
      assert.strictEqual(client.promptSent, true);
      assert.ok(!messages.some((message) => message.type === "error"));
    });

    test("drops a queued prompt after a newer replacement starts", async () => {
      let finishFirstSession!: () => void;
      let finishSecondSession!: () => void;
      let markFirstSessionStarted!: () => void;
      let markSecondSessionStarted!: () => void;
      const firstSessionStarted = new Promise<void>((resolve) => {
        markFirstSessionStarted = resolve;
      });
      const secondSessionStarted = new Promise<void>((resolve) => {
        markSecondSessionStarted = resolve;
      });

      class ChainedSessionClient extends TestACPClient {
        public sessionCount = 0;
        public promptSessionIds: Array<string | null> = [];

        isConnected(): boolean {
          return true;
        }

        async newSession(): Promise<void> {
          this.sessionCount++;
          const sessionCount = this.sessionCount;
          if (sessionCount === 1) {
            markFirstSessionStarted();
            await new Promise<void>((resolve) => {
              finishFirstSession = resolve;
            });
          } else {
            markSecondSessionStarted();
            await new Promise<void>((resolve) => {
              finishSecondSession = resolve;
            });
          }
          this.currentSessionId = `session-${sessionCount}`;
        }

        async sendMessage(): Promise<{ stopReason: string }> {
          this.promptSessionIds.push(this.currentSessionId);
          return { stopReason: "end_turn" };
        }
      }

      const client = new ChainedSessionClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const lifecycle = provider as unknown as {
        hasSession: boolean;
        handleNewChat(): Promise<void>;
        handleUserMessage(text: string): Promise<void>;
      };
      lifecycle.hasSession = true;

      const firstReplacement = lifecycle.handleNewChat();
      await firstSessionStarted;
      const queuedPrompt = lifecycle.handleUserMessage("stale draft");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const secondReplacement = lifecycle.handleNewChat();

      finishFirstSession();
      await secondSessionStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(client.promptSessionIds, []);

      finishSecondSession();
      await Promise.all([firstReplacement, secondReplacement, queuedPrompt]);
      assert.deepStrictEqual(client.promptSessionIds, []);
      assert.ok(
        messages.some(
          (message) =>
            message.type === "streamEnd" && message.stopReason === "cancelled"
        )
      );
    });

    test("settles optimistic locks on transition-free exits", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        new TestACPClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const lifecycle = provider as unknown as {
        handleNewChat(): Promise<void>;
        handleSelectStoredSession(sessionId: string): Promise<void>;
      };

      await lifecycle.handleNewChat();
      assert.deepStrictEqual(messages.at(-1), {
        type: "sessionTransition",
        active: false,
      });

      messages.length = 0;
      await lifecycle.handleSelectStoredSession("missing-session");
      assert.deepStrictEqual(messages, [
        {
          type: "replayFailed",
          text: "Session is no longer available.",
        },
        { type: "sessionTransition", active: false },
      ]);
    });

    test("releases replay state when the agent disconnects", () => {
      const client = new TestACPClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const internals = provider as unknown as {
        isReplaying: boolean;
        replayGeneration: number | null;
      };
      internals.isReplaying = true;
      internals.replayGeneration = 0;

      client.emitStateChange("disconnected");

      assert.strictEqual(internals.isReplaying, false);
      assert.strictEqual(internals.replayGeneration, null);
      assert.deepStrictEqual(
        messages.find((message) => message.type === "replayFailed"),
        {
          type: "replayFailed",
          text: "The agent disconnected while restoring this session.",
        }
      );
    });
  });

  suite("authentication", () => {
    test("offers only agent-managed methods and neutralizes agent-supplied icon syntax", async () => {
      class AuthenticationClient extends TestACPClient {
        getAuthenticationMethods(): readonly AuthMethod[] {
          return [
            {
              id: "browser",
              name: "$(verified) Browser sign-in",
              description: "$(shield) Continue in your browser",
            },
            {
              id: "terminal",
              name: "Terminal sign-in",
              type: "terminal",
            },
            // A client-executed method type from a future ACP revision. The SDK
            // does not validate `initialize` responses, so it reaches the client
            // verbatim and must not be offered as agent-managed.
            {
              id: "future",
              name: "Future sign-in",
              type: "terminal-v2",
            } as unknown as AuthMethod,
          ];
        }
      }

      const client = new AuthenticationClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      // Private methods are test seams for the authentication lifecycle.
      const authenticationProvider =
        provider as unknown as AuthenticationTestProvider;

      const window = vscode.window as unknown as Record<string, unknown>;
      const descriptor = Object.getOwnPropertyDescriptor(
        vscode.window,
        "showQuickPick"
      );
      let choices: Array<{
        label: string;
        description?: string;
        methodId: string;
      }> = [];
      Object.defineProperty(vscode.window, "showQuickPick", {
        configurable: true,
        value: async (
          items: readonly {
            label: string;
            description?: string;
            methodId: string;
          }[]
        ) => {
          choices = [...items];
          return items[0];
        },
      });

      try {
        const selected =
          await authenticationProvider.selectAuthenticationMethod();

        assert.strictEqual(selected, "browser");
        assert.deepStrictEqual(choices, [
          {
            label: "\\$(verified) Browser sign-in",
            description: "\\$(shield) Continue in your browser",
            methodId: "browser",
          },
        ]);
      } finally {
        if (descriptor) {
          Object.defineProperty(vscode.window, "showQuickPick", descriptor);
        } else {
          delete window.showQuickPick;
        }
      }
    });

    test("authenticates once and retries session creation once", async () => {
      class AuthenticationClient extends TestACPClient {
        newSessionCalls = 0;
        authenticatedMethods: string[] = [];
        requests: NewSessionRequest[] = [];

        isConnected(): boolean {
          return true;
        }

        getAuthenticationMethods(): readonly AuthMethod[] {
          return [{ id: "browser", name: "Browser sign-in" }];
        }

        async newSession(request: NewSessionRequest): Promise<void> {
          this.requests.push(request);
          this.newSessionCalls++;
          if (this.newSessionCalls === 1) {
            throw new RequestError(-32000, "Authentication required");
          }
        }

        async authenticate(
          methodId: AuthMethodId,
          selectedGeneration: number
        ): Promise<void> {
          this.authenticatedMethods.push(`${methodId}@${selectedGeneration}`);
        }
      }

      const client = new AuthenticationClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      // Private methods are test seams for the authentication lifecycle.
      const authenticationProvider =
        provider as unknown as AuthenticationTestProvider;
      Object.defineProperty(provider, "selectAuthenticationMethod", {
        value: async () => "browser",
      });

      await authenticationProvider.ensureSession();

      assert.strictEqual(client.newSessionCalls, 2);
      assert.strictEqual(client.requests[0], client.requests[1]);
      assert.deepStrictEqual(client.requests[0], {
        cwd:
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        mcpServers: [],
      });
      assert.deepStrictEqual(client.authenticatedMethods, ["browser@1"]);
      assert.strictEqual(authenticationProvider.hasSession, true);
    });

    test("does not authenticate again when the retry still requires authentication", async () => {
      class AuthenticationClient extends TestACPClient {
        newSessionCalls = 0;
        authenticateCalls = 0;

        isConnected(): boolean {
          return true;
        }

        getAuthenticationMethods(): readonly AuthMethod[] {
          return [{ id: "browser", name: "Browser sign-in" }];
        }

        async newSession(): Promise<void> {
          this.newSessionCalls++;
          throw new RequestError(-32000, "Authentication required");
        }

        async authenticate(): Promise<void> {
          this.authenticateCalls++;
        }
      }

      const client = new AuthenticationClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const authenticationProvider =
        provider as unknown as AuthenticationTestProvider;
      Object.defineProperty(provider, "selectAuthenticationMethod", {
        value: async () => "browser",
      });

      await assert.rejects(
        () => authenticationProvider.ensureSession(),
        /Authentication required/
      );
      assert.strictEqual(client.newSessionCalls, 2);
      assert.strictEqual(client.authenticateCalls, 1);
      assert.strictEqual(authenticationProvider.hasSession, false);
    });

    test("unlocks selection while keeping authentication serialized", async () => {
      let resolveSelection!: () => void;
      let selectionStarted!: () => void;
      const selectionGate = new Promise<void>((resolve) => {
        resolveSelection = resolve;
      });
      const started = new Promise<void>((resolve) => {
        selectionStarted = resolve;
      });

      class AuthenticationClient extends TestACPClient {
        newSessionCalls = 0;

        isConnected(): boolean {
          return true;
        }

        getAuthenticationMethods(): readonly AuthMethod[] {
          return [{ id: "browser", name: "Browser sign-in" }];
        }

        async newSession(): Promise<void> {
          this.newSessionCalls++;
          if (this.newSessionCalls === 1) {
            throw new RequestError(-32000, "Authentication required");
          }
        }

        async authenticate(): Promise<void> {}
      }

      const client = new AuthenticationClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const authenticationProvider =
        provider as unknown as AuthenticationTestProvider & {
          handleNewChat(): Promise<void>;
        };
      Object.defineProperty(provider, "selectAuthenticationMethod", {
        value: async () => {
          selectionStarted();
          await selectionGate;
          return "browser";
        },
      });

      const session = authenticationProvider.ensureSession();
      await started;
      assert.deepStrictEqual(
        messages.filter((message) => message.type === "sessionTransition"),
        [
          {
            type: "sessionTransition",
            active: true,
            text: "Starting session…",
          },
          { type: "sessionTransition", active: false, restoreFocus: false },
        ]
      );

      const replacement = authenticationProvider.handleNewChat();
      await Promise.resolve();
      assert.strictEqual(client.newSessionCalls, 1);

      resolveSelection();
      await Promise.all([session, replacement]);
      assert.strictEqual(client.newSessionCalls, 3);
      assert.deepStrictEqual(
        messages
          .filter((message) => message.type === "sessionTransition")
          .at(-1),
        { type: "sessionTransition", active: false }
      );
    });

    test("does not retry after authentication cancellation or a stale selection", async () => {
      class AuthenticationClient extends TestACPClient {
        newSessionCalls = 0;
        authenticatedMethods: string[] = [];
        authenticationError: Error | null = null;

        isConnected(): boolean {
          return true;
        }

        getAuthenticationMethods(): readonly AuthMethod[] {
          return [{ id: "browser", name: "Browser sign-in" }];
        }

        async newSession(): Promise<void> {
          this.newSessionCalls++;
          throw new RequestError(-32000, "Authentication required");
        }

        async authenticate(
          methodId: AuthMethodId,
          selectedGeneration: number
        ): Promise<void> {
          this.authenticatedMethods.push(`${methodId}@${selectedGeneration}`);
          if (this.authenticationError) {
            throw this.authenticationError;
          }
        }
      }

      const cancelledClient = new AuthenticationClient();
      const cancelledProvider = new ChatViewProvider(
        mockExtensionUri,
        cancelledClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      // Private methods are test seams for the authentication lifecycle.
      const cancelledAuthenticationProvider =
        cancelledProvider as unknown as AuthenticationTestProvider;
      Object.defineProperty(cancelledProvider, "selectAuthenticationMethod", {
        value: async () => null,
      });

      await assert.rejects(
        () => cancelledAuthenticationProvider.ensureSession(),
        /Authentication cancelled/
      );
      assert.strictEqual(cancelledClient.newSessionCalls, 1);
      assert.deepStrictEqual(cancelledClient.authenticatedMethods, []);
      assert.strictEqual(cancelledAuthenticationProvider.hasSession, false);

      const cancellationMessages: Array<Record<string, unknown>> = [];
      Object.defineProperty(cancelledProvider, "postMessage", {
        value: (message: Record<string, unknown>) =>
          cancellationMessages.push(message),
      });
      await cancelledAuthenticationProvider.handleUserMessage("Resume this");
      assert.ok(
        cancellationMessages.some(
          (message) =>
            message.type === "restoreInput" && message.text === "Resume this"
        )
      );
      assert.ok(
        !cancellationMessages.some((message) => message.type === "userMessage")
      );
      assert.strictEqual(cancelledClient.newSessionCalls, 2);

      const staleClient = new AuthenticationClient();
      staleClient.authenticationError = new Error(
        "Authentication method is not available"
      );
      const staleProvider = new ChatViewProvider(
        mockExtensionUri,
        staleClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      // Private methods are test seams for the authentication lifecycle.
      const staleAuthenticationProvider =
        staleProvider as unknown as AuthenticationTestProvider;
      Object.defineProperty(staleProvider, "selectAuthenticationMethod", {
        value: async () => "browser",
      });

      await assert.rejects(
        () => staleAuthenticationProvider.ensureSession(),
        /Authentication method is not available/
      );
      assert.strictEqual(staleClient.newSessionCalls, 1);
      assert.deepStrictEqual(staleClient.authenticatedMethods, ["browser@1"]);
      assert.strictEqual(staleAuthenticationProvider.hasSession, false);
    });

    test("carries the connection generation that produced the method list", async () => {
      class ReconnectingClient extends TestACPClient {
        newSessionCalls = 0;
        authenticatedGenerations: number[] = [];

        isConnected(): boolean {
          return true;
        }

        getAuthenticationMethods(): readonly AuthMethod[] {
          return [{ id: "browser", name: "Browser sign-in" }];
        }

        async newSession(): Promise<void> {
          this.newSessionCalls++;
          throw new RequestError(-32000, "Authentication required");
        }

        async authenticate(
          _methodId: AuthMethodId,
          selectedGeneration: number
        ): Promise<void> {
          this.authenticatedGenerations.push(selectedGeneration);
          if (selectedGeneration !== this.connectionGeneration) {
            throw new Error("Authentication selection is stale");
          }
        }
      }

      const client = new ReconnectingClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      // Private methods are test seams for the authentication lifecycle.
      const authenticationProvider =
        provider as unknown as AuthenticationTestProvider;
      // The agent process is replaced while the native picker is open.
      Object.defineProperty(provider, "selectAuthenticationMethod", {
        value: async () => {
          client.connectionGeneration++;
          return "browser";
        },
      });

      await assert.rejects(
        () => authenticationProvider.ensureSession(),
        /Authentication selection is stale/
      );
      assert.deepStrictEqual(client.authenticatedGenerations, [1]);
      assert.strictEqual(client.newSessionCalls, 1);
      assert.strictEqual(authenticationProvider.hasSession, false);
    });
  });

  test("renders structured prompt errors with agent diagnostics", async () => {
    class AuthenticationRequiredClient extends TestACPClient {
      isConnected(): boolean {
        return true;
      }

      async sendMessage(): Promise<{ stopReason: string }> {
        throw new RequestError(-32000, "Sign in to continue");
      }
    }

    const provider = new ChatViewProvider(
      mockExtensionUri,
      new AuthenticationRequiredClient() as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(provider, "postMessage", {
      value: (message: Record<string, unknown>) => messages.push(message),
    });
    const handleUserMessage = Reflect.get(provider, "handleUserMessage") as (
      this: ChatViewProvider,
      text: string
    ) => Promise<void>;

    await handleUserMessage.call(provider, "Hello");

    assert.deepStrictEqual(
      messages.find((message) => message.type === "error"),
      {
        type: "error",
        text: "Authentication required: Sign in to continue",
      }
    );
    assert.deepStrictEqual(messages.at(-1), {
      type: "streamEnd",
      stopReason: "error",
    });
  });

  test("never includes agent stderr payloads in logs or UI", () => {
    const provider = new ChatViewProvider(
      mockExtensionUri,
      acpClient as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const secret = "session-}secret-value";
    const messages: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    Object.defineProperty(provider, "postMessage", {
      value: (message: Record<string, unknown>) => messages.push(message),
    });
    const redactor = Reflect.get(
      provider,
      "mcpSecretRedactor"
    ) as McpSecretRedactor;
    redactor.add([secret]);
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => logs.push(values.join(" "));

    try {
      const handleStderr = Reflect.get(provider, "handleStderr") as (
        this: ChatViewProvider,
        text: string
      ) => void;
      handleStderr.call(provider, 'ProviderError:\ndata: {token: "session-}');
      handleStderr.call(provider, 'secret-value", modelID: "model"}');
      const postACPError = Reflect.get(provider, "postACPError") as (
        this: ChatViewProvider,
        context: string,
        error: unknown
      ) => void;
      postACPError.call(provider, "Session failed", new Error(secret));
    } finally {
      console.error = originalConsoleError;
    }

    const visibleOutput = JSON.stringify(messages);
    const emittedLogs = logs.join("\n");
    for (const fragment of ["session-", "secret-value"]) {
      assert.ok(!visibleOutput.includes(fragment));
      assert.ok(!emittedLogs.includes(fragment));
    }
    assert.ok(!visibleOutput.includes(secret));
    assert.ok(!emittedLogs.includes(secret));
    assert.match(visibleOutput, /\[redacted\]/);
    assert.ok(
      messages.some(
        (message) =>
          message.type === "agentError" &&
          message.text === "Agent reported an error."
      )
    );
  });

  test("redacts session creation errors without losing RequestError identity", async () => {
    const secret = "session-secret-value";
    class SecretErrorClient extends TestACPClient {
      isConnected(): boolean {
        return true;
      }

      async newSession(): Promise<void> {
        throw new RequestError(-32000, `Agent echoed ${secret}`, {
          token: secret,
        });
      }
    }

    const provider = new ChatViewProvider(
      mockExtensionUri,
      new SecretErrorClient() as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const redactor = Reflect.get(
      provider,
      "mcpSecretRedactor"
    ) as McpSecretRedactor;
    redactor.add([secret]);
    const handleConnect = Reflect.get(provider, "handleConnect") as (
      this: ChatViewProvider
    ) => Promise<void>;

    await assert.rejects(
      () => handleConnect.call(provider),
      (error) => {
        assert.ok(error instanceof RequestError);
        assert.strictEqual(error.code, -32000);
        assert.strictEqual(error.message, "Agent echoed [redacted]");
        assert.strictEqual(error.data, undefined);
        return true;
      }
    );
  });

  test("ends a cancelled prompt without an error card", async () => {
    class CancellingClient extends TestACPClient {
      isConnected(): boolean {
        return true;
      }

      async sendMessage(): Promise<{ stopReason: string }> {
        throw new RequestError(-32800, "Request cancelled");
      }
    }

    const provider = new ChatViewProvider(
      mockExtensionUri,
      new CancellingClient() as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(provider, "postMessage", {
      value: (message: Record<string, unknown>) => messages.push(message),
    });
    const handleUserMessage = Reflect.get(provider, "handleUserMessage") as (
      this: ChatViewProvider,
      text: string
    ) => Promise<void>;

    await handleUserMessage.call(provider, "Hello");

    assert.ok(!messages.some((message) => message.type === "error"));
    assert.deepStrictEqual(messages.at(-1), {
      type: "streamEnd",
      stopReason: "cancelled",
    });
  });

  test("forwards agent stderr diagnostics to the chat", () => {
    const client = new TestACPClient();
    const provider = new ChatViewProvider(
      mockExtensionUri,
      client as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(provider, "postMessage", {
      value: (message: Record<string, unknown>) => messages.push(message),
    });

    client.emitStderr(
      'ModelNotFoundError:\ndata: {providerID: "openai", modelID: "missing"}'
    );

    assert.deepStrictEqual(messages.at(-1), {
      type: "agentError",
      text: "Agent reported an error.",
    });
  });

  suite("Session history", () => {
    test("preserves the loaded session MCP resource when saving", async () => {
      class LoadingClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }

        supportsSessionLoad(): boolean {
          return true;
        }

        async loadSession(params: LoadSessionRequest): Promise<void> {
          this.currentSessionId = params.sessionId;
        }
      }

      const remoteResource =
        "vscode-remote://ssh-remote+host/workspace-folder-b";
      const workspaceState = new TestMemento();
      const session = {
        sessionId: "restored-session",
        agentId: "test-agent",
        cwd: "/workspace-folder-b",
        configurationResource: remoteResource,
        createdAt: 1,
        lastUsedAt: 1,
        preview: "Stored in folder B",
        messageCount: 1,
      };
      await workspaceState.update("vscode-acp.sessionHistory", [session]);
      const provider = new ChatViewProvider(
        mockExtensionUri,
        new LoadingClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento,
        workspaceState as unknown as vscode.Memento
      );
      const sessionProvider = provider as unknown as {
        loadStoredSession(value: typeof session): Promise<void>;
        saveCurrentSession(preview?: string): Promise<void>;
      };

      await sessionProvider.loadStoredSession(session);
      await sessionProvider.saveCurrentSession("Continued in folder B");

      const [saved] = workspaceState.get<
        Array<{ cwd: string; configurationResource?: string }>
      >("vscode-acp.sessionHistory")!;
      assert.strictEqual(saved.cwd, session.cwd);
      assert.strictEqual(saved.configurationResource, remoteResource);
    });
    test("persists active session metadata in workspace state", async () => {
      const workspaceState = new TestMemento();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento,
        workspaceState as unknown as vscode.Memento
      );
      const sessionProvider = provider as unknown as {
        saveCurrentSession(preview?: string): Promise<void>;
      };

      await sessionProvider.saveCurrentSession("Describe the migration plan");

      const history = workspaceState.get<
        Array<{
          sessionId: string;
          agentId: string;
          cwd: string;
          preview: string;
          messageCount: number;
        }>
      >("vscode-acp.sessionHistory");
      assert.strictEqual(history?.length, 1);
      assert.strictEqual(history?.[0].sessionId, "test-session");
      assert.strictEqual(history?.[0].agentId, "test-agent");
      assert.strictEqual(
        history?.[0].cwd,
        vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? process.cwd()
      );
      assert.strictEqual(history?.[0].preview, "Describe the migration plan");
      assert.strictEqual(history?.[0].messageCount, 1);
    });

    test("keeps identical session ids isolated by agent", async () => {
      class SecondAgentClient extends TestACPClient {
        getAgentId(): string {
          return "agent-b";
        }
      }

      const workspaceState = new TestMemento();
      await workspaceState.update("vscode-acp.sessionHistory", [
        {
          sessionId: "shared-session",
          agentId: "agent-a",
          cwd: "/agent-a",
          createdAt: 1,
          lastUsedAt: 1,
          preview: "Agent A conversation",
          messageCount: 1,
        },
      ]);
      const client = new SecondAgentClient();
      client.currentSessionId = "shared-session";
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento,
        workspaceState as unknown as vscode.Memento
      );
      const sessionProvider = provider as unknown as {
        saveCurrentSession(preview?: string): Promise<void>;
        handleDeleteStoredSession(sessionId: string): Promise<void>;
      };

      await sessionProvider.saveCurrentSession("Agent B conversation");
      let history = workspaceState.get<
        Array<{ sessionId: string; agentId: string; preview: string }>
      >("vscode-acp.sessionHistory");
      assert.deepStrictEqual(
        history?.map(({ agentId, preview }) => ({ agentId, preview })),
        [
          { agentId: "agent-b", preview: "Agent B conversation" },
          { agentId: "agent-a", preview: "Agent A conversation" },
        ]
      );

      await sessionProvider.handleDeleteStoredSession("shared-session");
      history = workspaceState.get("vscode-acp.sessionHistory");
      assert.deepStrictEqual(
        history?.map(({ agentId }) => agentId),
        ["agent-a"]
      );
    });

    test("does not persist sessions before a turn completes", async () => {
      class ConnectedClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }
      }

      const workspaceState = new TestMemento();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        new ConnectedClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento,
        workspaceState as unknown as vscode.Memento
      );
      const sessionProvider = provider as unknown as {
        ensureSession(): Promise<void>;
        handleNewChat(): Promise<void>;
      };

      await sessionProvider.ensureSession();
      await sessionProvider.handleNewChat();

      assert.deepStrictEqual(
        workspaceState.get("vscode-acp.sessionHistory") ?? [],
        []
      );
    });

    test("finishes saving a completed turn before releasing the session UI", async () => {
      let finishSave!: () => void;
      let markSaveStarted!: () => void;
      const saveStarted = new Promise<void>((resolve) => {
        markSaveStarted = resolve;
      });
      const saveGate = new Promise<void>((resolve) => {
        finishSave = resolve;
      });

      class DelayedWorkspaceState extends TestMemento {
        async update(key: string, value: unknown): Promise<void> {
          if (key === "vscode-acp.sessionHistory") {
            markSaveStarted();
            await saveGate;
          }
          await super.update(key, value);
        }
      }

      class ReplyingClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }

        async sendMessage(): Promise<{ stopReason: string }> {
          this.emitSessionUpdate({
            sessionId: "test-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "reply",
              content: { type: "text", text: "Saved reply" },
            },
          } satisfies SessionNotification);
          return { stopReason: "end_turn" };
        }
      }

      const workspaceState = new DelayedWorkspaceState();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        new ReplyingClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento,
        workspaceState as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const sessionProvider = provider as unknown as {
        hasSession: boolean;
        handleUserMessage(text: string): Promise<void>;
      };
      sessionProvider.hasSession = true;

      const prompt = sessionProvider.handleUserMessage("Persist this turn");
      await saveStarted;
      assert.ok(!messages.some((message) => message.type === "streamEnd"));

      finishSave();
      await prompt;
      assert.deepStrictEqual(messages.at(-1), {
        type: "streamEnd",
        stopReason: "end_turn",
      });
    });

    test("rebuilds replayed messages without duplicating chunks", async () => {
      class LoadingClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }

        supportsSessionLoad(): boolean {
          return true;
        }

        async loadSession(params: LoadSessionRequest): Promise<void> {
          const sessionId = params.sessionId;
          this.currentSessionId = sessionId;
          this.emitSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              messageId: "user-1",
              content: { type: "text", text: "First " },
            },
          } satisfies SessionNotification);
          this.emitSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              messageId: "user-1",
              content: { type: "text", text: "question" },
            },
          } satisfies SessionNotification);
          this.emitSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              messageId: "user-1",
              content: {
                type: "resource_link",
                uri: "file:///workspace/replayed.ts",
                name: "replayed.ts",
                mimeType: "text/typescript",
                size: 99,
              },
            },
          } satisfies SessionNotification);
          this.emitSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "agent-1",
              content: { type: "text", text: "First " },
            },
          } satisfies SessionNotification);
          this.emitSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "agent-1",
              content: { type: "text", text: "answer" },
            },
          } satisfies SessionNotification);
        }
      }

      const client = new LoadingClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const sessionProvider = provider as unknown as {
        loadStoredSession(session: {
          sessionId: string;
          agentId: string;
          cwd: string;
          createdAt: number;
          lastUsedAt: number;
          preview: string;
          messageCount: number;
        }): Promise<void>;
      };

      await sessionProvider.loadStoredSession({
        sessionId: "restored-session",
        agentId: "test-agent",
        cwd: process.cwd(),
        createdAt: 1,
        lastUsedAt: 1,
        preview: "First question",
        messageCount: 1,
      });

      const completed = messages.find(
        (message) => message.type === "replayComplete"
      );
      // Internal provider message shape, captured directly at the postMessage
      // boundary after the SDK payload has already been typed.
      const replayed = completed?.messages as Array<{
        role: string;
        text: string;
        attachments?: Array<{
          uri: string;
          name: string;
          mimeType?: string;
          size?: number;
        }>;
      }>;
      assert.strictEqual(replayed[0].role, "user");
      assert.strictEqual(replayed[0].text, "First question");
      assert.deepStrictEqual(
        replayed[0].attachments?.map(({ uri, name, mimeType, size }) => ({
          uri,
          name,
          mimeType,
          size,
        })),
        [
          {
            uri: "file:///workspace/replayed.ts",
            name: "replayed.ts",
            mimeType: "text/typescript",
            size: 99,
          },
        ]
      );
      assert.deepStrictEqual(replayed[1], {
        role: "assistant",
        text: "First answer",
      });
    });

    test("keeps raw replay text for the webview sanitizer", async () => {
      class LoadingClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }

        async loadSession(params: LoadSessionRequest): Promise<void> {
          const sessionId = params.sessionId;
          this.currentSessionId = sessionId;
          this.emitSessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "agent-1",
              content: {
                type: "text",
                text: '<button class="permission-modal">Allow</button>',
              },
            },
          } satisfies SessionNotification);
        }
      }

      const client = new LoadingClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const sessionProvider = provider as unknown as {
        loadStoredSession(session: {
          sessionId: string;
          agentId: string;
          cwd: string;
          createdAt: number;
          lastUsedAt: number;
          preview: string;
          messageCount: number;
        }): Promise<void>;
      };

      await sessionProvider.loadStoredSession({
        sessionId: "restored-session",
        agentId: "test-agent",
        cwd: process.cwd(),
        createdAt: 1,
        lastUsedAt: 1,
        preview: "Unsafe response",
        messageCount: 1,
      });

      const completed = messages.find(
        (message) => message.type === "replayComplete"
      );
      const replayed = completed?.messages as Array<{
        text: string;
        html?: unknown;
      }>;
      assert.strictEqual(
        replayed[0].text,
        '<button class="permission-modal">Allow</button>'
      );
      assert.ok(!("html" in replayed[0]));
    });

    test("does not save a late prompt into a loaded session", async () => {
      let finishPrompt!: () => void;
      let markPromptStarted!: () => void;
      const promptStarted = new Promise<void>((resolve) => {
        markPromptStarted = resolve;
      });
      class InterleavedClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }

        async sendMessage(): Promise<{ stopReason: string }> {
          markPromptStarted();
          await new Promise<void>((resolve) => {
            finishPrompt = resolve;
          });
          return { stopReason: "end_turn" };
        }

        async loadSession(params: LoadSessionRequest): Promise<void> {
          this.currentSessionId = params.sessionId;
        }
      }

      const workspaceState = new TestMemento();
      await workspaceState.update("vscode-acp.sessionHistory", [
        {
          sessionId: "restored-session",
          agentId: "test-agent",
          cwd: process.cwd(),
          createdAt: 1,
          lastUsedAt: 1,
          preview: "Original preview",
          messageCount: 2,
        },
      ]);
      const client = new InterleavedClient();
      client.currentSessionId = "old-session";
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento,
        workspaceState as unknown as vscode.Memento
      );
      const sessionProvider = provider as unknown as {
        hasSession: boolean;
        handleUserMessage(text: string): Promise<void>;
        loadStoredSession(session: {
          sessionId: string;
          agentId: string;
          cwd: string;
          createdAt: number;
          lastUsedAt: number;
          preview: string;
          messageCount: number;
        }): Promise<void>;
      };
      sessionProvider.hasSession = true;

      const prompt = sessionProvider.handleUserMessage("Late prompt");
      await promptStarted;
      await sessionProvider.loadStoredSession({
        sessionId: "restored-session",
        agentId: "test-agent",
        cwd: process.cwd(),
        createdAt: 1,
        lastUsedAt: 1,
        preview: "Original preview",
        messageCount: 2,
      });
      finishPrompt();
      await prompt;

      const restored = workspaceState
        .get<
          Array<{ sessionId: string; preview: string; messageCount: number }>
        >("vscode-acp.sessionHistory")
        ?.find((entry) => entry.sessionId === "restored-session");
      assert.strictEqual(restored?.preview, "Original preview");
      assert.strictEqual(restored?.messageCount, 2);
    });

    test("rolls back load and preserves typed errors while redacting", async () => {
      class FailingLoadClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }

        supportsSessionLoad(): boolean {
          return true;
        }

        async loadSession(): Promise<void> {
          throw new RequestError(-32000, "Sign in with session-secret-value", {
            token: "session-secret-value",
          });
        }
      }

      const provider = new ChatViewProvider(
        mockExtensionUri,
        new FailingLoadClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const redactor = Reflect.get(
        provider,
        "mcpSecretRedactor"
      ) as McpSecretRedactor;
      redactor.add(["session-secret-value"]);
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const sessionProvider = provider as unknown as {
        hasSession: boolean;
        loadStoredSession(session: {
          sessionId: string;
          agentId: string;
          cwd: string;
          createdAt: number;
          lastUsedAt: number;
          preview: string;
          messageCount: number;
        }): Promise<void>;
      };
      sessionProvider.hasSession = true;

      await assert.rejects(
        () =>
          sessionProvider.loadStoredSession({
            sessionId: "missing-session",
            agentId: "test-agent",
            cwd: process.cwd(),
            createdAt: 1,
            lastUsedAt: 1,
            preview: "Previous conversation",
            messageCount: 1,
          }),
        (error) => {
          assert.ok(error instanceof RequestError);
          assert.strictEqual(error.code, -32000);
          assert.strictEqual(error.message, "Sign in with [redacted]");
          assert.strictEqual(error.data, undefined);
          return true;
        }
      );

      assert.strictEqual(sessionProvider.hasSession, true);
      assert.deepStrictEqual(
        messages.find((message) => message.type === "replayFailed"),
        {
          type: "replayFailed",
          text: "Authentication required: Sign in with [redacted]",
        }
      );
      assert.ok(!messages.some((message) => message.type === "replayComplete"));
      assert.deepStrictEqual(messages.at(-1), {
        type: "sessionTransition",
        active: false,
      });
    });
  });
  suite("Client capability handlers", () => {
    test("reads the authorized file instead of a stale dirty buffer", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const testProvider = provider as unknown as TestableCapabilityHandlers;
      const sandbox = await realpath(
        await mkdtemp(join(tmpdir(), "vscode-acp-chat-files-"))
      );
      const workspaceRoot = join(sandbox, "workspace");
      const filePath = join(workspaceRoot, "notes.txt");
      const uri = vscode.Uri.file(filePath);
      const savedContent = "first\nsecond\nthird";
      const context: WorkspaceFileAccessContext = {
        isTrusted: true,
        workspaceFolders: [
          { uri: vscode.Uri.file(workspaceRoot) } as vscode.WorkspaceFolder,
        ],
      };
      let document: vscode.TextDocument | undefined;

      try {
        await mkdir(workspaceRoot);
        await writeFile(filePath, savedContent);
        await workspaceFileCapabilities(context);
        Object.defineProperty(provider, "openWorkspaceFile", {
          value: (requestPath: string, operation: "read" | "write") =>
            openTrustedWorkspaceFile(requestPath, operation, context),
        });

        document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true });
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          uri,
          new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
          ),
          "first\nstale-secret\nthird"
        );
        await vscode.workspace.applyEdit(edit);

        const result = await testProvider.handleReadTextFile({
          sessionId: "session",
          path: filePath,
          line: 2,
          limit: 1,
        });

        assert.deepStrictEqual(result, { content: "second" });
      } finally {
        if (document) {
          const restore = new vscode.WorkspaceEdit();
          restore.replace(
            uri,
            new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length)
            ),
            savedContent
          );
          await vscode.workspace.applyEdit(restore);
          await document.save();
          await vscode.commands.executeCommand(
            "workbench.action.closeActiveEditor"
          );
        }
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    test("writes clean documents but preserves dirty editor changes", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const testProvider = provider as unknown as TestableCapabilityHandlers;
      const sandbox = await realpath(
        await mkdtemp(join(tmpdir(), "vscode-acp-chat-write-"))
      );
      const workspaceRoot = join(sandbox, "workspace");
      const filePath = join(workspaceRoot, "notes.txt");
      const uri = vscode.Uri.file(filePath);
      const savedContent = "saved content";
      const userContent = "unsaved user edit";
      const agentContent = "agent replacement";
      let document: vscode.TextDocument | undefined;

      try {
        await mkdir(workspaceRoot);
        await writeFile(filePath, savedContent);
        Object.defineProperty(provider, "openWorkspaceFile", {
          value: async () => {
            const fileHandle = await open(filePath, "r+");
            return {
              requestUri: uri,
              canonicalPath: filePath,
              canonicalRootPath: workspaceRoot,
              fileHandle,
              strategy: "descriptor" as const,
              byteLength: (await fileHandle.stat()).size,
            };
          },
        });

        document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true });
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          uri,
          new vscode.Range(0, 0, document.lineCount, 0),
          userContent
        );
        await vscode.workspace.applyEdit(edit);

        await assert.rejects(
          () =>
            testProvider.handleWriteTextFile({
              sessionId: "session",
              path: filePath,
              content: agentContent,
            }),
          (error: unknown) =>
            error instanceof Error &&
            error.message === DIRTY_EDITOR_WRITE_CONFLICT
        );
        assert.strictEqual(await readFile(filePath, "utf8"), savedContent);
        assert.strictEqual(document.getText(), userContent);
        assert.strictEqual(document.isDirty, true);

        await vscode.commands.executeCommand("undo");
        assert.strictEqual(document.getText(), savedContent);
        assert.strictEqual(document.isDirty, false);
        await vscode.commands.executeCommand("redo");
        assert.strictEqual(document.getText(), userContent);
        assert.strictEqual(document.isDirty, true);
        await vscode.commands.executeCommand("undo");
        assert.strictEqual(document.getText(), savedContent);
        assert.strictEqual(document.isDirty, false);

        await testProvider.handleWriteTextFile({
          sessionId: "session",
          path: filePath,
          content: agentContent,
        });
        assert.strictEqual(await readFile(filePath, "utf8"), agentContent);
        await waitForDocumentContent(document, agentContent);
        assert.strictEqual(document.isDirty, false);
      } finally {
        if (document?.isDirty) {
          await document.save();
        }
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor"
        );
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    test("refuses to recreate deleted dirty editor files or parents", async function () {
      const sandbox = await realpath(
        await mkdtemp(join(tmpdir(), "vscode-acp-deleted-editor-"))
      );
      const parent = join(sandbox, "nested");
      const filePath = join(parent, "notes.txt");
      const context: WorkspaceFileAccessContext = {
        isTrusted: true,
        workspaceFolders: [
          { uri: vscode.Uri.file(sandbox) } as vscode.WorkspaceFolder,
        ],
      };
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const handler = provider as unknown as TestableCapabilityHandlers;
      let document: vscode.TextDocument | undefined;
      try {
        await mkdir(parent);
        await writeFile(filePath, "saved");
        if (!(await workspaceFileCapabilities(context)).writeTextFile) {
          this.skip();
        }
        const aliasRoot = join(sandbox, "alias");
        await fsPromises.symlink(sandbox, aliasRoot, "dir");
        Object.defineProperty(provider, "openWorkspaceFile", {
          value: (...args: Parameters<typeof openTrustedWorkspaceFile>) => {
            args[2] = context;
            return openTrustedWorkspaceFile(...args);
          },
        });
        document = await vscode.workspace.openTextDocument(
          join(sandbox, "alias", "nested", "notes.txt")
        );
        await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, 1, 0), "unsaved");
        await vscode.workspace.applyEdit(edit);
        await rm(parent, { recursive: true });
        await assert.rejects(
          () =>
            handler.handleWriteTextFile({
              sessionId: "session",
              path: filePath,
              content: "agent",
            }),
          /unsaved editor/
        );
        assert.strictEqual(document.getText(), "unsaved");
        assert.strictEqual(document.isDirty, true);
        await assert.rejects(() => readFile(filePath), { code: "ENOENT" });
        await assert.rejects(() => readFile(parent), { code: "ENOENT" });
      } finally {
        if (document) {
          await vscode.commands.executeCommand(
            "workbench.action.revertAndCloseActiveEditor"
          );
        }
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    test("rechecks editors dirtied during asynchronous identity resolution", async () => {
      const sandbox = await realpath(
        await mkdtemp(join(tmpdir(), "vscode-acp-editor-race-"))
      );
      const targetPath = join(sandbox, "target.txt");
      const otherPath = join(sandbox, "other.txt");
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const handler = provider as unknown as TestableCapabilityHandlers;
      const originalRealpath = fsPromises.realpath;
      const documents: vscode.TextDocument[] = [];
      let editDuringLookup = false;
      try {
        await writeFile(targetPath, "saved target");
        await writeFile(otherPath, "saved other");
        const target = await vscode.workspace.openTextDocument(targetPath);
        const other = await vscode.workspace.openTextDocument(otherPath);
        documents.push(target, other);
        await vscode.window.showTextDocument(target);
        const editOther = new vscode.WorkspaceEdit();
        editOther.replace(
          other.uri,
          new vscode.Range(0, 0, 1, 0),
          "unrelated user edit"
        );
        await vscode.workspace.applyEdit(editOther);
        Object.defineProperty(provider, "openWorkspaceFile", {
          value: async () => ({
            requestUri: target.uri,
            canonicalPath: targetPath,
            canonicalRootPath: sandbox,
            fileHandle: await open(targetPath, "r+"),
            strategy: "descriptor" as const,
            byteLength: 12,
          }),
        });
        fsPromises.realpath = (async (...args: Parameters<typeof realpath>) => {
          if (args[0] === other.uri.fsPath && !editDuringLookup) {
            editDuringLookup = true;
            const editTarget = new vscode.WorkspaceEdit();
            editTarget.replace(
              target.uri,
              new vscode.Range(0, 0, 1, 0),
              "concurrent user edit"
            );
            await vscode.workspace.applyEdit(editTarget);
          }
          return originalRealpath(...args);
        }) as typeof realpath;
        await assert.rejects(
          () =>
            handler.handleWriteTextFile({
              sessionId: "session",
              path: targetPath,
              content: "agent",
            }),
          /unsaved editor/
        );
        assert.strictEqual(target.getText(), "concurrent user edit");
        assert.strictEqual(target.isDirty, true);
        assert.strictEqual(await readFile(targetPath, "utf8"), "saved target");
        await vscode.commands.executeCommand("undo");
        assert.strictEqual(target.getText(), "saved target");
        await vscode.commands.executeCommand("redo");
        assert.strictEqual(target.getText(), "concurrent user edit");
      } finally {
        fsPromises.realpath = originalRealpath;
        for (const document of documents) {
          await vscode.window.showTextDocument(document);
          await vscode.commands.executeCommand(
            "workbench.action.revertAndCloseActiveEditor"
          );
        }
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    for (const scenario of [
      "renamed inode",
      "unavailable direct path",
    ] as const) {
      test(`preserves a dirty editor with ${scenario}`, async () => {
        const sandbox = await realpath(
          await mkdtemp(join(tmpdir(), "vscode-acp-editor-identity-"))
        );
        const filePath = join(sandbox, "notes.txt");
        const provider = new ChatViewProvider(
          mockExtensionUri,
          acpClient as unknown as ACPClient,
          memento as unknown as vscode.Memento
        );
        const handler = provider as unknown as TestableCapabilityHandlers;
        const originalRealpath = fsPromises.realpath;
        let document: vscode.TextDocument | undefined;
        let fileHandle: FileHandle | undefined;
        try {
          await writeFile(filePath, "saved");
          fileHandle = await open(filePath, "r+");
          const documentPath =
            scenario === "renamed inode"
              ? join(sandbox, "renamed.txt")
              : filePath;
          if (scenario === "renamed inode") {
            await fsPromises.rename(filePath, documentPath);
          }
          Object.defineProperty(provider, "openWorkspaceFile", {
            value: async () => ({
              requestUri: vscode.Uri.file(filePath),
              canonicalPath: filePath,
              canonicalRootPath: sandbox,
              fileHandle,
              strategy: "descriptor" as const,
              byteLength: 5,
            }),
          });
          document = await vscode.workspace.openTextDocument(documentPath);
          await vscode.window.showTextDocument(document);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, 1, 0), "unsaved");
          await vscode.workspace.applyEdit(edit);
          if (scenario === "unavailable direct path") {
            fsPromises.realpath = (async (
              ...args: Parameters<typeof realpath>
            ) => {
              if (args[0] === document?.uri.fsPath) {
                throw Object.assign(new Error("private path lookup failed"), {
                  code: "EACCES",
                });
              }
              return originalRealpath(...args);
            }) as typeof realpath;
          }
          await assert.rejects(
            () =>
              handler.handleWriteTextFile({
                sessionId: "session",
                path: filePath,
                content: "agent",
              }),
            /unsaved editor/
          );
          assert.strictEqual(await readFile(documentPath, "utf8"), "saved");
          assert.strictEqual(document.getText(), "unsaved");
          assert.strictEqual(document.isDirty, true);
          await vscode.commands.executeCommand("undo");
          assert.strictEqual(document.getText(), "saved");
          await vscode.commands.executeCommand("redo");
          assert.strictEqual(document.getText(), "unsaved");
        } finally {
          fsPromises.realpath = originalRealpath;
          await fileHandle?.close();
          if (document) {
            await vscode.commands.executeCommand(
              "workbench.action.revertAndCloseActiveEditor"
            );
          }
          await rm(sandbox, { recursive: true, force: true });
        }
      });
    }

    test("enforces containment through the chat read handler", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const testProvider = provider as unknown as TestableCapabilityHandlers;
      const sandbox = await realpath(
        await mkdtemp(join(tmpdir(), "vscode-acp-chat-boundary-"))
      );
      const workspaceRoot = join(sandbox, "workspace");
      const outsideRoot = join(sandbox, "outside");
      const allowedPath = join(workspaceRoot, "allowed.txt");
      const deniedPath = join(outsideRoot, "secret.txt");
      const context: WorkspaceFileAccessContext = {
        isTrusted: true,
        workspaceFolders: [
          { uri: vscode.Uri.file(workspaceRoot) } as vscode.WorkspaceFolder,
        ],
      };

      try {
        await mkdir(workspaceRoot);
        await mkdir(outsideRoot);
        await writeFile(allowedPath, "allowed");
        await writeFile(deniedPath, "secret");
        await workspaceFileCapabilities(context);
        Object.defineProperty(provider, "openWorkspaceFile", {
          value: (requestPath: string, operation: "read" | "write") =>
            openTrustedWorkspaceFile(requestPath, operation, context),
        });

        assert.deepStrictEqual(
          await testProvider.handleReadTextFile({
            sessionId: "session",
            path: allowedPath,
          }),
          { content: "allowed" }
        );
        await assert.rejects(
          () =>
            testProvider.handleReadTextFile({
              sessionId: "session",
              path: deniedPath,
            }),
          (error: unknown) =>
            error instanceof Error &&
            error.message ===
              "ACP file access is restricted to trusted workspace files."
        );
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    test("truncates terminal output at a UTF-8 character boundary", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const testProvider = provider as unknown as TestableCapabilityHandlers;
      const terminal = {
        id: "terminal",
        sessionId: "session",
        generation: 0,
        proc: null,
        closing: false,
        output: "",
        outputByteLimit: 3,
        truncated: false,
        exitCode: null,
        signal: null,
        exitPromise: Promise.resolve(),
        exitResolve: () => undefined,
      };
      testProvider.terminals.set(terminal.id, terminal);

      testProvider.appendTerminalOutput(terminal, "a€b");
      const response = await testProvider.handleTerminalOutput({
        sessionId: "session",
        terminalId: terminal.id,
      });

      assert.deepStrictEqual(response, {
        output: "b",
        truncated: true,
        exitStatus: null,
      });
      assert.ok(Buffer.byteLength(response.output, "utf8") <= 3);
      await assert.rejects(
        () =>
          testProvider.handleTerminalOutput({
            sessionId: "other-session",
            terminalId: terminal.id,
          }),
        /Terminal not found/
      );
    });

    test("rejects terminal working directories outside trusted workspace roots", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["--version"],
        cwd: tmpdir(),
      };
      const posted = await decideTerminalRequest(
        terminalProvider,
        fakeWebview,
        request
      );
      assert.strictEqual(posted.executable, false);
      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
          }),
        /requires an approved permission request/
      );
    });

    test("never resolves a bare terminal command from the workspace", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const command = `workspace-hijack-${process.pid}${
        process.platform === "win32" ? ".exe" : ""
      }`;
      const planted = join(workspaceRoot(), command);
      const originalPath = process.env.PATH;

      try {
        await copyFile(process.execPath, planted);
        await chmod(planted, 0o755);
        process.env.PATH = workspaceRoot();
        const request = { command, args: ["--version"], cwd: workspaceRoot() };
        const posted = await decideTerminalRequest(
          terminalProvider,
          fakeWebview,
          request
        );

        assert.strictEqual(posted.executable, false);
        await assert.rejects(
          () =>
            terminalProvider.handleCreateTerminal({
              sessionId: "test-session",
              ...request,
            }),
          /requires an approved permission request/
        );
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        await rm(planted, { force: true });
      }
    });

    test("runs an approved command literally and excludes inherited secrets", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const secretName = "VSCODE_ACP_TERMINAL_TEST_SECRET";
      const originalSecret = process.env[secretName];
      process.env[secretName] = "host-secret";
      const request = {
        command: NODE_EXECUTABLE,
        args: [
          "-e",
          `process.stdout.write(\`${"${process.argv[1]}"}|${"${process.env.VSCODE_ACP_TERMINAL_TEST_SECRET ?? 'missing'}"}\`)`,
          "literal && echo injected",
        ],
        cwd: workspaceRoot(),
      };
      let terminalId: string | undefined;

      try {
        await decideTerminalRequest(terminalProvider, fakeWebview, request);
        ({ terminalId } = await terminalProvider.handleCreateTerminal({
          sessionId: "test-session",
          ...request,
        }));
        await terminalProvider.handleWaitForTerminalExit({
          sessionId: "test-session",
          terminalId,
        });
        const { output } = await terminalProvider.handleTerminalOutput({
          sessionId: "test-session",
          terminalId,
        });

        assert.strictEqual(output, "literal && echo injected|missing");
      } finally {
        if (terminalId) {
          await terminalProvider.handleReleaseTerminal({
            sessionId: "test-session",
            terminalId,
          });
        }
        if (originalSecret === undefined) {
          delete process.env[secretName];
        } else {
          process.env[secretName] = originalSecret;
        }
      }
    });

    test("spends an allow_once grant on the first create only", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "process.stdout.write('once')"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);

      const { terminalId } = await terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });
      await terminalProvider.handleReleaseTerminal({
        sessionId: "test-session",
        terminalId,
      });

      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
          }),
        /requires an approved permission request/
      );
    });

    test("tracks identical allow_once approvals independently", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "process.stdout.write('twice')"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);
      await decideTerminalRequest(terminalProvider, fakeWebview, request);

      for (let approved = 0; approved < 2; approved++) {
        const { terminalId } = await terminalProvider.handleCreateTerminal({
          sessionId: "test-session",
          ...request,
        });
        await terminalProvider.handleReleaseTerminal({
          sessionId: "test-session",
          terminalId,
        });
      }
      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
          }),
        /requires an approved permission request/
      );
    });

    test("revokes a banked grant when the same launch is denied", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["--version"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);
      await decideTerminalRequest(
        terminalProvider,
        fakeWebview,
        request,
        "deny"
      );

      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
          }),
        /requires an approved permission request/
      );
    });

    test("revokes an existing grant even when denial preflight fails", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness & {
        prepareTerminalLaunch(params: unknown): Promise<unknown>;
        terminalPermissionGrants: Map<string, unknown>;
      };
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["--version"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);
      assert.strictEqual(terminalProvider.terminalPermissionGrants.size, 1);

      const prepare = terminalProvider.prepareTerminalLaunch.bind(provider);
      terminalProvider.prepareTerminalLaunch = async () => {
        throw new Error("temporarily unavailable");
      };
      try {
        await decideTerminalRequest(
          terminalProvider,
          fakeWebview,
          request,
          "deny"
        );
      } finally {
        terminalProvider.prepareTerminalLaunch = prepare;
      }
      assert.strictEqual(terminalProvider.terminalPermissionGrants.size, 0);
    });
    test("honours an allow_always grant for the rest of the session", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "process.stdout.write('always')"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(
        terminalProvider,
        fakeWebview,
        request,
        "always"
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        const { terminalId } = await terminalProvider.handleCreateTerminal({
          sessionId: "test-session",
          ...request,
        });
        await terminalProvider.handleReleaseTerminal({
          sessionId: "test-session",
          terminalId,
        });
      }

      // "Always" is scoped to the session: a session transition revokes it.
      terminalProvider.expirePermissionRequests();
      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
          }),
        /requires an approved permission request/
      );
    });

    test("caps distinct allow_always grants for the session", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness & {
        terminalPermissionGrants: Map<string, unknown>;
      };
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;

      for (let index = 0; index < 65; index++) {
        await decideTerminalRequest(
          terminalProvider,
          fakeWebview,
          {
            command: NODE_EXECUTABLE,
            args: ["-e", `process.stdout.write('${index}')`],
            cwd: workspaceRoot(),
          },
          "always"
        );
      }
      assert.strictEqual(terminalProvider.terminalPermissionGrants.size, 64);
      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            command: NODE_EXECUTABLE,
            args: ["-e", "process.stdout.write('0')"],
            cwd: workspaceRoot(),
          }),
        /requires an approved permission request/
      );
    });

    test("lets only one of two concurrent creates spend a single grant", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "process.stdout.write('race')"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);

      const results = await Promise.allSettled([
        terminalProvider.handleCreateTerminal({
          sessionId: "test-session",
          ...request,
        }),
        terminalProvider.handleCreateTerminal({
          sessionId: "test-session",
          ...request,
        }),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled"
      );
      assert.strictEqual(fulfilled.length, 1);
      for (const result of fulfilled) {
        await terminalProvider.handleReleaseTerminal({
          sessionId: "test-session",
          terminalId: result.value.terminalId,
        });
      }
    });

    test("denies a create whose command, args, or cwd differ from the approval", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "process.stdout.write('approved')"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);

      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
            args: ["-e", "process.stdout.write('swapped')"],
          }),
        /requires an approved permission request/
      );
      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "other-session",
            ...request,
          }),
        /requires an approved permission request/
      );
      await assert.rejects(
        () =>
          terminalProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
            padding: "unreviewed",
          } as never),
        /requires an approved permission request/
      );
    });

    test("releases a killed terminal and reuses its slot", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness &
        TestableCapabilityHandlers;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(
        terminalProvider,
        fakeWebview,
        request,
        "always"
      );

      const first = await terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });
      await terminalProvider.handleKillTerminalCommand({
        sessionId: "test-session",
        terminalId: first.terminalId,
      });
      await terminalProvider.handleReleaseTerminal({
        sessionId: "test-session",
        terminalId: first.terminalId,
      });
      assert.strictEqual(terminalProvider.terminals.size, 0);

      const second = await terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });
      await terminalProvider.handleReleaseTerminal({
        sessionId: "test-session",
        terminalId: second.terminalId,
      });
    });

    test("releases a terminal whose process already exited", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness &
        TestableCapabilityHandlers;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "process.stdout.write('done')"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);

      const { terminalId } = await terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });
      await terminalProvider.handleWaitForTerminalExit({
        sessionId: "test-session",
        terminalId,
      });

      await terminalProvider.handleReleaseTerminal({
        sessionId: "test-session",
        terminalId,
      });
      assert.strictEqual(terminalProvider.terminals.size, 0);
    });

    test("does not spawn when cleanup wins the launch preflight race", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness &
        TestableCapabilityHandlers & {
          prepareTerminalLaunch(params: unknown): Promise<unknown>;
        };
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);

      const prepare = terminalProvider.prepareTerminalLaunch.bind(provider);
      let calls = 0;
      let releaseOpen!: () => void;
      let markOpenStarted!: () => void;
      let markOpenPrepared!: () => void;
      const openGate = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      const openStarted = new Promise<void>((resolve) => {
        markOpenStarted = resolve;
      });
      const openPrepared = new Promise<void>((resolve) => {
        markOpenPrepared = resolve;
      });
      terminalProvider.prepareTerminalLaunch = async (params) => {
        calls++;
        if (calls === 2) {
          markOpenStarted();
          await openGate;
        }
        const launch = await prepare(params);
        if (calls === 2) {
          markOpenPrepared();
        }
        return launch;
      };

      const create = terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });
      await openStarted;
      const tracked = Array.from(
        terminalProvider.terminals.values()
      )[0] as unknown as {
        proc: unknown;
      };
      const cleanup = terminalProvider.disposeTerminals();
      releaseOpen();
      const { terminalId } = await create;
      await Promise.all([cleanup, openPrepared]);
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(tracked.proc, null);
      assert.strictEqual(terminalProvider.terminals.size, 0);
      assert.ok(terminalId.startsWith("term-"));
      terminalProvider.prepareTerminalLaunch = prepare;
    });

    test("disposes running terminals when the agent connection drops", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness &
        TestableCapabilityHandlers;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);
      const { terminalId } = await terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });

      acpClient.emitStateChange("disconnected");
      await terminalProvider.disposeTerminals();

      assert.strictEqual(terminalProvider.terminals.size, 0);
      await assert.rejects(
        () =>
          terminalProvider.handleTerminalOutput({
            sessionId: "test-session",
            terminalId,
          }),
        /Terminal not found/
      );
    });

    test("allows one waiter and settles it during release", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness &
        TestableCapabilityHandlers;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);
      const { terminalId } = await terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });
      const firstWait = terminalProvider.handleWaitForTerminalExit({
        sessionId: "test-session",
        terminalId,
      });

      await assert.rejects(
        () =>
          terminalProvider.handleWaitForTerminalExit({
            sessionId: "test-session",
            terminalId,
          }),
        /already pending/
      );
      await terminalProvider.handleReleaseTerminal({
        sessionId: "test-session",
        terminalId,
      });
      await firstWait;
    });

    test("terminates the complete child process tree before release", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness &
        TestableCapabilityHandlers;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const childProgram = "setInterval(() => {}, 1000)";
      const parentProgram = [
        "const { spawn } = require('child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: 'ignore' });`,
        "child.unref();",
        "process.stdout.write(String(child.pid));",
      ].join(" ");
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", parentProgram],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(terminalProvider, fakeWebview, request);
      const { terminalId } = await terminalProvider.handleCreateTerminal({
        sessionId: "test-session",
        ...request,
      });

      await terminalProvider.handleWaitForTerminalExit({
        sessionId: "test-session",
        terminalId,
      });
      const { output } = await terminalProvider.handleTerminalOutput({
        sessionId: "test-session",
        terminalId,
      });
      const childPid = Number.parseInt(output, 10);
      assert.ok(childPid > 0, "child process PID should be reported");

      await terminalProvider.handleReleaseTerminal({
        sessionId: "test-session",
        terminalId,
      });
      assert.throws(() => process.kill(childPid, 0));
    });

    test("bounds retained output when the agent sets no byte limit", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const testProvider = provider as unknown as TestableCapabilityHandlers;
      const terminal = {
        id: "unbounded",
        sessionId: "session",
        generation: 0,
        proc: null,
        closing: false,
        output: "",
        outputByteLimit: null as unknown as number,
        truncated: false,
        exitCode: null,
        signal: null,
        exitPromise: Promise.resolve(),
        exitResolve: () => undefined,
      };
      testProvider.terminals.set(terminal.id, terminal);

      for (let chunk = 0; chunk < 24; chunk++) {
        testProvider.appendTerminalOutput(terminal, "x".repeat(100_000));
      }

      assert.ok(Buffer.byteLength(terminal.output, "utf8") <= 1_048_576);
      assert.strictEqual(terminal.truncated, true);
    });

    test("atomically caps concurrent persistent terminal creates", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const terminalProvider = provider as unknown as TerminalTestHarness &
        TestableCapabilityHandlers;
      const fakeWebview = createFakeWebview();
      terminalProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: workspaceRoot(),
      };
      await decideTerminalRequest(
        terminalProvider,
        fakeWebview,
        request,
        "always"
      );

      try {
        const results = await Promise.allSettled(
          Array.from({ length: 16 }, () =>
            terminalProvider.handleCreateTerminal({
              sessionId: "test-session",
              ...request,
            })
          )
        );
        const fulfilled = results.filter(
          (result) => result.status === "fulfilled"
        );
        const rejected = results.filter(
          (result) => result.status === "rejected"
        );
        assert.strictEqual(fulfilled.length, 8);
        assert.strictEqual(rejected.length, 8);
        assert.strictEqual(terminalProvider.terminals.size, 8);
        assert.ok(
          rejected.every((result) =>
            String(result.reason).includes("Too many ACP terminals")
          )
        );
      } finally {
        await Promise.all(
          Array.from(terminalProvider.terminals.keys(), (terminalId) =>
            terminalProvider.handleReleaseTerminal({
              sessionId: "test-session",
              terminalId,
            })
          )
        );
      }
    });

    test("quotes Windows batch launches and refuses unsafe or oversized ones", () => {
      assert.strictEqual(
        buildWindowsBatchCommandLine("C:\\Program Files\\run.cmd", [
          "a b",
          "--flag=1",
        ]),
        '"C:\\Program Files\\run.cmd" "a b" "--flag=1"'
      );
      for (const hostile of ['"', "&", "|", "<", ">", "(", ")", "^", "%"]) {
        assert.throws(
          () => buildWindowsBatchCommandLine("run.cmd", [`x${hostile}y`]),
          /unsupported characters/,
          `expected ${hostile} to be rejected`
        );
      }
      assert.throws(
        () => buildWindowsBatchCommandLine("run.cmd", ["!DELAYED!"]),
        /unsupported characters/
      );
      // cmd.exe truncates past 8191 characters, which would run a command the
      // user never reviewed.
      assert.throws(
        () =>
          buildWindowsBatchCommandLine(
            "run.cmd",
            Array.from({ length: 8 }, () => "a".repeat(1024))
          ),
        /too long/
      );
    });
  });

  suite("Permission Requests", () => {
    test("should cancel immediately when no webview is attached", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );

      const response = await (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
    });

    test("should cancel immediately when no options are provided", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const response = await (provider as any).handleRequestPermission(
        makePermissionRequest({ options: [] })
      );

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual(fakeWebview.messages.length, 0);
    });
    test("should cancel permission requests with unknown option kinds", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as {
        view: FakeWebview["view"];
        handleRequestPermission(
          params: RequestPermissionRequest
        ): Promise<unknown>;
      };
      testProvider.view = fakeWebview.view;
      // The protocol type excludes unknown kinds; cast after constructing the
      // hostile wire payload so the runtime boundary remains under test.
      const malformedRequest = {
        sessionId: "test-session",
        toolCall: { toolCallId: "tool-1" },
        options: [
          {
            optionId: "unexpected",
            name: "Allow everything",
            kind: "unknown",
          },
        ],
      } as unknown as RequestPermissionRequest;

      const response =
        await testProvider.handleRequestPermission(malformedRequest);

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual(fakeWebview.messages.length, 0);
    });

    test("bounds option count, duplicate kinds, and permission payload size", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness;
      testProvider.view = fakeWebview.view;
      const fiveOptions = [
        { optionId: "once", name: "Once", kind: "allow_once" as const },
        { optionId: "always", name: "Always", kind: "allow_always" as const },
        { optionId: "deny", name: "Deny", kind: "reject_once" as const },
        {
          optionId: "deny-always",
          name: "Always deny",
          kind: "reject_always" as const,
        },
        { optionId: "extra", name: "Extra", kind: "allow_once" as const },
      ];
      assert.deepStrictEqual(
        await testProvider.handleRequestPermission(
          makePermissionRequest({ options: fiveOptions })
        ),
        { outcome: { outcome: "cancelled" } }
      );
      assert.deepStrictEqual(
        await testProvider.handleRequestPermission(
          makePermissionRequest({
            options: [
              { optionId: "one", name: "One", kind: "allow_once" },
              { optionId: "two", name: "Two", kind: "allow_once" },
            ],
          })
        ),
        { outcome: { outcome: "cancelled" } }
      );
      assert.deepStrictEqual(
        await testProvider.handleRequestPermission(
          makePermissionRequest({
            toolCall: {
              toolCallId: "oversized",
              rawInput: { value: "x".repeat(4097) },
            },
          })
        ),
        { outcome: { outcome: "cancelled" } }
      );
      assert.strictEqual(fakeWebview.messages.length, 0);
    });

    test("does not grant terminal input containing invisible Unicode controls", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness;
      testProvider.view = fakeWebview.view;
      const request = {
        command: NODE_EXECUTABLE,
        args: ["safe\u200bhidden"],
        cwd: workspaceRoot(),
      };
      const posted = await decideTerminalRequest(
        testProvider,
        fakeWebview,
        request,
        "deny"
      );
      assert.strictEqual(posted.executable, false);
      await assert.rejects(
        () =>
          testProvider.handleCreateTerminal({
            sessionId: "test-session",
            ...request,
          }),
        /requires an approved permission request/
      );
    });

    test("should reject a permission request from a stale session", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;
      acpClient.currentSessionId = "new-session";

      const response = await (provider as any).handleRequestPermission(
        makePermissionRequest({ sessionId: "old-session" })
      );

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual(fakeWebview.messages.length, 0);
      assert.strictEqual((provider as any).permissionRequests.size, 0);
    });

    test("should cancel immediately when webview delivery fails", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview(false);
      (provider as any).view = fakeWebview.view;

      const response = await (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual(fakeWebview.messages.length, 1);
      assert.strictEqual((provider as any).permissionRequests.size, 0);
    });

    test("should time out even when webview delivery never settles", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const neverDelivered = new Promise<boolean>(() => {});
      const fakeWebview = createFakeWebview(neverDelivered);
      (provider as any).view = fakeWebview.view;
      (provider as any).permissionRequestTimeoutMs = 10;

      const response = await (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual(fakeWebview.messages.length, 2);
      assert.strictEqual(
        fakeWebview.messages[1].type,
        "permissionRequestExpired"
      );
      assert.strictEqual((provider as any).permissionRequests.size, 0);
    });

    test("should post a mapped permissionRequest message to the webview", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      assert.strictEqual(fakeWebview.messages.length, 1);
      const sent = fakeWebview.messages[0];
      assert.strictEqual(sent.type, "permissionRequest");
      assert.strictEqual(sent.title, "Agent requests permission");
      assert.deepStrictEqual(sent.options, [
        { id: "allow", kind: "allow_once" },
        { id: "deny", kind: "reject_once" },
      ]);
      assert.strictEqual(sent.executable, false);

      // A prompt posted to a collapsed sidebar is delivered but never seen, so
      // the view is revealed without taking focus away from the editor.
      assert.deepStrictEqual(fakeWebview.shownWith, [true]);

      (provider as any).handlePermissionResponse({
        requestId: sent.requestId,
        cancelled: true,
      });
      await promise;
    });
    test("offers only denial when permission details are redacted", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness;
      testProvider.view = fakeWebview.view;
      const decision = testProvider.handleRequestPermission(
        makePermissionRequest({
          toolCall: {
            toolCallId: "secret-input",
            rawInput: { action: "publish", authorization: "Bearer secret" },
          },
        })
      );
      const posted = fakeWebview.messages[0];
      assert.deepStrictEqual(posted.options, [
        { id: "deny", kind: "reject_once" },
      ]);
      testProvider.handlePermissionResponse({
        requestId: posted.requestId as string,
        optionId: "deny",
      });
      assert.deepStrictEqual(await decision, {
        outcome: { outcome: "selected", optionId: "deny" },
      });
    });

    test("shows the exact effective terminal launch before approval", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness;
      testProvider.view = fakeWebview.view;

      const posted = await decideTerminalRequest(
        testProvider,
        fakeWebview,
        { command: NODE_EXECUTABLE, args: ["--version"] },
        "deny"
      );
      const descriptor = posted.rawInput as {
        command: string;
        args: string[];
        cwd: string;
        env: Record<string, string>;
      };

      assert.strictEqual(posted.executable, true);
      assert.ok(isAbsolute(descriptor.command));
      assert.deepStrictEqual(descriptor.args, ["--version"]);
      assert.strictEqual(descriptor.cwd, await realpath(workspaceRoot()));
      assert.ok(typeof descriptor.env.PATH === "string");
    });

    test("cancels permission requests once the pending queue is saturated", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness;
      testProvider.view = fakeWebview.view;

      const pending = Array.from({ length: 16 }, () =>
        testProvider.handleRequestPermission(makePermissionRequest())
      );
      const overflow = await testProvider.handleRequestPermission(
        makePermissionRequest()
      );

      assert.deepStrictEqual(overflow, { outcome: { outcome: "cancelled" } });
      assert.strictEqual(fakeWebview.messages.length, 16);

      testProvider.expirePermissionRequests();
      await Promise.all(pending);
    });
    test("reserves pending slots before asynchronous terminal preflight", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness & {
        prepareTerminalLaunch(params: unknown): Promise<unknown>;
        permissionRequests: Map<string, unknown>;
      };
      testProvider.view = fakeWebview.view;
      let releasePreflight!: () => void;
      const preflight = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      const prepare = testProvider.prepareTerminalLaunch.bind(provider);
      testProvider.prepareTerminalLaunch = async () => {
        await preflight;
        throw new Error("cancelled preflight");
      };

      const request = makePermissionRequest({
        toolCall: {
          toolCallId: "blocked-terminal",
          rawInput: { command: NODE_EXECUTABLE, args: ["--version"] },
        },
      });
      const pending = Array.from({ length: 16 }, () =>
        testProvider.handleRequestPermission(request)
      );
      const overflow = await testProvider.handleRequestPermission(request);
      assert.deepStrictEqual(overflow, { outcome: { outcome: "cancelled" } });
      assert.strictEqual(testProvider.permissionRequests.size, 16);

      testProvider.expirePermissionRequests();
      releasePreflight();
      await Promise.all(pending);
      testProvider.prepareTerminalLaunch = prepare;
      assert.ok(
        fakeWebview.messages.every(
          (message) => message.type !== "permissionRequest"
        )
      );
    });

    test("cancels a permission that is answered after its turn ends", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness & {
        expireTurnPermissions(): void;
        terminalPermissionGrants: Map<string, unknown>;
      };
      testProvider.view = fakeWebview.view;
      const messageIndex = fakeWebview.messages.length;
      const permission = testProvider.handleRequestPermission(
        makePermissionRequest({
          toolCall: {
            toolCallId: "late-terminal",
            rawInput: { command: NODE_EXECUTABLE, args: ["--version"] },
          },
        })
      );
      const { requestId } = await waitForPermissionRequest(
        fakeWebview,
        messageIndex,
        permission
      );
      testProvider.expireTurnPermissions();
      testProvider.handlePermissionResponse({ requestId, optionId: "allow" });

      assert.deepStrictEqual(await permission, {
        outcome: { outcome: "cancelled" },
      });
      assert.strictEqual(testProvider.terminalPermissionGrants.size, 0);
    });

    test("creates a one-use terminal grant only after an allow decision", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness & {
        terminalPermissionGrants: Map<
          string,
          { descriptorKey: string; persistent: boolean; uses: number }
        >;
      };
      testProvider.view = fakeWebview.view;
      await decideTerminalRequest(testProvider, fakeWebview, {
        command: NODE_EXECUTABLE,
        args: ["--version"],
        cwd: null,
      });

      assert.strictEqual(testProvider.terminalPermissionGrants.size, 1);
      testProvider.expirePermissionRequests();
      assert.strictEqual(testProvider.terminalPermissionGrants.size, 0);

      const padded = {
        padding: "unreviewed",
        command: NODE_EXECUTABLE,
        args: ["--version"],
        cwd: null,
      } as unknown as TerminalCreateRequest;
      await decideTerminalRequest(testProvider, fakeWebview, padded);
      assert.strictEqual(testProvider.terminalPermissionGrants.size, 0);
    });

    test("cancels terminal approval when its session is replaced", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const testProvider = provider as unknown as TerminalTestHarness & {
        terminalPermissionGrants: Map<string, unknown>;
      };
      testProvider.view = fakeWebview.view;
      const messageIndex = fakeWebview.messages.length;
      const permission = testProvider.handleRequestPermission(
        makePermissionRequest({
          toolCall: {
            toolCallId: "terminal-tool",
            rawInput: {
              command: NODE_EXECUTABLE,
              args: ["--version"],
              cwd: null,
              env: [],
            },
          },
        })
      );
      const { requestId } = await waitForPermissionRequest(
        fakeWebview,
        messageIndex,
        permission
      );
      acpClient.currentSessionId = "replacement-session";
      testProvider.handlePermissionResponse({ requestId, optionId: "allow" });

      assert.deepStrictEqual(await permission, {
        outcome: { outcome: "cancelled" },
      });
      assert.strictEqual(testProvider.terminalPermissionGrants.size, 0);
      acpClient.currentSessionId = "test-session";
    });

    test("should resolve with the selected option when the webview responds", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );
      const requestId = fakeWebview.messages[0].requestId;

      (provider as any).handlePermissionResponse({
        requestId,
        optionId: "allow",
      });

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "selected", optionId: "allow" },
      });
    });

    test("should resolve with cancelled when the user cancels", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );
      const requestId = fakeWebview.messages[0].requestId;

      (provider as any).handlePermissionResponse({
        requestId,
        cancelled: true,
      });

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "cancelled" },
      });
    });

    test("should resolve with cancelled on a malformed response", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );
      const requestId = fakeWebview.messages[0].requestId;

      // Neither `cancelled` nor `optionId` set: must never hang or auto-approve.
      (provider as any).handlePermissionResponse({ requestId });

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "cancelled" },
      });
    });

    test("should resolve with cancelled for an option that was not offered", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );
      const requestId = fakeWebview.messages[0].requestId;

      (provider as any).handlePermissionResponse({
        requestId,
        optionId: "not-offered",
      });

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "cancelled" },
      });
    });

    test("should ignore a response for an unknown or already-settled requestId", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const messageCount = fakeWebview.messages.length;
      (provider as any).handlePermissionResponse({
        requestId: "does-not-exist",
        optionId: "allow",
      });

      assert.strictEqual((provider as any).permissionRequests.size, 0);
      assert.strictEqual(fakeWebview.messages.length, messageCount);
    });

    test("should track concurrent requests independently", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const p1 = (provider as any).handleRequestPermission(
        makePermissionRequest({ toolCall: { toolCallId: "tc-1" } })
      );
      const p2 = (provider as any).handleRequestPermission(
        makePermissionRequest({ toolCall: { toolCallId: "tc-2" } })
      );

      assert.strictEqual(fakeWebview.messages.length, 2);
      const id1 = fakeWebview.messages[0].requestId as string;
      const id2 = fakeWebview.messages[1].requestId as string;
      assert.notStrictEqual(id1, id2);

      // Resolve the second request first; the first must remain unaffected.
      (provider as any).handlePermissionResponse({
        requestId: id2,
        optionId: "allow",
      });
      (provider as any).handlePermissionResponse({
        requestId: id1,
        cancelled: true,
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      assert.deepStrictEqual(r1, { outcome: { outcome: "cancelled" } });
      assert.deepStrictEqual(r2, {
        outcome: { outcome: "selected", optionId: "allow" },
      });
    });

    test("should time out, resolve cancelled, and notify the webview", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;
      (provider as any).permissionRequestTimeoutMs = 20;

      const response = await (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      const expired = fakeWebview.messages.find(
        (m) => m.type === "permissionRequestExpired"
      );
      assert.ok(expired, "expected a permissionRequestExpired notification");
    });

    test("should ignore a late response that arrives after timeout", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;
      (provider as any).permissionRequestTimeoutMs = 10;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );
      const requestId = fakeWebview.messages[0].requestId;
      const response = await promise;
      const messageCount = fakeWebview.messages.length;

      (provider as any).handlePermissionResponse({
        requestId,
        optionId: "allow",
      });

      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual((provider as any).permissionRequests.size, 0);
      assert.strictEqual(fakeWebview.messages.length, messageCount);
    });

    test("dispose() should resolve pending requests as cancelled, never rejected", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      provider.dispose();

      const response = await promise;
      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
      assert.strictEqual((provider as any).permissionRequests.size, 0);
      const expired = fakeWebview.messages.find(
        (m) => m.type === "permissionRequestExpired"
      );
      assert.ok(expired, "expected a permissionRequestExpired notification");
    });

    test("changing agents should cancel all pending permission requests", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      (provider as any).handleAgentChange("opencode");

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "cancelled" },
      });
      assert.strictEqual((provider as any).permissionRequests.size, 0);
      assert.ok(
        fakeWebview.messages.some(
          (message) => message.type === "permissionRequestExpired"
        )
      );
    });

    test("starting a new chat should cancel all pending permission requests", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      await (provider as any).handleNewChat();

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "cancelled" },
      });
      assert.strictEqual((provider as any).permissionRequests.size, 0);
      assert.ok(
        fakeWebview.messages.some(
          (message) => message.type === "permissionRequestExpired"
        )
      );
    });

    test("clearing chat should cancel all pending permission requests", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      (provider as any).handleClearChat();

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "cancelled" },
      });
      assert.strictEqual((provider as any).permissionRequests.size, 0);
      assert.ok(
        fakeWebview.messages.some(
          (message) => message.type === "permissionRequestExpired"
        )
      );
    });

    test("disconnecting should cancel all pending permission requests", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        memento as any
      );
      const fakeWebview = createFakeWebview();
      (provider as any).view = fakeWebview.view;

      const promise = (provider as any).handleRequestPermission(
        makePermissionRequest()
      );

      acpClient.emitStateChange("disconnected");

      assert.deepStrictEqual(await promise, {
        outcome: { outcome: "cancelled" },
      });

      assert.strictEqual((provider as any).permissionRequests.size, 0);
      assert.ok(
        fakeWebview.messages.some(
          (message) => message.type === "permissionRequestExpired"
        )
      );
    });
  });
  suite("Protocol metadata", () => {
    for (const stopReason of [
      "end_turn",
      "max_tokens",
      "max_turn_requests",
      "refusal",
      "cancelled",
    ]) {
      test(`forwards a zero-text ${stopReason} completion`, async () => {
        class StopReasonClient extends TestACPClient {
          isConnected(): boolean {
            return true;
          }

          async sendMessage(): Promise<{ stopReason: string }> {
            return { stopReason };
          }
        }

        const provider = new ChatViewProvider(
          mockExtensionUri,
          new StopReasonClient() as unknown as ACPClient,
          memento as unknown as vscode.Memento
        );
        const messages: Array<Record<string, unknown>> = [];
        Object.defineProperty(provider, "postMessage", {
          value: (message: Record<string, unknown>) => messages.push(message),
        });
        const internals = provider as unknown as {
          hasSession: boolean;
          handleUserMessage(text: string): Promise<void>;
        };
        internals.hasSession = true;

        await internals.handleUserMessage("Continue");

        assert.deepStrictEqual(messages.at(-1), {
          type: "streamEnd",
          stopReason,
        });
        assert.ok(!messages.some((message) => message.type === "error"));
      });
    }

    test("suppresses a stale stop reason if the connection changes during session save", async () => {
      let markSaving!: () => void;
      let finishSaving!: () => void;
      const saving = new Promise<void>((resolve) => {
        markSaving = resolve;
      });
      const saved = new Promise<void>((resolve) => {
        finishSaving = resolve;
      });
      class DelayedHistory extends TestMemento {
        async update(key: string, value: unknown): Promise<void> {
          if (key === "vscode-acp.sessionHistory") {
            markSaving();
            await saved;
          }
          await super.update(key, value);
        }
      }
      class RefusingClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }
        async sendMessage(): Promise<{ stopReason: string }> {
          return { stopReason: "refusal" };
        }
      }
      const client = new RefusingClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento,
        new DelayedHistory() as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const internals = provider as unknown as {
        hasSession: boolean;
        view: FakeWebview["view"];
        handleUserMessage(text: string): Promise<void>;
      };
      internals.hasSession = true;
      internals.view = fakeWebview.view;
      const prompt = internals.handleUserMessage("Pending history write");
      try {
        await saving;
        assert.ok(
          !fakeWebview.messages.some((message) => message.type === "streamEnd")
        );
        client.emitStateChange("disconnected");
        finishSaving();
        await prompt;
        assert.deepStrictEqual(fakeWebview.messages.at(-1), {
          type: "streamEnd",
          stopReason: "cancelled",
          suppressStopReason: true,
        });
      } finally {
        finishSaving();
        await prompt;
        provider.dispose();
      }
    });

    test("publishes identity only while its initialized connection is active", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      acpClient.agentInfo = {
        name: "metadata-agent",
        title: "Metadata Agent",
        version: "1.4.0",
      };

      acpClient.emitStateChange("connected");
      acpClient.emitStateChange("error");

      assert.deepStrictEqual(messages[0], {
        type: "connectionState",
        state: "connected",
        agentInfo: {
          name: "metadata-agent",
          title: "Metadata Agent",
          version: "1.4.0",
        },
      });
      assert.deepStrictEqual(messages.at(-1), {
        type: "connectionState",
        state: "error",
        agentInfo: null,
      });
    });

    test("opens only canonical tool locations inside the trusted workspace", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const fakeWebview = createFakeWebview();
      const internals = provider as unknown as {
        view: FakeWebview["view"];
        handleOpenToolLocation(path: unknown, line: unknown): Promise<void>;
      };
      internals.view = fakeWebview.view;
      const handleOpenToolLocation = internals.handleOpenToolLocation;
      const projectFile = join(workspaceRoot(), "README.md");
      const outsideDirectory = await mkdtemp(join(tmpdir(), "acp-location-"));
      const outsideFile = join(outsideDirectory, "outside.ts");
      const linksDirectory = await mkdtemp(join(workspaceRoot(), "locations-"));
      await writeFile(outsideFile, "outside\n");

      try {
        await symlink(
          workspaceRoot(),
          join(linksDirectory, "inside"),
          "junction"
        );
        await symlink(
          outsideDirectory,
          join(linksDirectory, "outside"),
          "junction"
        );
        await handleOpenToolLocation.call(provider, projectFile, 5);
        assert.strictEqual(
          await realpath(vscode.window.activeTextEditor!.document.uri.fsPath),
          await realpath(projectFile)
        );
        assert.strictEqual(
          vscode.window.activeTextEditor?.selection.active.line,
          4
        );
        await handleOpenToolLocation.call(
          provider,
          join(linksDirectory, "inside", "README.md"),
          Number.MAX_SAFE_INTEGER
        );
        assert.strictEqual(
          await realpath(vscode.window.activeTextEditor!.document.uri.fsPath),
          await realpath(projectFile)
        );
        assert.strictEqual(
          vscode.window.activeTextEditor?.selection.active.line,
          vscode.window.activeTextEditor!.document.lineCount - 1
        );
        const activeDocument =
          vscode.window.activeTextEditor?.document.uri.fsPath;

        for (const rejectedPath of [
          outsideFile,
          join(linksDirectory, "outside", "outside.ts"),
          join(workspaceRoot(), "missing-location.ts"),
          vscode.Uri.file(projectFile).toString(),
          "relative.ts",
          `${projectFile}\u0000`,
        ]) {
          fakeWebview.messages.length = 0;
          await handleOpenToolLocation.call(provider, rejectedPath, 1);
          assert.strictEqual(
            vscode.window.activeTextEditor?.document.uri.fsPath,
            activeDocument
          );
          assert.strictEqual(
            fakeWebview.messages[0]?.type,
            "toolLocationError"
          );
        }
      } finally {
        provider.dispose();
        await rm(linksDirectory, { recursive: true, force: true });
        await rm(outsideDirectory, { recursive: true, force: true });
        await vscode.commands.executeCommand(
          "workbench.action.closeActiveEditor"
        );
      }
    });
  });

  suite("Attachment lifecycle", () => {
    let originalCreate: PropertyDescriptor;
    let originalPrepare: PropertyDescriptor;

    setup(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "createFileAttachment"
      );
      assert.ok(descriptor);
      originalCreate = descriptor;
      const prepareDescriptor = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "prepareFileAttachment"
      );
      assert.ok(prepareDescriptor);
      originalPrepare = prepareDescriptor;
      Object.defineProperty(attachmentHelpers, "prepareFileAttachment", {
        configurable: true,
        value: async (attachment: FileAttachment) => ({
          attachment,
          inlineBytes: 0,
        }),
      });
      Object.defineProperty(attachmentHelpers, "createFileAttachment", {
        configurable: true,
        value: async (uri: vscode.Uri, id: string) => ({
          id,
          uri: uri.toString(),
          name: decodeURIComponent(uri.path.split("/").at(-1) ?? ""),
        }),
      });
    });

    teardown(() => {
      Object.defineProperty(
        attachmentHelpers,
        "prepareFileAttachment",
        originalPrepare
      );
      Object.defineProperty(
        attachmentHelpers,
        "createFileAttachment",
        originalCreate
      );
    });
    test("does not transport stale attachment ids after chat reset", async () => {
      class CapturingClient extends TestACPClient {
        public sentAttachments: readonly unknown[] = [];

        isConnected(): boolean {
          return true;
        }

        async sendMessage(
          _text = "",
          attachments: readonly unknown[] = []
        ): Promise<{ stopReason: string }> {
          this.sentAttachments = attachments;
          return { stopReason: "end_turn" };
        }
      }

      const client = new CapturingClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const internals = provider as unknown as {
        pendingAttachments: Map<string, unknown>;
        handleClearChat(): void;
        handleUserMessage(
          text: string,
          attachmentIds?: string[]
        ): Promise<void>;
      };
      internals.pendingAttachments.set("att-stale", {
        id: "att-stale",
        uri: "file:///workspace/stale.ts",
        name: "stale.ts",
      });

      internals.handleClearChat();
      await internals.handleUserMessage("Continue", ["att-stale"]);

      assert.deepStrictEqual(client.sentAttachments, []);
    });

    test("sends one resource link per distinct attachment id", async () => {
      class CapturingClient extends TestACPClient {
        public sentAttachments: readonly unknown[] = [];

        isConnected(): boolean {
          return true;
        }

        async sendMessage(
          _text = "",
          attachments: readonly unknown[] = []
        ): Promise<{ stopReason: string }> {
          this.sentAttachments = attachments;
          return { stopReason: "end_turn" };
        }
      }

      const client = new CapturingClient();
      const provider = new ChatViewProvider(
        mockExtensionUri,
        client as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const internals = provider as unknown as {
        pendingAttachments: Map<string, unknown>;
        handleUserMessage(
          text: string,
          attachmentIds?: string[]
        ): Promise<void>;
      };
      internals.pendingAttachments.set("att-1", {
        id: "att-1",
        uri: "file:///workspace/a.ts",
        name: "a.ts",
      });

      await internals.handleUserMessage(
        "Review",
        Array.from({ length: 25 }, () => "att-1")
      );

      assert.strictEqual(client.sentAttachments.length, 1);
    });

    test("accepts bounded pasted images into the existing draft without echoing payload bytes", () => {
      class ImageClient extends TestACPClient {
        getPromptCapabilities(): PromptCapabilities {
          return { image: true };
        }

        isConnected(): boolean {
          return true;
        }
      }
      const provider = new ChatViewProvider(
        mockExtensionUri,
        new ImageClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const internals = provider as unknown as {
        pendingAttachments: Map<string, FileAttachment & { payload?: unknown }>;
        handleAttachContent(message: Record<string, unknown>): void;
      };

      internals.handleAttachContent({
        type: "attachContent",
        name: "pasted.png",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      });

      assert.strictEqual(internals.pendingAttachments.size, 1);
      assert.strictEqual(
        internals.pendingAttachments.values().next().value?.payload !==
          undefined,
        true
      );
      const delivered = messages.find(
        (message) => message.type === "filesAttached"
      ) as { attachments: Array<Record<string, unknown>> } | undefined;
      assert.ok(delivered);
      assert.strictEqual("payload" in delivered.attachments[0], false);
      assert.strictEqual(delivered.attachments[0].transport, "image");
    });

    test("rejects pasted image bytes when the agent lacks image support", () => {
      class LinkOnlyClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }
      }
      const provider = new ChatViewProvider(
        mockExtensionUri,
        new LinkOnlyClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const internals = provider as unknown as {
        pendingAttachments: Map<string, unknown>;
        handleAttachContent(message: Record<string, unknown>): void;
      };

      internals.handleAttachContent({
        type: "attachContent",
        name: "pasted.png",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      });

      assert.strictEqual(internals.pendingAttachments.size, 0);
      assert.ok(
        messages.some(
          (message) =>
            message.type === "attachmentError" &&
            String(message.text).includes("does not advertise image")
        )
      );
    });

    test("drops spoofed or non-local replay resource links", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const internals = provider as unknown as {
        isReplaying: boolean;
        replayMessages: Array<{ attachments: FileAttachment[] }>;
        handleSessionUpdate(notification: SessionNotification): void;
      };
      internals.isReplaying = true;

      const hostile = [
        { uri: "javascript:alert(1)", name: "innocent.ts" },
        { uri: "data:text/html,<script>x</script>", name: "report.pdf" },
        { uri: "https://evil.example/x", name: "note.md" },
        {
          uri: "file:///home/u/.ssh/id_rsa",
          name: "todo.md\nfile:///home/u/todo.md",
        },
        {
          uri: "file:///home/u/.ssh/id_rsa",
          name: "quarterly-report.pdf",
        },
        {
          uri: "file:///workspace/invisible.ts",
          name: "invisible\u2060.ts",
        },
      ];
      for (const content of hostile) {
        internals.handleSessionUpdate({
          sessionId: "test-session",
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: "user-1",
            content: { type: "resource_link", ...content },
          },
        } satisfies SessionNotification);
      }
      internals.handleSessionUpdate({
        sessionId: "test-session",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-1",
          content: {
            type: "resource_link",
            uri: "file:///workspace/real.ts",
            name: "real.ts",
          },
        },
      } satisfies SessionNotification);

      assert.deepStrictEqual(
        internals.replayMessages
          .flatMap((message) => message.attachments)
          .map(({ uri, name }) => ({ uri, name })),
        [{ uri: "file:///workspace/real.ts", name: "real.ts" }]
      );
    });

    test("replays bounded embedded resources and images without retaining prompt payloads", () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const internals = provider as unknown as {
        isReplaying: boolean;
        replayMessages: Array<{ attachments: Array<Record<string, unknown>> }>;
        handleSessionUpdate(notification: SessionNotification): void;
      };
      internals.isReplaying = true;

      internals.handleSessionUpdate({
        sessionId: "test-session",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-rich",
          content: {
            type: "resource",
            resource: {
              uri: "file:///workspace/current.ts",
              mimeType: "text/typescript",
              text: "const current = true;",
            },
          },
        },
      } satisfies SessionNotification);
      internals.handleSessionUpdate({
        sessionId: "test-session",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-rich",
          content: {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      } satisfies SessionNotification);

      assert.deepStrictEqual(
        internals.replayMessages[0].attachments.map((attachment) => ({
          name: attachment.name,
          transport: attachment.transport,
          hasPayload: "payload" in attachment,
        })),
        [
          { name: "current.ts", transport: "resource", hasPayload: false },
          {
            name: internals.replayMessages[0].attachments[1].name,
            transport: "image",
            hasPayload: false,
          },
        ]
      );
    });

    test("does not send a file prepared after the conversation generation changes", async () => {
      const original = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "prepareFileAttachment"
      );
      assert.ok(original);
      let finishPreparation!: (value: {
        attachment: FileAttachment;
        inlineBytes: number;
      }) => void;
      const prepared = new Promise<{
        attachment: FileAttachment;
        inlineBytes: number;
      }>((resolve) => {
        finishPreparation = resolve;
      });
      Object.defineProperty(attachmentHelpers, "prepareFileAttachment", {
        configurable: true,
        value: () => prepared,
      });

      class CapturingClient extends TestACPClient {
        public sends = 0;
        isConnected(): boolean {
          return true;
        }
        async sendMessage(): Promise<{ stopReason: string }> {
          this.sends += 1;
          return { stopReason: "end_turn" };
        }
      }

      try {
        const client = new CapturingClient();
        const provider = new ChatViewProvider(
          mockExtensionUri,
          client as unknown as ACPClient,
          memento as unknown as vscode.Memento
        );
        const internals = provider as unknown as {
          hasSession: boolean;
          conversationGeneration: number;
          pendingAttachments: Map<string, FileAttachment>;
          handleUserMessage(text: string, ids: string[]): Promise<void>;
        };
        internals.hasSession = true;
        const attachment = {
          id: "race",
          uri: "file:///workspace/race.ts",
          name: "race.ts",
        };
        internals.pendingAttachments.set(attachment.id, attachment);

        const sending = internals.handleUserMessage("Review", [attachment.id]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        internals.conversationGeneration += 1;
        finishPreparation({ attachment, inlineBytes: 0 });
        await sending;

        assert.strictEqual(client.sends, 0);
      } finally {
        Object.defineProperty(
          attachmentHelpers,
          "prepareFileAttachment",
          original
        );
      }
    });

    test("drops the attachment draft when the composer webview reloads", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      let receive: ((message: Record<string, unknown>) => void) | undefined;
      const view = {
        webview: {
          options: {},
          html: "",
          cspSource: "vscode-webview:",
          asWebviewUri: (uri: vscode.Uri) => uri,
          postMessage: async () => true,
          onDidReceiveMessage: (
            handler: (message: Record<string, unknown>) => void
          ) => {
            receive = handler;
            return { dispose: () => undefined };
          },
        },
        onDidDispose: () => ({ dispose: () => undefined }),
        show: () => undefined,
      };
      provider.resolveWebviewView(
        view as unknown as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext,
        {} as vscode.CancellationToken
      );
      assert.ok(receive);

      const internals = provider as unknown as {
        pendingAttachments: Map<string, unknown>;
      };
      internals.pendingAttachments.set("att-orphan", {
        id: "att-orphan",
        uri: "file:///workspace/orphan.ts",
        name: "orphan.ts",
      });

      receive({ type: "ready" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(internals.pendingAttachments.size, 0);
    });

    test("does not consume attachment drafts while a session is replaying", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const internals = provider as unknown as {
        isReplaying: boolean;
        pendingAttachments: Map<string, unknown>;
        handleUserMessage(
          text: string,
          attachmentIds?: string[]
        ): Promise<void>;
      };
      internals.isReplaying = true;
      internals.pendingAttachments.set("att-draft", {
        id: "att-draft",
        uri: "file:///workspace/draft.ts",
        name: "draft.ts",
      });

      await internals.handleUserMessage("", ["att-draft"]);

      assert.strictEqual(internals.pendingAttachments.size, 1);
      assert.deepStrictEqual(messages, [
        {
          type: "agentError",
          text: "Wait for the conversation to finish restoring before sending.",
        },
      ]);
    });

    test("keeps the picker lock through asynchronous file metadata work", async () => {
      const originalPicker = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "pickAttachmentUris"
      );
      const originalCreate = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "createFileAttachment"
      );
      assert.ok(originalPicker);
      assert.ok(originalCreate);

      let pickerCalls = 0;
      let finishMetadata!: (attachment: FileAttachment | null) => void;
      const metadata = new Promise<FileAttachment | null>((resolve) => {
        finishMetadata = resolve;
      });
      Object.defineProperty(attachmentHelpers, "pickAttachmentUris", {
        configurable: true,
        value: async () => {
          pickerCalls += 1;
          return [vscode.Uri.file("/workspace/file.ts")];
        },
      });
      Object.defineProperty(attachmentHelpers, "createFileAttachment", {
        configurable: true,
        value: () => metadata,
      });

      try {
        const provider = new ChatViewProvider(
          mockExtensionUri,
          acpClient as unknown as ACPClient,
          memento as unknown as vscode.Memento
        );
        const internals = provider as unknown as {
          handleRequestAttachFiles(currentCount: number): Promise<void>;
          pendingAttachments: Map<string, unknown>;
        };

        const firstRequest = internals.handleRequestAttachFiles(0);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await internals.handleRequestAttachFiles(0);
        assert.strictEqual(pickerCalls, 1);

        finishMetadata({
          id: "att-race",
          uri: "file:///workspace/file.ts",
          name: "file.ts",
        });
        await firstRequest;
        assert.strictEqual(internals.pendingAttachments.size, 1);
      } finally {
        Object.defineProperty(
          attachmentHelpers,
          "pickAttachmentUris",
          originalPicker
        );
        Object.defineProperty(
          attachmentHelpers,
          "createFileAttachment",
          originalCreate
        );
      }
    });

    test("discards picker results after a session generation change", async () => {
      const originalPicker = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "pickAttachmentUris"
      );
      const originalCreate = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "createFileAttachment"
      );
      assert.ok(originalPicker);
      assert.ok(originalCreate);

      let finishPicker!: (uris: vscode.Uri[]) => void;
      const picked = new Promise<vscode.Uri[]>((resolve) => {
        finishPicker = resolve;
      });
      let metadataCalls = 0;
      Object.defineProperty(attachmentHelpers, "pickAttachmentUris", {
        configurable: true,
        value: () => picked,
      });
      Object.defineProperty(attachmentHelpers, "createFileAttachment", {
        configurable: true,
        value: async () => {
          metadataCalls += 1;
          return {
            id: "att-stale-picker",
            uri: "file:///workspace/file.ts",
            name: "file.ts",
          };
        },
      });

      try {
        const provider = new ChatViewProvider(
          mockExtensionUri,
          acpClient as unknown as ACPClient,
          memento as unknown as vscode.Memento
        );
        const internals = provider as unknown as {
          conversationGeneration: number;
          handleRequestAttachFiles(currentCount: number): Promise<void>;
          pendingAttachments: Map<string, unknown>;
        };

        const request = internals.handleRequestAttachFiles(0);
        await new Promise<void>((resolve) => setImmediate(resolve));
        internals.conversationGeneration += 1;
        finishPicker([vscode.Uri.file("/workspace/file.ts")]);
        await request;

        assert.strictEqual(metadataCalls, 0);
        assert.strictEqual(internals.pendingAttachments.size, 0);
      } finally {
        Object.defineProperty(
          attachmentHelpers,
          "pickAttachmentUris",
          originalPicker
        );
        Object.defineProperty(
          attachmentHelpers,
          "createFileAttachment",
          originalCreate
        );
      }
    });

    test("restores attachment chips after a prompt fails", async () => {
      class FailingClient extends TestACPClient {
        isConnected(): boolean {
          return true;
        }

        async sendMessage(): Promise<{ stopReason: string }> {
          throw new Error("send failed");
        }
      }

      const provider = new ChatViewProvider(
        mockExtensionUri,
        new FailingClient() as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const messages: Array<Record<string, unknown>> = [];
      Object.defineProperty(provider, "postMessage", {
        value: (message: Record<string, unknown>) => messages.push(message),
      });
      const internals = provider as unknown as {
        pendingAttachments: Map<string, FileAttachment>;
        handleUserMessage(
          text: string,
          attachmentIds?: string[]
        ): Promise<void>;
      };
      const attachment: FileAttachment = {
        id: "att-retry",
        uri: "file:///workspace/retry.ts",
        name: "retry.ts",
      };
      internals.pendingAttachments.set(attachment.id, attachment);

      await internals.handleUserMessage("Review", [attachment.id]);

      assert.deepStrictEqual(
        internals.pendingAttachments.get(attachment.id),
        attachment
      );
      assert.deepStrictEqual(
        messages.find((message) => message.type === "filesAttached"),
        { type: "filesAttached", attachments: [attachment] }
      );
    });
  });
});
