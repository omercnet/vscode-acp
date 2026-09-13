import * as assert from "assert";
import { ChildProcess } from "child_process";
import {
  ACPClient,
  describeACPError,
  formatACPError,
  type SpawnFunction,
} from "../acp/client";
import { getAgent } from "../acp/agents";
import {
  RequestError,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  createMockProcess,
  type DemoMode,
  type MockChildProcess,
} from "./mocks/acp-server";

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
      assert.strictEqual(client.getCurrentSessionId(), null);
    });
  });

  suite("dispose", () => {
    test("should reset all state", () => {
      client.dispose();
      assert.strictEqual(client.getState(), "disconnected");
      assert.strictEqual(client.isConnected(), false);
      assert.strictEqual(client.getCurrentSessionId(), null);
      assert.strictEqual(client.getSessionMetadata(), null);
    });
  });
});

suite("ACP error presentation", () => {
  const cases = [
    [-32700, "protocol", "Protocol error"],
    [-32600, "invalid-request", "Invalid request"],
    [-32601, "unsupported-operation", "Unsupported operation"],
    [-32602, "invalid-parameters", "Invalid parameters"],
    [-32603, "agent", "Agent error"],
    [-32000, "authentication-required", "Authentication required"],
    [-32002, "resource-not-found", "Resource not found"],
    [-32800, "cancelled", "Request cancelled"],
  ] as const;

  for (const [code, kind, summary] of cases) {
    test(`shows ${summary.toLowerCase()} with agent diagnostics`, () => {
      const error = new RequestError(code, "agent diagnostic");

      assert.deepStrictEqual(describeACPError(error), {
        kind,
        code,
        summary,
        diagnostic: "agent diagnostic",
      });
      assert.strictEqual(formatACPError(error), `${summary}: agent diagnostic`);
    });
  }

  test("keeps an unstructured error's own wording", () => {
    const error = new Error("Internal error (-32603)");

    assert.deepStrictEqual(describeACPError(error), {
      kind: "unknown",
      summary: "Error",
      diagnostic: "Internal error (-32603)",
    });
    assert.strictEqual(formatACPError(error), "Internal error (-32603)");
  });

  test("replaces internal session transition diagnostics with recovery guidance", () => {
    const errors = [
      "Already connected or connecting",
      "Session creation already in progress",
      "Session loading already in progress",
      "No active session",
    ];

    for (const message of errors) {
      assert.deepStrictEqual(describeACPError(new Error(message)), {
        kind: "session-transition",
        summary: "Session is still getting ready",
        diagnostic:
          "Session is still getting ready. Wait for setup to finish, then try again.",
      });
      assert.strictEqual(
        formatACPError(new Error(message)),
        "Session is still getting ready. Wait for setup to finish, then try again."
      );
    }
  });

  test("does not repeat the summary for the SDK's default message", () => {
    assert.strictEqual(
      formatACPError(RequestError.authRequired()),
      "Authentication required"
    );
    assert.strictEqual(
      formatACPError(RequestError.authRequired(undefined, "Sign in")),
      "Authentication required: Sign in"
    );
    assert.strictEqual(
      formatACPError(RequestError.resourceNotFound("file:///tmp/missing.ts")),
      "Resource not found: file:///tmp/missing.ts"
    );
  });
});

