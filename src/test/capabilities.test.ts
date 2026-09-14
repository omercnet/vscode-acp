import * as assert from "assert";
import { ChildProcess } from "child_process";
import { ACPClient, type SpawnFunction } from "../acp/client";
import { createMockProcess, type MockChildProcess } from "./mocks/acp-server";

suite("Client capabilities", () => {
  let client: ACPClient;
  let mockProcess: MockChildProcess;

  setup(() => {
    const mockSpawn: SpawnFunction = (
      _command: string,
      _args: string[],
      _options: unknown
    ): ChildProcess => {
      mockProcess = createMockProcess("capabilities");
      return mockProcess as unknown as ChildProcess;
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

  test("routes filesystem and terminal requests through registered handlers", async () => {
    const calls: string[] = [];
    const streamed: string[] = [];
    client.setOnSessionUpdate((notification) => {
      const update = notification.update;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        streamed.push(update.content.text);
      }
    });

    client.setOnRequestPermission(async (params) => {
      const allowOnce = params.options.find(
        (option) => option.kind === "allow_once"
      );
      assert.ok(allowOnce);
      return {
        outcome: { outcome: "selected", optionId: allowOnce.optionId },
      };
    });

    client.setOnReadTextFile(async (params) => {
      calls.push("read");
      assert.strictEqual(params.path, "/workspace/input.ts");
      return { content: "export const source = 1;\n" };
    });
    client.setOnWriteTextFile(async (params) => {
      calls.push("write");
      assert.deepStrictEqual(params, {
        sessionId: "mock-session-1",
        path: "/workspace/output.ts",
        content: "export {};\n",
      });
      return {};
    });
    client.setOnCreateTerminal(async (params) => {
      calls.push("create");
      assert.strictEqual(params.command, "echo");
      assert.deepStrictEqual(params.args, ["capability"]);
      return { terminalId: "mock-terminal" };
    });
    client.setOnTerminalOutput(async (params) => {
      calls.push("output");
      assert.strictEqual(params.terminalId, "mock-terminal");
      return { output: "capability\n", truncated: false, exitStatus: null };
    });
    client.setOnWaitForTerminalExit(async (params) => {
      calls.push("wait");
      assert.strictEqual(params.terminalId, "mock-terminal");
      return { exitCode: 0 };
    });
    client.setOnKillTerminalCommand(async (params) => {
      calls.push("kill");
      assert.strictEqual(params.terminalId, "mock-terminal");
      return {};
    });
    client.setOnReleaseTerminal(async (params) => {
      calls.push("release");
      assert.strictEqual(params.terminalId, "mock-terminal");
      return {};
    });

    await client.connect();
    await client.newSession("/workspace");
    assert.deepStrictEqual(
      mockProcess.server.getInitializeRequest()?.clientCapabilities,
      {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      }
    );
    const response = await client.sendMessage("Exercise capabilities");

    assert.strictEqual(response.stopReason, "end_turn");
    assert.deepStrictEqual(calls, [
      "read",
      "write",
      "create",
      "output",
      "wait",
      "kill",
      "release",
    ]);

    // The agent offers allow_always before allow_once; the explicit client
    // decision must be returned unchanged.
    assert.ok(
      streamed.includes("permission:once"),
      `expected allow_once approval, got ${JSON.stringify(streamed)}`
    );
  });
});
