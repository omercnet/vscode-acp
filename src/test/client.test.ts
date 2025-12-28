import * as assert from "assert";
import { ChildProcess } from "child_process";
import { ACPClient, type SpawnFunction } from "../acp/client";
import { getAgent } from "../acp/agents";
import { createMockProcess } from "./mocks/acp-server";

suite("ACPClient", () => {
  let client: ACPClient;

  setup(() => {
    client = new ACPClient();
  });

  teardown(() => {
    client.dispose();
  });

  suite("constructor", () => {
    test("should create client with default agent", () => {
      assert.strictEqual(client.getAgentId(), "opencode");
    });

    test("should create client with custom agent", () => {
      const claudeAgent = getAgent("claude-code");
      const customClient = new ACPClient(claudeAgent);
      assert.strictEqual(customClient.getAgentId(), "claude-code");
      customClient.dispose();
    });

    test("should create client with options object", () => {
      const claudeAgent = getAgent("claude-code");
      const customClient = new ACPClient({ agentConfig: claudeAgent });
      assert.strictEqual(customClient.getAgentId(), "claude-code");
      customClient.dispose();
    });
  });

  suite("state management", () => {
    test("should start in disconnected state", () => {
      assert.strictEqual(client.getState(), "disconnected");
      assert.strictEqual(client.isConnected(), false);
    });

    test("should notify on state change", () => {
      const states: string[] = [];
      client.setOnStateChange((state) => states.push(state));
      client.dispose();
      assert.deepStrictEqual(states, []);
    });
  });

  suite("setAgent", () => {
    test("should change agent config", () => {
      const claudeAgent = getAgent("claude-code");
      client.setAgent(claudeAgent!);
      assert.strictEqual(client.getAgentId(), "claude-code");
    });
  });

  suite("session metadata", () => {
    test("should return null when no session exists", () => {
      assert.strictEqual(client.getSessionMetadata(), null);
    });
  });

  suite("dispose", () => {
    test("should reset all state", () => {
      client.dispose();
      assert.strictEqual(client.getState(), "disconnected");
      assert.strictEqual(client.isConnected(), false);
      assert.strictEqual(client.getSessionMetadata(), null);
    });
  });
});

suite("ACPClient with Mock Server", () => {
  let client: ACPClient;
  let mockSpawn: SpawnFunction;

  setup(() => {
    mockSpawn = (
      _command: string,
      _args: string[],
      _options: unknown
    ): ChildProcess => {
      return createMockProcess() as unknown as ChildProcess;
    };

    client = new ACPClient({
      agentConfig: {
        id: "mock-agent",
        name: "Mock Agent",
        command: "mock",
        args: [],
      },
      spawn: mockSpawn,
      skipAvailabilityCheck: true,
    });
  });

  teardown(() => {
    client.dispose();
  });

  suite("connect", () => {
    test("should connect to mock server", async () => {
      const states: string[] = [];
      client.setOnStateChange((state) => states.push(state));

      const response = await client.connect();

      assert.strictEqual(client.isConnected(), true);
      assert.strictEqual(client.getState(), "connected");
      assert.ok(response);
      assert.deepStrictEqual(states, ["connecting", "connected"]);
    });

    test("should notify multiple state change listeners", async () => {
      const states1: string[] = [];
      const states2: string[] = [];

      client.setOnStateChange((state) => states1.push(state));
      client.setOnStateChange((state) => states2.push(state));

      await client.connect();

      assert.deepStrictEqual(states1, ["connecting", "connected"]);
      assert.deepStrictEqual(states2, ["connecting", "connected"]);
    });

    test("should allow unsubscribing from state changes", async () => {
      const states1: string[] = [];
      const states2: string[] = [];

      const unsubscribe1 = client.setOnStateChange((state) =>
        states1.push(state)
      );
      client.setOnStateChange((state) => states2.push(state));

      unsubscribe1();
      await client.connect();

      assert.deepStrictEqual(states1, []);
      assert.deepStrictEqual(states2, ["connecting", "connected"]);
    });

    test("should throw if already connected", async () => {
      await client.connect();

      await assert.rejects(async () => {
        await client.connect();
      }, /Already connected or connecting/);
    });
  });

  suite("newSession", () => {
    test("should create a new session", async () => {
      await client.connect();
      const response = await client.newSession("/test/dir");

      assert.ok(response.sessionId);
      assert.ok(response.sessionId.startsWith("mock-session-"));

      const metadata = client.getSessionMetadata();
      assert.ok(metadata);
      assert.ok(metadata.modes);
      assert.ok(metadata.models);
      assert.strictEqual(metadata.modes?.currentModeId, "code");
      assert.strictEqual(metadata.models?.currentModelId, "claude-3-sonnet");
    });

    test("should receive available commands update", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      await new Promise((resolve) => setTimeout(resolve, 10));

      const metadata = client.getSessionMetadata();
      assert.ok(metadata);
      assert.ok(metadata.commands);
      assert.strictEqual(metadata.commands?.length, 3);
      assert.strictEqual(metadata.commands?.[0].name, "web");
      assert.strictEqual(metadata.commands?.[0].description, "Search the web");
      assert.strictEqual(metadata.commands?.[0].input?.hint, "query");
      assert.strictEqual(metadata.commands?.[1].name, "test");
      assert.strictEqual(metadata.commands?.[2].name, "plan");
    });

    test("should throw if not connected", async () => {
      await assert.rejects(async () => {
        await client.newSession("/test/dir");
      }, /Not connected/);
    });
  });

  suite("sendMessage", () => {
    test("should send message and receive response", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      const updates: unknown[] = [];
      client.setOnSessionUpdate((update) => updates.push(update));

      const response = await client.sendMessage("Hello");

      assert.strictEqual(response.stopReason, "end_turn");
    });

    test("should notify multiple session update listeners", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      const updates1: unknown[] = [];
      const updates2: unknown[] = [];

      client.setOnSessionUpdate((update) => updates1.push(update));
      client.setOnSessionUpdate((update) => updates2.push(update));

      await client.sendMessage("Hello");

      assert.strictEqual(updates1.length, updates2.length);
    });

    test("should throw if no session", async () => {
      await client.connect();

      await assert.rejects(async () => {
        await client.sendMessage("Hello");
      }, /No active session/);
    });
  });

  suite("setMode", () => {
    test("should change mode", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      await client.setMode("architect");

      const metadata = client.getSessionMetadata();
      assert.strictEqual(metadata?.modes?.currentModeId, "architect");
    });

    test("should throw if no session", async () => {
      await client.connect();

      await assert.rejects(async () => {
        await client.setMode("architect");
      }, /No active session/);
    });
  });

  suite("setModel", () => {
    test("should change model", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      await client.setModel("claude-3-opus");

      const metadata = client.getSessionMetadata();
      assert.strictEqual(metadata?.models?.currentModelId, "claude-3-opus");
    });

    test("should throw if no session", async () => {
      await client.connect();

      await assert.rejects(async () => {
        await client.setModel("claude-3-opus");
      }, /No active session/);
    });
  });

  suite("cancel", () => {
    test("should not throw when cancelling", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      await client.cancel();
    });

    test("should not throw if no session", async () => {
      await client.cancel();
    });
  });

  suite("dispose", () => {
    test("should disconnect and clean up", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      client.dispose();

      assert.strictEqual(client.getState(), "disconnected");
      assert.strictEqual(client.isConnected(), false);
      assert.strictEqual(client.getSessionMetadata(), null);
    });
  });
});
