import * as assert from "assert";
import * as vscode from "vscode";
import { tmpdir } from "os";
import { join } from "path";
import { ChatViewProvider } from "../views/chat";
import type { ACPClient } from "../acp/client";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

interface MockMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

interface MockACPClient {
  setAgent: (config: any) => void;
  getAgentId: () => string;
  getCurrentSessionId: () => string | null;
  setOnStateChange: (callback: any) => () => void;
  setOnSessionUpdate: (callback: any) => () => void;
  setOnStderr: (callback: any) => () => void;
  setOnReadTextFile: (callback: any) => void;
  setOnWriteTextFile: (callback: any) => void;
  setOnCreateTerminal: (callback: any) => void;
  setOnTerminalOutput: (callback: any) => void;
  setOnWaitForTerminalExit: (callback: any) => void;
  setOnKillTerminalCommand: (callback: any) => void;
  setOnReleaseTerminal: (callback: any) => void;
  setOnRequestPermission: (callback: any) => void;
  isConnected: () => boolean;
  connect: () => Promise<void>;
  newSession: (dir: string) => Promise<void>;
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
  setOnSessionUpdate(): () => void {
    return () => {};
  }
  setOnStderr(): () => void {
    return () => {};
  }
  setOnReadTextFile(): void {}
  setOnWriteTextFile(): void {}
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
  async newSession(): Promise<void> {}

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
}

interface FakeWebview {
  view: {
    webview: {
      postMessage: (message: Record<string, unknown>) => Promise<boolean>;
    };
  };
  messages: Record<string, unknown>[];
}

function createFakeWebview(
  delivery: boolean | Promise<boolean> = true
): FakeWebview {
  const messages: Record<string, unknown>[] = [];
  return {
    view: {
      webview: {
        postMessage: async (message: Record<string, unknown>) => {
          messages.push(message);
          return delivery;
        },
      },
    },
    messages,
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
      isConnected(): boolean {
        return true;
      }

      async newSession(): Promise<void> {
        throw new Error("Replacement session failed");
      }

      getSessionMetadata() {
        return metadata;
      }
    }

    const provider = new ChatViewProvider(
      mockExtensionUri,
      new FailingReplacementClient() as unknown as ACPClient,
      memento as unknown as vscode.Memento
    );
    const messages: Array<Record<string, unknown>> = [];
    Object.defineProperty(provider, "postMessage", {
      value: (message: Record<string, unknown>) => messages.push(message),
    });
    const handleNewChat = Reflect.get(provider, "handleNewChat") as (
      this: ChatViewProvider
    ) => Promise<void>;

    await handleNewChat.call(provider);

    assert.deepStrictEqual(messages.at(-1), {
      type: "sessionMetadata",
      ...metadata,
    });
  });
  suite("Client capability handlers", () => {
    test("reads files using the protocol's 1-based line offset", async () => {
      const provider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as unknown as ACPClient,
        memento as unknown as vscode.Memento
      );
      const testProvider = provider as unknown as TestableCapabilityHandlers;
      const uri = vscode.Uri.file(
        join(tmpdir(), `vscode-acp-lines-${Date.now()}.txt`)
      );

      try {
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode("first\nsecond\nthird")
        );
        const result = await testProvider.handleReadTextFile({
          sessionId: "session",
          path: uri.fsPath,
          line: 2,
          limit: 1,
        });

        assert.deepStrictEqual(result, { content: "second" });
      } finally {
        await vscode.workspace.fs.delete(uri);
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
});
