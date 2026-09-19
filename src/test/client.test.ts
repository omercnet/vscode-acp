import * as assert from "assert";
import { ChildProcess, type SpawnOptions } from "child_process";
import {
  ACPClient,
  describeACPError,
  formatACPError,
  isAgentAuthMethod,
  runBoundedTerminationCommand,
  terminateWindowsProcessTree,
  type WindowsProcessIdentity,
  type SpawnFunction,
} from "../acp/client";
import { getAgent } from "../acp/agents";
import {
  RequestError,
  type McpServer,
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

function windowsProcessIdentity(processId: number): WindowsProcessIdentity {
  const now = Date.now();
  return {
    processId,
    createdNotBeforeMs: now - 1000,
    createdNotAfterMs: now + 1000,
    ownershipCutoffMs: now + 1000,
  };
}

suite("Agent process termination helpers", () => {
  test("bounds and escalates a stalled termination helper", async () => {
    const commandProcess = createMockProcess() as unknown as ChildProcess;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    commandProcess.kill = (signal?: NodeJS.Signals | number) => {
      signals.push(signal);
      return true;
    };
    let triggerTimeout!: () => void;
    const cancelled: unknown[] = [];
    const running = runBoundedTerminationCommand("taskkill", [], {
      spawn: () => commandProcess,
      timeoutMs: 1,
      scheduler: {
        schedule(callback) {
          triggerTimeout = callback;
          return "termination-timeout";
        },
        cancel(handle) {
          cancelled.push(handle);
        },
      },
    });

    triggerTimeout();

    assert.strictEqual(await running, false);
    assert.deepStrictEqual(signals, ["SIGKILL"]);
    assert.deepStrictEqual(cancelled, ["termination-timeout"]);
  });

  test("uses identity-validated PowerShell cleanup", async () => {
    const parent = createMockProcess() as unknown as ChildProcess;
    const commands: Array<{ command: string; args: string[] }> = [];

    await terminateWindowsProcessTree(parent, windowsProcessIdentity(42), {
      windowsRoot: "C:\\Windows",
      runCommand: async (command, args) => {
        commands.push({ command, args });
        return true;
      },
      waitForExit: async () => true,
    });

    assert.strictEqual(commands.length, 1);
    assert.ok(commands[0].command.endsWith("powershell.exe"));
    assert.ok(commands[0].args.includes("-NonInteractive"));
    const script = commands[0].args.at(-1) ?? "";
    assert.ok(script.includes("delta>10"));
    assert.ok(script.includes("$rootCreated -ge $notBefore"));
    const rootTermination = script.indexOf(
      "[AcpOwnedProcess]::TerminateIfCreated($root"
    );
    const processSnapshot = script.indexOf(
      "$all=@(Get-CimInstance Win32_Process"
    );
    assert.ok(rootTermination >= 0 && rootTermination < processSnapshot);
    assert.ok(script.includes("$pass -lt 64"));
    assert.ok(script.includes("$parentCutoffs.TryGetValue"));
    assert.ok(script.includes("if($owned.Count -eq 0){exit 0}"));
    assert.ok(script.includes("Descendant process identity changed"));
    const initialExitCheck = script.indexOf(
      "uint state=WaitForSingleObject(handle,0)"
    );
    const termination = script.indexOf("if(!TerminateProcess(handle,1))");
    const racedExitCheck = script.indexOf(
      "state=WaitForSingleObject(handle,0)",
      termination + 1
    );
    assert.ok(initialExitCheck >= 0 && initialExitCheck < termination);
    assert.ok(racedExitCheck > termination);
  });

  test("does not issue a stale taskkill after the parent exits", async () => {
    const parent = createMockProcess() as unknown as ChildProcess;
    const commands: Array<{ command: string; args: string[] }> = [];

    await terminateWindowsProcessTree(parent, windowsProcessIdentity(42), {
      windowsRoot: "C:\\Windows",
      runCommand: async (command, args) => {
        commands.push({ command, args });
        Object.defineProperty(parent, "exitCode", { value: 0 });
        return true;
      },
      waitForExit: async () => true,
    });

    assert.strictEqual(commands.length, 1);
    assert.ok(commands[0].command.endsWith("powershell.exe"));
    assert.ok(!commands[0].args.includes("/F"));
  });

  test("fails closed when descendant identity validation fails", async () => {
    const parent = createMockProcess() as unknown as ChildProcess;

    await assert.rejects(
      () =>
        terminateWindowsProcessTree(parent, windowsProcessIdentity(42), {
          windowsRoot: "C:\\Windows",
          runCommand: async (_command, args) => {
            assert.ok(
              (args.at(-1) ?? "").includes(
                "Descendant process identity changed"
              )
            );
            return false;
          },
          waitForExit: async () =>
            assert.fail("failed identity validation must not await the root"),
        }),
      /Failed to terminate ACP agent process tree/
    );
  });

  test("does not terminate a reused root pid after parent exit", async () => {
    const parent = createMockProcess() as unknown as ChildProcess;
    Object.defineProperty(parent, "exitCode", { value: 0 });
    let script = "";

    await terminateWindowsProcessTree(parent, windowsProcessIdentity(42), {
      windowsRoot: "C:\\Windows",
      runCommand: async (_command, args) => {
        script = args.at(-1) ?? "";
        return true;
      },
      waitForExit: async () => assert.fail("exited parent must not be awaited"),
    });

    assert.ok(!script.includes("Stop-OwnedProcess $root"));
    assert.ok(script.includes("$cutoff=$ownershipCutoff"));
    assert.ok(script.includes("$created -lt $parentCutoff"));
    assert.ok(script.includes("delta>10"));
  });

  test("treats an already-exited Windows root as successful", async function () {
    if (process.platform !== "win32") {
      this.skip();
    }
    const parent = createMockProcess() as unknown as ChildProcess;
    Object.defineProperty(parent, "exitCode", { value: 0 });

    await terminateWindowsProcessTree(
      parent,
      windowsProcessIdentity(2_000_000_000)
    );
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

  test("preserves structured classifications for transition-like diagnostics", () => {
    const error = new RequestError(-32602, "No active session");

    assert.deepStrictEqual(describeACPError(error), {
      kind: "invalid-parameters",
      code: -32602,
      summary: "Invalid parameters",
      diagnostic: "No active session",
    });
    assert.strictEqual(
      formatACPError(error),
      "Invalid parameters: No active session"
    );
  });

  test("rejects malformed agent-managed authentication methods", () => {
    assert.strictEqual(isAgentAuthMethod("browser"), false);
    assert.strictEqual(isAgentAuthMethod({ id: "browser" }), false);
    assert.strictEqual(
      isAgentAuthMethod({ id: "browser", name: "Browser", type: "agent" }),
      true
    );
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
      resolutionOptions: () => ({
        platform: "linux",
        env: { PATH: "/test/bin" },
        fileSystem: {
          isFile: (path) => path === "/test/bin/mock",
          isExecutable: (path) => path === "/test/bin/mock",
          readText: () => undefined,
          realpath: (path) => path,
        },
      }),
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
    test("retains only the active connection's initialized identity", async () => {
      demoMode = "agent-info";
      await client.connect();

      assert.deepStrictEqual(client.getAgentInfo(), {
        name: "metadata-agent",
        title: "Metadata Agent",
        version: "1.4.0",
      });

      client.dispose();
      assert.strictEqual(client.getAgentInfo(), null);

      demoMode = "invalid-version";
      await assert.rejects(() => client.connect());
      assert.strictEqual(client.getAgentInfo(), null);
    });
    test("normalizes initialized identity without splitting Unicode", async () => {
      demoMode = "agent-info-normalization";

      await client.connect();

      assert.deepStrictEqual(client.getAgentInfo(), {
        name: `${"a".repeat(255)}\u{10437}`,
        title: "Metadata Agent",
        version: "1.4.0",
      });
    });
    for (const transportFailure of ["end", "error"] as const) {
      test(`clears identity when the transport reports ${transportFailure} before process exit`, async () => {
        demoMode = "agent-info";
        await client.connect();
        const previousProcess = mockProcesses[0];
        const disconnected = new Promise<void>((resolve) => {
          client.setOnStateChange((state) => {
            if (state === "disconnected") resolve();
          });
        });

        if (transportFailure === "end") {
          previousProcess.stdout.push(null);
        } else {
          previousProcess.stdout.destroy(new Error("Transport failed"));
        }
        await disconnected;
        assert.strictEqual(client.getAgentInfo(), null);
        assert.strictEqual(client.isConnected(), false);

        demoMode = "default";
        await client.connect();
        previousProcess.emit("exit", 0);
        assert.strictEqual(client.isConnected(), true);
        assert.strictEqual(client.getAgentInfo(), null);
      });
    }
    test("spawns the resolved absolute executable without a shell", async () => {
      let spawned:
        { command: string; args: string[]; options: SpawnOptions } | undefined;
      client.dispose();
      client = new ACPClient({
        agentConfig: {
          id: "opencode",
          name: "OpenCode",
          command: "opencode",
          args: ["acp"],
        },
        spawn(command, args, options) {
          spawned = { command, args, options };
          return createMockProcess() as unknown as ChildProcess;
        },
        resolutionOptions: () => ({
          platform: "linux",
          env: {
            PATH: "/workspace/bin:/trusted/bin",
            AGENT_TEST_VALUE: "preserved",
          },
          excludedDirectories: ["/workspace"],
          fileSystem: {
            isFile: (path) => path === "/trusted/bin/opencode",
            isExecutable: (path) => path === "/trusted/bin/opencode",
            readText: () => undefined,
            realpath: (path) => path,
          },
        }),
      });

      await client.connect();

      assert.deepStrictEqual(spawned, {
        command: "/trusted/bin/opencode",
        args: ["acp"],
        options: {
          cwd: "/trusted/bin",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: "/trusted/bin",
            AGENT_TEST_VALUE: "preserved",
          },
          detached: process.platform !== "win32",
          shell: false,
        },
      });
    });

    test("never passes a relative command from public options to spawn", async () => {
      let spawnCalled = false;
      client.dispose();
      client = new ACPClient({
        agentConfig: {
          id: "mock-agent",
          name: "Mock Agent",
          command: "./workspace-payload",
          args: [],
        },
        spawn() {
          spawnCalled = true;
          return createMockProcess() as unknown as ChildProcess;
        },
        resolutionOptions: () => ({
          platform: "linux",
          env: { PATH: "/trusted/bin" },
          fileSystem: {
            isFile: () => true,
            isExecutable: () => true,
            readText: () => undefined,
            realpath: (path) => path,
          },
        }),
      });

      await assert.rejects(
        client.connect(),
        /Agent "Mock Agent" is unavailable/
      );
      assert.strictEqual(spawnCalled, false);
    });

    test("does not expose a configured executable path when unavailable", async () => {
      client.dispose();
      client = new ACPClient({
        agentConfig: {
          id: "opencode",
          name: "OpenCode",
          command: "/home/private-user/tools/opencode",
          args: ["acp"],
        },
        resolutionOptions: () => ({
          platform: "linux",
          env: { PATH: "/home/private-user/bin" },
          fileSystem: {
            isFile: () => false,
            isExecutable: () => false,
            readText: () => undefined,
            realpath: (path) => path,
          },
        }),
      });

      await assert.rejects(client.connect(), (error: Error) => {
        assert.match(error.message, /Agent "OpenCode" is unavailable/);
        assert.ok(!error.message.includes("private-user"));
        return true;
      });
    });

    test("disconnect invalidates capability discovery before spawn", async () => {
      let markDiscoveryStarted!: () => void;
      let releaseDiscovery!: () => void;
      const discoveryStarted = new Promise<void>((resolve) => {
        markDiscoveryStarted = resolve;
      });
      const discoveryGate = new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      client.setFileSystemCapabilities(async () => {
        markDiscoveryStarted();
        await discoveryGate;
        return { readTextFile: true, writeTextFile: true };
      });

      const connecting = client.connect();
      await discoveryStarted;
      await client.disconnect();
      releaseDiscovery();

      await assert.rejects(connecting, /Connection attempt was disposed/);
      assert.strictEqual(mockProcesses.length, 0);
      assert.strictEqual(client.getState(), "disconnected");
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
        { session: { configOptions: {} } }
      );
    });
    test("exposes negotiated MCP transport capabilities", async () => {
      demoMode = "mcp-transports";
      await client.connect();

      assert.deepStrictEqual(client.getMcpCapabilities(), {
        http: true,
        sse: true,
      });
      client.dispose();
      assert.deepStrictEqual(client.getMcpCapabilities(), {});
    });

    test("exposes only explicitly advertised prompt capabilities", async () => {
      demoMode = "rich-attachments";
      await client.connect();

      assert.deepStrictEqual(client.getPromptCapabilities(), {
        image: true,
        embeddedContext: true,
      });
      client.dispose();
      assert.deepStrictEqual(client.getPromptCapabilities(), {});
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

  suite("authentication", () => {
    test("rejects malformed and client-executed method shapes", () => {
      assert.strictEqual(isAgentAuthMethod(null), false);
      assert.strictEqual(isAgentAuthMethod({}), false);
      assert.strictEqual(isAgentAuthMethod({ id: "browser", name: 42 }), false);
      assert.strictEqual(
        isAgentAuthMethod({
          id: "browser",
          name: "Browser sign-in",
          description: { secret: "not displayable" },
        }),
        false
      );
      assert.strictEqual(
        isAgentAuthMethod({
          id: "terminal",
          name: "Terminal sign-in",
          type: "terminal",
        }),
        false
      );
      assert.strictEqual(
        isAgentAuthMethod({ id: "browser", name: "Browser sign-in" }),
        true
      );
    });

    test("retains advertised agent methods and authenticates before retrying session creation", async () => {
      demoMode = "authentication";

      await client.connect();
      assert.deepStrictEqual(client.getAuthenticationMethods(), [
        { id: "browser", name: "Browser sign-in" },
      ]);

      await assert.rejects(
        () => client.newSession({ cwd: "/test/dir", mcpServers: [] }),
        (error) => error instanceof RequestError && error.code === -32000
      );
      await client.authenticate("browser", client.getConnectionGeneration());
      const session = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      assert.ok(session.sessionId);
      assert.deepStrictEqual(
        mockProcesses[0].server.getAuthenticationRequests(),
        ["browser"]
      );
      assert.strictEqual(
        mockProcesses[0].server.getNewSessionRequestCount(),
        2
      );
      client.dispose();
      assert.deepStrictEqual(client.getAuthenticationMethods(), []);
    });

    test("preserves one MCP payload across auth retry and session load", async () => {
      demoMode = "authentication-mcp";
      await client.connect();
      const mcpServers: McpServer[] = [
        {
          type: "http",
          name: "remote",
          url: "https://example.com/mcp",
          headers: [{ name: "Authorization", value: "Bearer resolved" }],
        },
      ];
      const request = { cwd: "/test/dir", mcpServers };

      await assert.rejects(
        () => client.newSession(request),
        (error) => error instanceof RequestError && error.code === -32000
      );
      await client.authenticate("browser", client.getConnectionGeneration());
      const created = await client.newSession(request);
      await client.loadSession({ sessionId: created.sessionId, ...request });

      assert.deepStrictEqual(client.getMcpCapabilities(), {
        http: true,
        sse: true,
      });
      assert.deepStrictEqual(
        mockProcesses[0].server
          .getNewSessionRequests()
          .map((received) => received.mcpServers),
        [mcpServers, mcpServers]
      );
      assert.deepStrictEqual(
        mockProcesses[0].server.getLoadSessionRequests()[0].mcpServers,
        mcpServers
      );
    });

    test("rejects terminal and stale authentication methods without sending them", async () => {
      demoMode = "authentication-terminal";
      await client.connect();

      await assert.rejects(
        () => client.authenticate("terminal", client.getConnectionGeneration()),
        /Authentication method is not available/
      );
      assert.deepStrictEqual(
        mockProcesses[0].server.getAuthenticationRequests(),
        []
      );

      client.dispose();
      await assert.rejects(
        () => client.authenticate("terminal", client.getConnectionGeneration()),
        /Not connected/
      );
      assert.deepStrictEqual(
        mockProcesses[0].server.getAuthenticationRequests(),
        []
      );
    });

    test("rejects a method type the client cannot execute without sending it", async () => {
      demoMode = "authentication-unknown-type";
      await client.connect();

      await assert.rejects(
        () => client.authenticate("future", client.getConnectionGeneration()),
        /Authentication method is not available/
      );
      assert.deepStrictEqual(
        mockProcesses[0].server.getAuthenticationRequests(),
        []
      );
    });

    test("discards a selection made against a replaced connection", async () => {
      demoMode = "authentication";
      await client.connect();
      const selectedGeneration = client.getConnectionGeneration();

      client.dispose();
      await client.connect();

      await assert.rejects(
        () => client.authenticate("browser", selectedGeneration),
        /Authentication selection is stale/
      );
      assert.deepStrictEqual(
        mockProcesses[1].server.getAuthenticationRequests(),
        []
      );
      assert.strictEqual(
        mockProcesses[1].server.getNewSessionRequestCount(),
        0
      );
    });

    test("keeps the connected, sessionless state when authentication fails", async () => {
      demoMode = "authentication-failure";
      await client.connect();

      await assert.rejects(() =>
        client.newSession({ cwd: "/test/dir", mcpServers: [] })
      );
      await assert.rejects(() =>
        client.authenticate("browser", client.getConnectionGeneration())
      );

      assert.strictEqual(client.getState(), "connected");
      assert.strictEqual(client.getSessionMetadata(), null);
      assert.strictEqual(
        mockProcesses[0].server.getNewSessionRequestCount(),
        1
      );
    });
  });

  suite("newSession", () => {
    test("should create a new session", async () => {
      await client.connect();
      const response = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      assert.ok(response.sessionId);
      assert.ok(response.sessionId.startsWith("mock-session-"));
      assert.strictEqual(client.getCurrentSessionId(), response.sessionId);
      assert.deepStrictEqual(
        mockProcesses.at(-1)?.server.getNewSessionRequests()[0],
        { cwd: "/test/dir", mcpServers: [] }
      );

      const metadata = client.getSessionMetadata();
      assert.ok(metadata);
      assert.ok(metadata.modes);
      assert.deepStrictEqual(
        metadata.configOptions?.map(({ id, currentValue }) => ({
          id,
          currentValue,
        })),
        [{ id: "model", currentValue: "claude-3-sonnet" }]
      );
      assert.strictEqual(metadata.modes?.currentModeId, "code");
    });

    test("should receive available commands update", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

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
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      assert.deepStrictEqual(client.getSessionMetadata()?.configOptions, [
        {
          id: "model",
          type: "select",
          name: "Model",
          category: "model",
          currentValue: "claude-3-opus",
          options: [
            {
              group: "anthropic",
              name: "Anthropic",
              options: [
                { value: "claude-3-sonnet", name: "Claude 3 Sonnet" },
                { value: "claude-3-opus", name: "Claude 3 Opus" },
              ],
            },
          ],
        },
      ]);
    });

    test("drops a select option with an invalid current value", async () => {
      demoMode = "invalid-config";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      assert.deepStrictEqual(client.getSessionMetadata()?.configOptions, []);
    });

    test("does not commit a session with malformed nested config options", async () => {
      demoMode = "malformed-config";
      await client.connect();

      await assert.rejects(
        () => client.newSession({ cwd: "/test/dir", mcpServers: [] }),
        /Invalid session configuration options/
      );
      assert.strictEqual(client.getCurrentSessionId(), null);
      assert.strictEqual(client.getSessionMetadata(), null);
    });

    test("tracks current mode updates in session metadata", async () => {
      demoMode = "mode-update";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.strictEqual(
        client.getSessionMetadata()?.modes?.currentModeId,
        "architect"
      );
    });

    test("keeps pre-response metadata scoped to its session", async () => {
      demoMode = "session-isolation";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      let staleReadCount = 0;
      client.setOnReadTextFile(async () => {
        staleReadCount++;
        return { content: "stale" };
      });
      const observedSessionIds: string[] = [];
      client.setOnSessionUpdate((notification) => {
        observedSessionIds.push(notification.sessionId);
      });

      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      const metadata = client.getSessionMetadata();
      assert.strictEqual(
        metadata?.configOptions?.[0]?.currentValue,
        "session-2-model"
      );
      assert.strictEqual(metadata?.commands?.[0]?.name, "session-2");
      assert.deepStrictEqual(observedSessionIds, []);
      assert.strictEqual(staleReadCount, 0);
    });

    test("cancels work in the replaced session", async () => {
      demoMode = "ansi";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      const prompt = client.sendMessage("Hello");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

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
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
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
      const firstSession = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      const secondSession = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.notStrictEqual(secondSession.sessionId, firstSession.sessionId);
      assert.deepStrictEqual(mockProcesses[0].server.getClosedSessionIds(), [
        firstSession.sessionId,
      ]);
    });

    test("does not wait for an unresponsive session close", async () => {
      demoMode = "session-close-hangs";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      const replacement = client
        .newSession({ cwd: "/test/dir", mcpServers: [] })
        .then(
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
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
      const previousMetadata = client.getSessionMetadata();

      await assert.rejects(
        () => client.newSession({ cwd: "/test/dir", mcpServers: [] }),
        /Replacement session failed/
      );

      assert.deepStrictEqual(client.getSessionMetadata(), previousMetadata);
      assert.strictEqual(
        (await client.sendMessage("Still active")).stopReason,
        "end_turn"
      );
    });

    test("reconciles a pending mutation after its replacement fails", async () => {
      demoMode = "replacement-failure-pending-config";
      await client.connect();
      const active = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      const mutation = client.setSessionConfigOption("interaction", "review");
      while (mockProcesses[0].server.getConfigOptionRequests().length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await assert.rejects(
        () => client.newSession({ cwd: "/test/dir", mcpServers: [] }),
        /Replacement session failed/
      );
      await mutation;

      assert.strictEqual(client.getCurrentSessionId(), active.sessionId);
      assert.deepStrictEqual(
        client
          .getSessionMetadata()
          ?.configOptions?.map(({ id, currentValue }) => ({
            id,
            currentValue,
          })),
        [
          { id: "interaction", currentValue: "review" },
          { id: "model", currentValue: "accurate" },
        ]
      );
    });

    test("preserves notification order while a failed replacement is pending", async () => {
      demoMode = "replacement-failure-ordered-config";
      await client.connect();
      const active = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      const mutation = client.setSessionConfigOption("interaction", "review");
      while (mockProcesses[0].server.getConfigOptionRequests().length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await assert.rejects(
        () => client.newSession({ cwd: "/test/dir", mcpServers: [] }),
        /Replacement session failed/
      );
      await mutation;

      const clientState = client
        .getSessionMetadata()
        ?.configOptions?.map(({ id, currentValue }) => ({ id, currentValue }));
      const agentState = mockProcesses[0].server
        .getSessionConfigOptions(active.sessionId)
        ?.map(({ id, currentValue }) => ({ id, currentValue }));
      assert.deepStrictEqual(clientState, [
        { id: "interaction", currentValue: "review" },
        { id: "model", currentValue: "latest" },
      ]);
      assert.deepStrictEqual(clientState, agentState);
    });

    test("rejects a pending mutation after a successful replacement", async () => {
      demoMode = "replacement-success-pending-config";
      await client.connect();
      const original = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      const staleMutation = assert.rejects(
        client.setSessionConfigOption("interaction", "review"),
        /Configuration selection is stale/
      );
      while (mockProcesses[0].server.getConfigOptionRequests().length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const replacement = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });
      await staleMutation;

      assert.notStrictEqual(replacement.sessionId, original.sessionId);
      assert.strictEqual(client.getCurrentSessionId(), replacement.sessionId);
      assert.deepStrictEqual(
        client
          .getSessionMetadata()
          ?.configOptions?.map(({ id, currentValue }) => ({
            id,
            currentValue,
          })),
        [
          { id: "interaction", currentValue: "build" },
          { id: "model", currentValue: "fast" },
          { id: "thought", currentValue: "medium" },
        ]
      );
    });

    test("rejects overlapping session creation", async () => {
      await client.connect();

      const firstSession = client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });
      await assert.rejects(
        () => client.newSession({ cwd: "/test/dir", mcpServers: [] }),
        /Session creation already in progress/
      );

      assert.ok((await firstSession).sessionId);
      assert.ok(client.getSessionMetadata());
    });

    test("should throw if not connected", async () => {
      await assert.rejects(async () => {
        await client.newSession({ cwd: "/test/dir", mcpServers: [] });
      }, /Not connected/);
    });
  });

  suite("loadSession", () => {
    test("does not call session/load when the agent lacks the capability", async () => {
      await client.connect();

      assert.strictEqual(client.supportsSessionLoad(), false);
      await assert.rejects(
        () =>
          client.loadSession({
            sessionId: "missing-session",
            cwd: "/test/dir",
            mcpServers: [],
          }),
        /does not support session loading/
      );
    });

    test("replays message chunks while restoring the selected session", async () => {
      demoMode = "load";
      await client.connect();
      const created = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });
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

      await client.loadSession({
        sessionId: created.sessionId,
        cwd: "/test/dir",
        mcpServers: [],
      });

      assert.strictEqual(client.supportsSessionLoad(), true);
      assert.strictEqual(client.getCurrentSessionId(), created.sessionId);
      assert.strictEqual(
        client.getSessionMetadata()?.configOptions?.[0]?.currentValue,
        "claude-3-sonnet"
      );
      assert.deepStrictEqual(updates, [
        { sessionUpdate: "user_message_chunk", text: "Restored " },
        { sessionUpdate: "user_message_chunk", text: "question" },
        { sessionUpdate: "agent_message_chunk", text: "Restored " },
        { sessionUpdate: "agent_message_chunk", text: "answer" },
      ]);
    });

    test("reconciles a pending mutation across a same-session load", async () => {
      demoMode = "same-session-load-pending-config";
      await client.connect();
      const active = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      const mutation = client.setSessionConfigOption("interaction", "review");
      while (mockProcesses[0].server.getConfigOptionRequests().length === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await client.loadSession({
        sessionId: active.sessionId,
        cwd: "/test/dir",
        mcpServers: [],
      });
      await mutation;

      const clientState = client
        .getSessionMetadata()
        ?.configOptions?.map(({ id, currentValue }) => ({ id, currentValue }));
      const agentState = mockProcesses[0].server
        .getSessionConfigOptions(active.sessionId)
        ?.map(({ id, currentValue }) => ({ id, currentValue }));
      assert.strictEqual(client.getCurrentSessionId(), active.sessionId);
      assert.deepStrictEqual(clientState, [
        { id: "interaction", currentValue: "review" },
        { id: "model", currentValue: "accurate" },
      ]);
      assert.deepStrictEqual(clientState, agentState);
    });
    test("passes the same MCP servers to session/new and session/load", async () => {
      demoMode = "load";
      await client.connect();
      const mcpServers: McpServer[] = [
        {
          name: "filesystem",
          command: process.execPath,
          args: ["server.js"],
          env: [{ name: "TOKEN", value: "resolved-value" }],
        },
      ];

      const created = await client.newSession({
        cwd: "/test/dir",
        mcpServers,
      });
      await client.loadSession({
        sessionId: created.sessionId,
        cwd: "/test/dir",
        mcpServers,
      });

      assert.deepStrictEqual(
        mockProcesses[0].server.getNewSessionRequests()[0].mcpServers,
        mcpServers
      );
      assert.deepStrictEqual(
        mockProcesses[0].server.getLoadSessionRequests()[0].mcpServers,
        mcpServers
      );
    });

    test("keeps the active session when loading fails", async () => {
      demoMode = "load-failure";
      await client.connect();
      const active = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      await assert.rejects(
        () =>
          client.loadSession({
            sessionId: active.sessionId,
            cwd: "/test/dir",
            mcpServers: [],
          }),
        /Session load failed/
      );

      assert.strictEqual(client.getCurrentSessionId(), active.sessionId);
      assert.strictEqual(
        (await client.sendMessage("Still active")).stopReason,
        "end_turn"
      );
    });
  });

  suite("agent-owned sessions", () => {
    test("lists pages without replacing the active session", async () => {
      demoMode = "sessions";
      await client.connect();
      const active = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });

      assert.deepStrictEqual(client.getSessionCapabilities(), {
        load: true,
        list: true,
        resume: true,
        additionalDirectories: true,
      });
      const first = await client.listSessions({});
      const second = await client.listSessions({ cursor: first.nextCursor });

      assert.strictEqual(client.getCurrentSessionId(), active.sessionId);
      assert.deepStrictEqual(
        first.sessions.map((session) => session.sessionId),
        ["listed-session-1"]
      );
      assert.deepStrictEqual(
        second.sessions.map((session) => session.sessionId),
        ["listed-session-2"]
      );
      assert.deepStrictEqual(mockProcesses[0].server.getListSessionRequests(), [
        {},
        { cursor: "page-2" },
      ]);
    });

    test("resumes with the selected directories and MCP snapshot", async () => {
      demoMode = "sessions";
      await client.connect();
      const mcpServers: McpServer[] = [
        {
          name: "filesystem",
          command: process.execPath,
          args: ["server.js"],
          env: [],
        },
      ];

      await client.resumeSession({
        sessionId: "listed-session-1",
        cwd: "/test/dir",
        additionalDirectories: ["/test/shared"],
        mcpServers,
      });

      assert.strictEqual(client.getCurrentSessionId(), "listed-session-1");
      assert.strictEqual(
        client.getSessionMetadata()?.modes?.currentModeId,
        "code"
      );
      assert.deepStrictEqual(
        mockProcesses[0].server.getResumeSessionRequests(),
        [
          {
            sessionId: "listed-session-1",
            cwd: "/test/dir",
            additionalDirectories: ["/test/shared"],
            mcpServers,
          },
        ]
      );
    });

    test("rejects unadvertised listing and resuming", async () => {
      await client.connect();

      await assert.rejects(
        () => client.listSessions({}),
        /does not support session listing/
      );
      await assert.rejects(
        () =>
          client.resumeSession({
            sessionId: "session",
            cwd: "/test/dir",
            mcpServers: [],
          }),
        /does not support session resuming/
      );
    });
  });

  suite("sendMessage", () => {
    test("should send message and receive response", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      const updates: unknown[] = [];
      client.setOnSessionUpdate((update) => updates.push(update));

      const response = await client.sendMessage("Hello");

      assert.strictEqual(response.stopReason, "end_turn");
    });

    test("keeps the connection and session available after an RPC error", async () => {
      demoMode = "error-internal";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

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
      assert.ok(
        (await client.newSession({ cwd: "/test/dir", mcpServers: [] }))
          .sessionId
      );
    });

    test("should transport text followed by resource link metadata", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.sendMessage("Review this file", [
        {
          id: "att-1",
          uri: "file:///test/dir/file.ts",
          name: "file.ts",
          mimeType: "text/typescript",
          size: 321,
        },
      ]);

      const process = mockProcesses.at(-1);
      assert.ok(process);
      assert.deepStrictEqual(process.server.lastPrompt, [
        { type: "text", text: "Review this file" },
        {
          type: "resource_link",
          uri: "file:///test/dir/file.ts",
          name: "file.ts",
          mimeType: "text/typescript",
          size: 321,
        },
      ]);
    });

    test("sends embedded resource and image blocks only with negotiated support", async () => {
      demoMode = "rich-attachments";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.sendMessage("Inspect", [
        {
          id: "context",
          uri: "file:///test/dir/context.ts",
          name: "context.ts",
          mimeType: "text/typescript",
          size: 20,
          source: "file",
          kind: "file",
          transport: "resource",
          payload: { type: "text", text: "const unsaved = true;" },
        },
        {
          id: "image",
          uri: "vscode-acp-attachment:///memory/image/image.png",
          name: "image.png",
          mimeType: "image/png",
          size: 8,
          source: "memory",
          kind: "image",
          transport: "image",
          payload: { type: "image", data: "iVBORw0KGgo=" },
        },
      ]);

      const process = mockProcesses.at(-1);
      assert.ok(process);
      assert.deepStrictEqual(process.server.lastPrompt, [
        { type: "text", text: "Inspect" },
        {
          type: "resource",
          resource: {
            uri: "file:///test/dir/context.ts",
            mimeType: "text/typescript",
            text: "const unsaved = true;",
          },
        },
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        },
      ]);
    });

    test("does not send optional content blocks without advertised support", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.sendMessage("Inspect", [
        {
          id: "context",
          uri: "file:///test/dir/context.ts",
          name: "context.ts",
          mimeType: "text/typescript",
          source: "file",
          payload: { type: "text", text: "secret context" },
        },
        {
          id: "image",
          uri: "vscode-acp-attachment:///memory/image/image.png",
          name: "image.png",
          mimeType: "image/png",
          size: 8,
          source: "memory",
          kind: "image",
          payload: { type: "image", data: "iVBORw0KGgo=" },
        },
      ]);

      const process = mockProcesses.at(-1);
      assert.ok(process);
      assert.deepStrictEqual(process.server.lastPrompt, [
        { type: "text", text: "Inspect" },
        {
          type: "resource_link",
          uri: "file:///test/dir/context.ts",
          name: "context.ts",
          mimeType: "text/typescript",
        },
      ]);
    });

    test("should transport an attachment-only prompt", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.sendMessage("", [
        {
          id: "att-only",
          uri: "file:///test/dir/only.ts",
          name: "only.ts",
        },
      ]);

      const process = mockProcesses.at(-1);
      assert.ok(process);
      assert.deepStrictEqual(process.server.lastPrompt, [
        {
          type: "resource_link",
          uri: "file:///test/dir/only.ts",
          name: "only.ts",
        },
      ]);
    });

    test("should notify multiple session update listeners", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

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
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

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
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      const prompt = client.sendMessage("Request permission");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
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
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.setMode("architect");

      const metadata = client.getSessionMetadata();
      assert.strictEqual(metadata?.modes?.currentModeId, "architect");
    });

    test("rejects a mode that the agent did not offer", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

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
    test("changes a legacy model only when configOptions is absent", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
      const metadata = client.getSessionMetadata();
      assert.ok(metadata?.models);
      metadata.configOptions = null;

      await client.setModel("claude-3-opus");

      assert.deepStrictEqual(
        mockProcesses[0].server.getConfigOptionRequests(),
        [
          {
            sessionId: "mock-session-1",
            configId: "model",
            value: "claude-3-opus",
          },
        ]
      );
      assert.strictEqual(
        client.getSessionMetadata()?.models?.currentModelId,
        "claude-3-opus"
      );
      assert.strictEqual(
        client.getSessionMetadata()?.configOptions?.[0]?.currentValue,
        "claude-3-opus"
      );
    });

    test("rejects the legacy model path when configOptions is present", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await assert.rejects(
        () => client.setModel("claude-3-opus"),
        /Legacy model selection is unavailable/
      );
      assert.deepStrictEqual(
        mockProcesses[0].server.getConfigOptionRequests(),
        []
      );
    });
  });

  suite("setSessionConfigOption", () => {
    test("replaces the full option set returned by a cascading change", async () => {
      demoMode = "cascading-config";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.setSessionConfigOption("interaction", "review");

      assert.deepStrictEqual(
        mockProcesses[0].server.getConfigOptionRequests(),
        [
          {
            sessionId: "mock-session-1",
            configId: "interaction",
            value: "review",
          },
        ]
      );
      assert.deepStrictEqual(
        client
          .getSessionMetadata()
          ?.configOptions?.map(({ id, currentValue }) => ({
            id,
            currentValue,
          })),
        [
          { id: "interaction", currentValue: "review" },
          { id: "model", currentValue: "accurate" },
        ]
      );
    });

    test("keeps an earlier cascade when a queued later selection fails", async () => {
      demoMode = "overlapping-config";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      const cascade = client.setSessionConfigOption("interaction", "review");
      const rejectedSelection = assert.rejects(
        client.setSessionConfigOption("model", "fast")
      );
      await cascade;
      await rejectedSelection;

      assert.deepStrictEqual(
        client
          .getSessionMetadata()
          ?.configOptions?.map(({ id, currentValue }) => ({
            id,
            currentValue,
          })),
        [
          { id: "interaction", currentValue: "review" },
          { id: "model", currentValue: "accurate" },
        ]
      );
      assert.deepStrictEqual(
        mockProcesses[0].server
          .getConfigOptionRequests()
          .map(({ configId, value }) => ({ configId, value })),
        [{ configId: "interaction", value: "review" }]
      );
    });

    test("applies the authoritative response after a preceding notification", async () => {
      demoMode = "pre-response-config";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.setSessionConfigOption("interaction", "review");

      assert.deepStrictEqual(
        client
          .getSessionMetadata()
          ?.configOptions?.map(({ id, currentValue }) => ({
            id,
            currentValue,
          })),
        [
          { id: "interaction", currentValue: "review" },
          { id: "model", currentValue: "accurate" },
        ]
      );
    });

    test("applies a superseding notification sent after the response", async () => {
      demoMode = "post-response-config";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await client.setSessionConfigOption("interaction", "review");
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.deepStrictEqual(
        client
          .getSessionMetadata()
          ?.configOptions?.map(({ id, currentValue }) => ({
            id,
            currentValue,
          })),
        [
          { id: "interaction", currentValue: "review" },
          { id: "model", currentValue: "latest" },
        ]
      );
    });

    test("applies a superseding notification in the response transport chunk", async () => {
      demoMode = "same-chunk-post-response-config";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
      const configUpdateReceived = new Promise<void>((resolve) => {
        client.setOnSessionUpdate((update) => {
          if (update.update.sessionUpdate === "config_option_update") {
            resolve();
          }
        });
      });

      await client.setSessionConfigOption("interaction", "review");
      await configUpdateReceived;

      assert.deepStrictEqual(
        client
          .getSessionMetadata()
          ?.configOptions?.map(({ id, currentValue }) => ({
            id,
            currentValue,
          })),
        [
          { id: "interaction", currentValue: "review" },
          { id: "model", currentValue: "latest" },
        ]
      );
    });

    test("rejects values that the advertised option does not offer", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      await assert.rejects(
        () => client.setSessionConfigOption("model", "missing-model"),
        /Configuration value is not available: missing-model/
      );
      assert.strictEqual(
        client.getSessionMetadata()?.configOptions?.[0]?.currentValue,
        "claude-3-sonnet"
      );
    });

    test("should throw if no session", async () => {
      await client.connect();

      await assert.rejects(async () => {
        await client.setSessionConfigOption("model", "claude-3-opus");
      }, /No active session/);
    });
  });

  suite("cancel", () => {
    test("cancels an active prompt through the protocol notification", async () => {
      demoMode = "ansi";
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

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
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });

      client.dispose();

      assert.strictEqual(client.getState(), "disconnected");
      assert.strictEqual(client.isConnected(), false);
      assert.strictEqual(client.getSessionMetadata(), null);
    });

    test("waits for the old process to exit before reconnecting", async () => {
      await client.connect();
      await client.newSession({ cwd: "/test/dir", mcpServers: [] });
      const previousProcess = mockProcesses[0];
      previousProcess.kill = () => true;

      client.dispose();
      const reconnecting = client.connect();

      assert.strictEqual(mockProcesses.length, 1);
      previousProcess.emit("exit", 0);
      await reconnecting;
      assert.strictEqual(mockProcesses.length, 2);
      assert.strictEqual(client.getState(), "connected");
      const session = await client.newSession({
        cwd: "/test/dir",
        mcpServers: [],
      });
      assert.ok(session.sessionId);
    });

    test("escalates process termination when graceful shutdown hangs", async () => {
      await client.connect();
      const previousProcess = mockProcesses[0];
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      previousProcess.kill = (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          setImmediate(() => previousProcess.emit("exit", null, "SIGKILL"));
        }
        return true;
      };
      await client.disconnect();

      assert.deepStrictEqual(signals, ["SIGTERM", "SIGKILL"]);
      assert.strictEqual(client.getState(), "disconnected");
    });

    test("retains process-tree ownership after the parent exits", async () => {
      await client.connect();
      const previousProcess = mockProcesses[0];
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      previousProcess.kill = (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        setImmediate(() => previousProcess.emit("exit", 0));
        return true;
      };

      previousProcess.emit("exit", 0);
      await client.disconnect();

      assert.deepStrictEqual(signals, ["SIGTERM"]);
      assert.strictEqual(client.getState(), "disconnected");
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
      assert.ok(
        (await client.newSession({ cwd: "/test/dir", mcpServers: [] }))
          .sessionId
      );
    });
  });
});
