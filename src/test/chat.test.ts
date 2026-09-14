import * as assert from "assert";
import * as vscode from "vscode";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ChatViewProvider } from "../views/chat";
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
  RequestPermissionRequest,
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
  setMode: (modeId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  getSessionMetadata: () => any;
  dispose: () => void;
}

interface TestManagedTerminal {
  id: string;
  proc: null;
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
  shownWith: (boolean | undefined)[];
}

function createFakeWebview(
  delivery: boolean | Promise<boolean> = true
): FakeWebview {
  const messages: Record<string, unknown>[] = [];
  const shownWith: (boolean | undefined)[] = [];
  return {
    view: {
      webview: {
        postMessage: async (message: Record<string, unknown>) => {
          messages.push(message);
          return delivery;
        },
      },
      show: (preserveFocus?: boolean) => {
        shownWith.push(preserveFocus);
      },
    },
    messages,
    shownWith,
  };
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
      { type: "sessionMetadata", ...metadata }
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
        cwd: process.cwd(),
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

  test("redacts MCP secrets from stderr, logs, and error messages", () => {
    const provider = new ChatViewProvider(
      mockExtensionUri,
      acpClient as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const secret = "session-secret-value";
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
      handleStderr.call(
        provider,
        'ProviderError:\ndata: {providerID: "session-'
      );
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
    const bufferedStderr = Reflect.get(provider, "stderrBuffer") as string;
    assert.ok(!visibleOutput.includes(secret));
    assert.ok(!logs.join("\n").includes(secret));
    assert.ok(!bufferedStderr.includes(secret));
    assert.match(visibleOutput, /\[redacted\]/);
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
      text: "Agent reported an error. See the Extension Host log for details.",
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
      assert.strictEqual(history?.[0].cwd, process.cwd());
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
        proc: null,
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
      assert.strictEqual(sent.title, "Write file");
      assert.deepStrictEqual(sent.options, [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ]);
      // A prompt posted to a collapsed sidebar is delivered but never seen, so
      // the view is revealed without taking focus away from the editor.
      assert.deepStrictEqual(fakeWebview.shownWith, [true]);

      (provider as any).handlePermissionResponse({
        requestId: sent.requestId,
        cancelled: true,
      });
      await promise;
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

  suite("Attachment lifecycle", () => {
    let originalCreate: PropertyDescriptor;

    setup(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        attachmentHelpers,
        "createFileAttachment"
      );
      assert.ok(descriptor);
      originalCreate = descriptor;
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