suite("ACPClient with Mock Server", () => {
  let client: ACPClient;
  let mockSpawn: SpawnFunction;
  let demoMode: DemoMode;
  let mockProcesses: MockChildProcess[];

  setup(() => {
    demoMode = "default";
    mockProcesses = [];
    mockSpawn = (
      _command: string,
      _args: string[],
      _options: unknown
    ): ChildProcess => {
      const process = createMockProcess(demoMode);
      mockProcesses.push(process);
      return process as unknown as ChildProcess;
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

    test("advertises only client capabilities backed by handlers", async () => {
      await client.connect();

      assert.deepStrictEqual(
        mockProcesses[0].server.getInitializeRequest()?.clientCapabilities,
        {}
      );
    });

    test("rejects an unsupported negotiated protocol version", async () => {
      demoMode = "invalid-version";

      await assert.rejects(
        () => client.connect(),
        /Unsupported ACP protocol version/
      );
      assert.strictEqual(client.getState(), "error");
      assert.strictEqual(mockProcesses[0].killed, true);
    });
  });

  suite("newSession", () => {
    test("should create a new session", async () => {
      await client.connect();
      const response = await client.newSession("/test/dir");

      assert.ok(response.sessionId);
      assert.ok(response.sessionId.startsWith("mock-session-"));
      assert.strictEqual(client.getCurrentSessionId(), response.sessionId);

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

    test("applies grouped config options streamed before the session response", async () => {
      demoMode = "deferred-config";
      await client.connect();
      await client.newSession("/test/dir");

      const models = client.getSessionMetadata()?.models;
      assert.deepStrictEqual(models?.availableModels, [
        { modelId: "claude-3-sonnet", name: "Claude 3 Sonnet" },
        { modelId: "claude-3-opus", name: "Claude 3 Opus" },
      ]);
      assert.strictEqual(models?.currentModelId, "claude-3-opus");
    });

    test("does not expose a model selector with an invalid current value", async () => {
      demoMode = "invalid-config";
      await client.connect();
      await client.newSession("/test/dir");

      assert.strictEqual(client.getSessionMetadata()?.models, null);
    });

    test("tracks current mode updates in session metadata", async () => {
      demoMode = "mode-update";
      await client.connect();
      await client.newSession("/test/dir");
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(
        client.getSessionMetadata()?.modes?.currentModeId,
        "architect"
      );
    });

    test("keeps pre-response metadata scoped to its session", async () => {
      demoMode = "session-isolation";
      await client.connect();
      await client.newSession("/test/dir");

      let staleReadCount = 0;
      client.setOnReadTextFile(async () => {
        staleReadCount++;
        return { content: "stale" };
      });
      const observedSessionIds: string[] = [];
      client.setOnSessionUpdate((notification) => {
        observedSessionIds.push(notification.sessionId);
      });

      await client.newSession("/test/dir");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const metadata = client.getSessionMetadata();
      assert.strictEqual(metadata?.models?.currentModelId, "session-2-model");
      assert.strictEqual(metadata?.commands?.[0]?.name, "session-2");
      assert.deepStrictEqual(observedSessionIds, []);
      assert.strictEqual(staleReadCount, 0);
    });

    test("cancels work in the replaced session", async () => {
      demoMode = "ansi";
      await client.connect();
      await client.newSession("/test/dir");

      const prompt = client.sendMessage("Hello");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.newSession("/test/dir");

      assert.strictEqual((await prompt).stopReason, "cancelled");
    });

    test("cancels permission requests arriving after replacement starts", async () => {
      demoMode = "late-permission";
      let permissionHandlerCalls = 0;
      client.setOnRequestPermission(async () => {
        permissionHandlerCalls++;
        return { outcome: { outcome: "selected", optionId: "once" } };
      });
      await client.connect();
      await client.newSession("/test/dir");

      await client.newSession("/test/dir");
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(permissionHandlerCalls, 0);
      assert.deepStrictEqual(
        mockProcesses[0].server.getPermissionOutcomes().at(-1),
        { outcome: "cancelled" }
      );
    });

    test("closes a replaced session when the agent advertises support", async () => {
      demoMode = "session-close";
      await client.connect();
      const firstSession = await client.newSession("/test/dir");

      const secondSession = await client.newSession("/test/dir");
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.notStrictEqual(secondSession.sessionId, firstSession.sessionId);
      assert.deepStrictEqual(mockProcesses[0].server.getClosedSessionIds(), [
        firstSession.sessionId,
      ]);
    });

    test("does not wait for an unresponsive session close", async () => {
      demoMode = "session-close-hangs";
      await client.connect();
      await client.newSession("/test/dir");

      const replacement = client.newSession("/test/dir").then(
        () => "resolved" as const,
        () => "rejected" as const
      );
      const result = await Promise.race([
        replacement,
        new Promise<"pending">((resolve) =>
          setImmediate(() => resolve("pending"))
        ),
      ]);

      assert.strictEqual(result, "resolved");
      assert.ok(client.getSessionMetadata());
    });

    test("restores the current session when its replacement fails", async () => {
      demoMode = "replacement-failure";
      await client.connect();
      await client.newSession("/test/dir");
      const previousMetadata = client.getSessionMetadata();

      await assert.rejects(
        () => client.newSession("/test/dir"),
        /Replacement session failed/
      );

      assert.deepStrictEqual(client.getSessionMetadata(), previousMetadata);
      assert.strictEqual(
        (await client.sendMessage("Still active")).stopReason,
        "end_turn"
      );
    });

    test("rejects overlapping session creation", async () => {
      await client.connect();

      const firstSession = client.newSession("/test/dir");
      await assert.rejects(
        () => client.newSession("/test/dir"),
        /Session creation already in progress/
      );

      assert.ok((await firstSession).sessionId);
      assert.ok(client.getSessionMetadata());
    });

    test("should throw if not connected", async () => {
      await assert.rejects(async () => {
        await client.newSession("/test/dir");
      }, /Not connected/);
    });
  });

  suite("loadSession", () => {
    test("does not call session/load when the agent lacks the capability", async () => {
      await client.connect();

      assert.strictEqual(client.supportsSessionLoad(), false);
      await assert.rejects(
        () => client.loadSession("missing-session", "/test/dir"),
        /does not support session loading/
      );
    });

    test("replays message chunks while restoring the selected session", async () => {
      demoMode = "load";
      await client.connect();
      const created = await client.newSession("/test/dir");
      const updates: Array<{ sessionUpdate: string; text: string }> = [];
      client.setOnSessionUpdate((notification) => {
        const update = notification.update;
        if (
          (update.sessionUpdate === "user_message_chunk" ||
            update.sessionUpdate === "agent_message_chunk") &&
          update.content.type === "text"
        ) {
          updates.push({
            sessionUpdate: update.sessionUpdate,
            text: update.content.text,
          });
        }
      });

      await client.loadSession(created.sessionId, "/test/dir");

      assert.strictEqual(client.supportsSessionLoad(), true);
      assert.strictEqual(client.getCurrentSessionId(), created.sessionId);
      assert.deepStrictEqual(updates, [
        { sessionUpdate: "user_message_chunk", text: "Restored " },
        { sessionUpdate: "user_message_chunk", text: "question" },
        { sessionUpdate: "agent_message_chunk", text: "Restored " },
        { sessionUpdate: "agent_message_chunk", text: "answer" },
      ]);
    });

    test("keeps the active session when loading fails", async () => {
      demoMode = "load-failure";
      await client.connect();
      const active = await client.newSession("/test/dir");

      await assert.rejects(
        () => client.loadSession(active.sessionId, "/test/dir"),
        /Session load failed/
      );

      assert.strictEqual(client.getCurrentSessionId(), active.sessionId);
      assert.strictEqual(
        (await client.sendMessage("Still active")).stopReason,
        "end_turn"
      );
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

    test("keeps the connection and session available after an RPC error", async () => {
      demoMode = "error-internal";
      await client.connect();
      await client.newSession("/test/dir");

      await assert.rejects(
        () => client.sendMessage("Hello"),
        (error) => {
          assert.ok(error instanceof RequestError);
          assert.strictEqual(error.code, -32603);
          assert.strictEqual(error.message, "Agent execution failed");
          return true;
        }
      );

      assert.strictEqual(client.getState(), "connected");
      assert.ok(client.getSessionMetadata());
      assert.ok((await client.newSession("/test/dir")).sessionId);
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

    test("cancels permission requests without a user decision handler", async () => {
      demoMode = "permission";
      const streamed: string[] = [];
      client.setOnSessionUpdate((notification) => {
        if (
          notification.update.sessionUpdate === "agent_message_chunk" &&
          notification.update.content.type === "text"
        ) {
          streamed.push(notification.update.content.text);
        }
      });
      await client.connect();
      await client.newSession("/test/dir");

      await client.sendMessage("Request permission");

      assert.deepStrictEqual(streamed, ["permission:cancelled"]);
    });

    test("cancels a permission choice after its session is replaced", async () => {
      demoMode = "permission";
      let resolvePermission:
        ((response: RequestPermissionResponse) => void) | undefined;
      client.setOnRequestPermission(
        () =>
          new Promise<RequestPermissionResponse>((resolve) => {
            resolvePermission = resolve;
          })
      );
      await client.connect();
      await client.newSession("/test/dir");

      const prompt = client.sendMessage("Request permission");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.newSession("/test/dir");
      assert.ok(resolvePermission);
      resolvePermission({
        outcome: { outcome: "selected", optionId: "always" },
      });

      assert.strictEqual((await prompt).stopReason, "cancelled");
      assert.deepStrictEqual(
        mockProcesses[0].server.getPermissionOutcomes().at(-1),
        { outcome: "cancelled" }
      );
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

    test("rejects a mode that the agent did not offer", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      await assert.rejects(
        () => client.setMode("missing-mode"),
        /Mode is not available: missing-mode/
      );
      assert.strictEqual(
        client.getSessionMetadata()?.modes?.currentModeId,
        "code"
      );
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

    test("rejects a model value that the agent did not offer", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      await assert.rejects(
        () => client.setModel("missing-model"),
        /Model is not available: missing-model/
      );
      assert.strictEqual(
        client.getSessionMetadata()?.models?.currentModelId,
        "claude-3-sonnet"
      );
    });

    test("should throw if no session", async () => {
      await client.connect();

      await assert.rejects(async () => {
        await client.setModel("claude-3-opus");
      }, /No active session/);
    });
  });

  suite("cancel", () => {
    test("cancels an active prompt through the protocol notification", async () => {
      demoMode = "ansi";
      await client.connect();
      await client.newSession("/test/dir");

      const prompt = client.sendMessage("Hello");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.cancel();

      const response = await prompt;
      assert.strictEqual(response.stopReason, "cancelled");
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

    test("keeps the new connection usable when reconnecting right after dispose", async () => {
      await client.connect();
      await client.newSession("/test/dir");

      client.dispose();
      await client.connect();
      // Let the killed process deliver its exit event.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(client.getState(), "connected");
      const session = await client.newSession("/test/dir");
      assert.ok(session.sessionId);
    });

    test("does not let a disposed connection attempt tear down its replacement", async () => {
      demoMode = "no-initialize";
      const firstConnect = client.connect();
      const firstResult = firstConnect.then(
        () => null,
        (error: unknown) => error
      );

      client.dispose();
      demoMode = "default";
      const replacementConnect = client.connect();

      assert.ok((await firstResult) instanceof Error);
      await replacementConnect;
      assert.strictEqual(client.getState(), "connected");
      assert.ok((await client.newSession("/test/dir")).sessionId);
    });
  });
});
