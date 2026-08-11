import * as assert from "assert";
import * as vscode from "vscode";
import { ChatViewProvider, StoredSession } from "../views/chat";

interface MockMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  keys(): readonly string[];
}

interface MockACPClient {
  setAgent: (config: any) => void;
  getAgentId: () => string;
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
  isConnected: () => boolean;
  connect: () => Promise<void>;
  newSession: (dir: string) => Promise<void>;
  setMode: (modeId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  getSessionMetadata: () => any;
  dispose: () => void;
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
  setAgent(): void {}
  getAgentId(): string {
    return "test-agent";
  }
  setOnStateChange(): () => void {
    return () => {};
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
  isConnected(): boolean {
    return false;
  }
  async connect(): Promise<void> {}
  async newSession(): Promise<void> {}
  async setMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  getSessionMetadata(): any {
    return {
      modes: null,
      models: null,
      commands: null,
    };
  }
  dispose(): void {}
}

function createTestSession(
  id: string,
  timestamp: number,
  overrides?: Partial<StoredSession>
): StoredSession {
  return {
    sessionId: id,
    timestamp,
    cwd: "/test/workspace",
    lastMessage: `Test message for ${id}`,
    messageCount: 5,
    ...overrides,
  };
}

suite("ChatViewProvider Session Storage", () => {
  let globalState: TestMemento;
  let workspaceState: TestMemento;
  let acpClient: TestACPClient;
  let mockExtensionUri: vscode.Uri;
  let provider: ChatViewProvider;

  setup(() => {
    globalState = new TestMemento();
    workspaceState = new TestMemento();
    acpClient = new TestACPClient();
    mockExtensionUri = vscode.Uri.file("/mock/extension");
    provider = new ChatViewProvider(
      mockExtensionUri,
      acpClient as any,
      globalState as any,
      workspaceState as any
    );
  });

  teardown(() => {
    globalState.clear();
    workspaceState.clear();
  });

  suite("saveSession", () => {
    test("should create new session when none exists", async () => {
      const metadata = {
        timestamp: Date.now(),
        cwd: "/test/workspace",
        lastMessage: "Hello world",
        messageCount: 1,
      };

      await provider.saveSession("session-1", metadata);

      const sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].sessionId, "session-1");
      assert.strictEqual(sessions[0].cwd, "/test/workspace");
      assert.strictEqual(sessions[0].lastMessage, "Hello world");
      assert.strictEqual(sessions[0].messageCount, 1);
    });

    test("should update existing session with same ID", async () => {
      const initialMetadata = {
        timestamp: 1000,
        cwd: "/test/workspace",
        lastMessage: "First message",
        messageCount: 1,
      };

      await provider.saveSession("session-1", initialMetadata);

      const updatedMetadata = {
        timestamp: 2000,
        cwd: "/test/workspace",
        lastMessage: "Updated message",
        messageCount: 5,
      };

      await provider.saveSession("session-1", updatedMetadata);

      const sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].sessionId, "session-1");
      assert.strictEqual(sessions[0].lastMessage, "Updated message");
      assert.strictEqual(sessions[0].messageCount, 5);
      assert.strictEqual(sessions[0].timestamp, 2000);
    });

    test("should enforce max limit with LRU eviction", async () => {
      const MAX_SESSIONS = 50;

      for (let i = 0; i < MAX_SESSIONS; i++) {
        await provider.saveSession(`session-${i}`, {
          timestamp: i * 1000,
          cwd: "/test/workspace",
          lastMessage: `Message ${i}`,
          messageCount: i,
        });
      }

      let sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, MAX_SESSIONS);

      await provider.saveSession("session-new", {
        timestamp: 100000,
        cwd: "/test/workspace",
        lastMessage: "New message",
        messageCount: 1,
      });

      sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, MAX_SESSIONS);
      assert.strictEqual(sessions[0].sessionId, "session-new");

      const hasOldestSession = sessions.some(
        (s) => s.sessionId === "session-0"
      );
      assert.strictEqual(
        hasOldestSession,
        false,
        "Oldest session should be evicted"
      );
    });

    test("should sort sessions by timestamp (newest first)", async () => {
      await provider.saveSession("session-old", {
        timestamp: 1000,
        cwd: "/test/workspace",
        lastMessage: "Old",
        messageCount: 1,
      });

      await provider.saveSession("session-new", {
        timestamp: 3000,
        cwd: "/test/workspace",
        lastMessage: "New",
        messageCount: 1,
      });

      await provider.saveSession("session-middle", {
        timestamp: 2000,
        cwd: "/test/workspace",
        lastMessage: "Middle",
        messageCount: 1,
      });

      const sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 3);
      assert.strictEqual(sessions[0].sessionId, "session-new");
      assert.strictEqual(sessions[1].sessionId, "session-middle");
      assert.strictEqual(sessions[2].sessionId, "session-old");
    });
  });

  suite("loadSessionList", () => {
    test("should return empty array when no sessions exist", () => {
      const sessions = provider.loadSessionList();
      assert.deepStrictEqual(sessions, []);
    });

    test("should return sessions as stored in workspace state", async () => {
      const session1 = createTestSession("session-1", 1000);
      const session2 = createTestSession("session-2", 3000);
      const session3 = createTestSession("session-3", 2000);

      await workspaceState.update("vscode-acp.sessions", [
        session1,
        session2,
        session3,
      ]);

      const newProvider = new ChatViewProvider(
        mockExtensionUri,
        acpClient as any,
        globalState as any,
        workspaceState as any
      );

      const sessions = newProvider.loadSessionList();
      assert.strictEqual(sessions.length, 3);
    });

    test("should return all stored sessions", async () => {
      await provider.saveSession("session-1", {
        timestamp: 1000,
        cwd: "/workspace1",
        lastMessage: "Message 1",
        messageCount: 1,
      });

      await provider.saveSession("session-2", {
        timestamp: 2000,
        cwd: "/workspace2",
        lastMessage: "Message 2",
        messageCount: 2,
      });

      await provider.saveSession("session-3", {
        timestamp: 3000,
        cwd: "/workspace3",
        lastMessage: "Message 3",
        messageCount: 3,
      });

      const sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 3);

      const sessionIds = sessions.map((s) => s.sessionId);
      assert.ok(sessionIds.includes("session-1"));
      assert.ok(sessionIds.includes("session-2"));
      assert.ok(sessionIds.includes("session-3"));
    });
  });

  suite("deleteSession", () => {
    test("should remove session from storage", async () => {
      await provider.saveSession("session-1", {
        timestamp: 1000,
        cwd: "/test/workspace",
        lastMessage: "Message 1",
        messageCount: 1,
      });

      await provider.saveSession("session-2", {
        timestamp: 2000,
        cwd: "/test/workspace",
        lastMessage: "Message 2",
        messageCount: 2,
      });

      let sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 2);

      await provider.deleteSession("session-1");

      sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].sessionId, "session-2");
    });

    test("should not throw when deleting non-existent session", async () => {
      await provider.saveSession("session-1", {
        timestamp: 1000,
        cwd: "/test/workspace",
        lastMessage: "Message 1",
        messageCount: 1,
      });

      await provider.deleteSession("non-existent-session");

      const sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 1);
      assert.strictEqual(sessions[0].sessionId, "session-1");
    });

    test("should handle deleting from empty storage", async () => {
      await provider.deleteSession("any-session");

      const sessions = provider.loadSessionList();
      assert.strictEqual(sessions.length, 0);
    });
  });

  suite("getSession", () => {
    test("should return correct session by ID", async () => {
      await provider.saveSession("session-1", {
        timestamp: 1000,
        cwd: "/workspace1",
        lastMessage: "Message 1",
        messageCount: 1,
      });

      await provider.saveSession("session-2", {
        timestamp: 2000,
        cwd: "/workspace2",
        lastMessage: "Message 2",
        messageCount: 2,
      });

      const session = provider.getSession("session-1");
      assert.ok(session);
      assert.strictEqual(session.sessionId, "session-1");
      assert.strictEqual(session.cwd, "/workspace1");
      assert.strictEqual(session.lastMessage, "Message 1");
      assert.strictEqual(session.messageCount, 1);
    });

    test("should return undefined for missing session", () => {
      const session = provider.getSession("non-existent");
      assert.strictEqual(session, undefined);
    });

    test("should return undefined when storage is empty", () => {
      const session = provider.getSession("any-session");
      assert.strictEqual(session, undefined);
    });

    test("should return session with all metadata fields", async () => {
      const timestamp = Date.now();
      await provider.saveSession("session-full", {
        timestamp,
        cwd: "/full/workspace/path",
        lastMessage: "This is a complete message with all fields",
        messageCount: 42,
      });

      const session = provider.getSession("session-full");
      assert.ok(session);
      assert.strictEqual(session.sessionId, "session-full");
      assert.strictEqual(session.timestamp, timestamp);
      assert.strictEqual(session.cwd, "/full/workspace/path");
      assert.strictEqual(
        session.lastMessage,
        "This is a complete message with all fields"
      );
      assert.strictEqual(session.messageCount, 42);
    });
  });
});
