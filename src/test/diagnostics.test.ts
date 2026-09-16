import * as assert from "assert";
import * as vscode from "vscode";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { ACPDiagnostics, type ACPDiagnosticsSink } from "../acp/diagnostics";

class TestSink implements ACPDiagnosticsSink {
  readonly lines: string[] = [];
  readonly showCalls: Array<boolean | undefined> = [];

  appendLine(value: string): void {
    this.lines.push(value);
  }

  show(preserveFocus?: boolean): void {
    this.showCalls.push(preserveFocus);
  }
}

function message(value: Record<string, unknown>): AnyMessage {
  return value as AnyMessage;
}

function controlledStream(): {
  stream: Stream;
  push(message: AnyMessage): void;
  end(): void;
} {
  let input!: ReadableStreamDefaultController<AnyMessage>;
  return {
    stream: {
      writable: new WritableStream<AnyMessage>({ write() {} }),
      readable: new ReadableStream<AnyMessage>({
        start(controller) {
          input = controller;
        },
      }),
    },
    push(message) {
      input.enqueue(message);
    },
    end() {
      input.close();
    },
  };
}

suite("ACP diagnostics", () => {
  test("is disabled by default and shows only on command", () => {
    const sink = new TestSink();
    const diagnostics = new ACPDiagnostics(sink, () => false);

    diagnostics.record(
      "client->agent",
      message({
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { prompt: [{ type: "text", text: "private prompt" }] },
      })
    );
    diagnostics.show();

    assert.deepStrictEqual(sink.lines, []);
    assert.deepStrictEqual(sink.showCalls, [true]);
  });

  test("correlates requests without retaining protocol bodies", () => {
    const sink = new TestSink();
    let now = 100;
    const diagnostics = new ACPDiagnostics(
      sink,
      () => true,
      () => now
    );

    diagnostics.record(
      "client->agent",
      message({
        jsonrpc: "2.0",
        id: "secret-request-id",
        method: "session/prompt",
        params: {
          sessionId: "secret-session-id",
          prompt: [
            { type: "text", text: "secret-prompt-text" },
            { type: "resource", resource: { text: "secret-resource-data" } },
            { type: "image", data: "secret-image-data" },
          ],
        },
      })
    );
    now = 137;
    diagnostics.record(
      "agent->client",
      message({
        jsonrpc: "2.0",
        id: "secret-request-id",
        result: { stopReason: "end_turn", private: "secret-result" },
      })
    );

    const [request, response] = sink.lines.map((line) => JSON.parse(line));
    assert.deepStrictEqual(
      {
        direction: request.direction,
        method: request.method,
        correlation: request.correlation,
        durationMs: request.durationMs,
        outcome: request.outcome,
        metadata: request.metadata,
      },
      {
        direction: "client->agent",
        method: "session/prompt",
        correlation: "rpc-1",
        durationMs: 0,
        outcome: "pending",
        metadata: {
          contentCount: 3,
          textCount: 1,
          imageCount: 1,
          resourceCount: 1,
        },
      }
    );
    assert.deepStrictEqual(
      {
        direction: response.direction,
        method: response.method,
        correlation: response.correlation,
        durationMs: response.durationMs,
        outcome: response.outcome,
        metadata: response.metadata,
      },
      {
        direction: "agent->client",
        method: "session/prompt",
        correlation: "rpc-1",
        durationMs: 37,
        outcome: "ok",
        metadata: {},
      }
    );
    const output = sink.lines.join("\n");
    for (const secret of [
      "secret-request-id",
      "secret-session-id",
      "secret-prompt-text",
      "secret-resource-data",
      "secret-image-data",
      "secret-result",
    ]) {
      assert.ok(!output.includes(secret), `diagnostics exposed ${secret}`);
    }
  });

  test("omits sensitive known payloads and fails closed for unknown methods", () => {
    const sink = new TestSink();
    const diagnostics = new ACPDiagnostics(sink, () => true);
    const secret = "never-record-this-value";
    const calls = [
      {
        id: 1,
        method: "session/new",
        params: {
          cwd: `/private/${secret}`,
          mcpServers: [
            {
              name: "private-server",
              command: `/private/${secret}`,
              env: [{ name: "TOKEN", value: secret }],
              headers: [{ name: "Authorization", value: secret }],
            },
          ],
        },
      },
      {
        id: 2,
        method: "session/request_permission",
        params: { toolCall: { rawInput: secret }, options: [{ name: secret }] },
      },
      {
        id: 3,
        method: "fs/write_text_file",
        params: { path: `/private/${secret}`, content: secret },
      },
      {
        id: 4,
        method: "terminal/create",
        params: { args: [secret], env: [{ name: "TOKEN", value: secret }] },
      },
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: secret },
          },
        },
      },
      {
        id: 5,
        method: "authenticate",
        params: { methodId: secret, token: secret },
      },
      {
        id: 6,
        method: "terminal/output",
        params: { terminalId: secret },
      },
      {
        id: 7,
        method: `future/${secret}`,
        params: { arbitrary: secret },
      },
    ];

    for (const call of calls) {
      diagnostics.record("agent->client", message({ jsonrpc: "2.0", ...call }));
    }
    diagnostics.record(
      "client->agent",
      message({
        jsonrpc: "2.0",
        id: 2,
        result: { outcome: { optionId: secret }, payload: secret },
      })
    );
    diagnostics.record(
      "client->agent",
      message({
        jsonrpc: "2.0",
        id: 4,
        result: { terminalId: secret, output: secret },
      })
    );
    diagnostics.record(
      "client->agent",
      message({
        jsonrpc: "2.0",
        id: 6,
        result: { output: secret, truncated: false },
      })
    );

    const output = sink.lines.join("\n");
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("Authorization"));
    assert.ok(!output.includes("TOKEN"));
    assert.ok(!output.includes("private-server"));
    const records = sink.lines.map((line) => JSON.parse(line));
    assert.deepStrictEqual(records[1].metadata, {});
    const unknown = records.find((record) => record.method === "unknown");
    assert.ok(unknown);
    assert.deepStrictEqual(unknown.metadata, {});
    assert.deepStrictEqual(records.at(-3).metadata, {});
    assert.deepStrictEqual(records.at(-2).metadata, {});
    assert.deepStrictEqual(records.at(-1).metadata, {
      outputBytes: Buffer.byteLength(secret, "utf8"),
      truncated: false,
      hasExitStatus: false,
    });
  });

  test("bounds structural counts and error diagnostics", () => {
    const sink = new TestSink();
    const diagnostics = new ACPDiagnostics(sink, () => true);
    const secret = "error-secret";

    diagnostics.record(
      "client->agent",
      message({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { mcpServers: new Array(10_001).fill({ value: secret }) },
      })
    );

    diagnostics.record(
      "agent->client",
      message({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: secret, data: { token: secret } },
      })
    );

    const [request, response] = sink.lines.map((line) => JSON.parse(line));
    assert.strictEqual(request.metadata.mcpServerCount, 10_000);
    assert.deepStrictEqual(response.metadata, { errorCode: -32000 });
    assert.strictEqual(response.outcome, "error");
    assert.ok(!sink.lines.join("\n").includes(secret));
  });

  test("rejects unbounded request IDs", () => {
    const sink = new TestSink();
    const diagnostics = new ACPDiagnostics(sink, () => true);
    const invalidIds = [
      { attacker: true },
      "x".repeat(257),
      Number.NaN,
      1.5,
      null,
    ];
    for (const id of invalidIds) {
      diagnostics.record(
        "client->agent",
        message({ jsonrpc: "2.0", id, method: "session/prompt", params: {} })
      );
    }

    const records = sink.lines.map((line) => JSON.parse(line));
    for (const record of records) {
      assert.strictEqual(record.correlation, null);
      assert.strictEqual(record.outcome, "unmatched");
    }
  });

  test("rejects prototype-derived allowlist entries", () => {
    const sink = new TestSink();
    const diagnostics = new ACPDiagnostics(sink, () => true);
    diagnostics.record(
      "client->agent",
      message({ jsonrpc: "2.0", id: 1, method: "toString", params: {} })
    );
    diagnostics.record(
      "agent->client",
      message({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "toString" } },
      })
    );

    const records = sink.lines.map((line) => JSON.parse(line));
    assert.strictEqual(records[0].method, "unknown");
    assert.strictEqual(records[1].metadata.updateType, "unknown");
  });

  for (const teardown of ["eof", "cancel", "close"] as const) {
    test(`clears pending correlations on transport ${teardown}`, async () => {
      const sink = new TestSink();
      const diagnostics = new ACPDiagnostics(sink, () => true);
      const first = controlledStream();
      const firstWrapped = diagnostics.wrap(first.stream);
      const firstWriter = firstWrapped.writable.getWriter();
      const firstReader = firstWrapped.readable.getReader();
      await firstWriter.write(
        message({
          jsonrpc: "2.0",
          id: "shared-id",
          method: "session/prompt",
          params: {},
        })
      );

      if (teardown === "eof") {
        first.end();
        assert.strictEqual((await firstReader.read()).done, true);
        await firstWriter.close();
      } else if (teardown === "cancel") {
        await firstReader.cancel();
        await firstWriter.close();
      } else {
        await firstWriter.close();
        await firstReader.cancel();
      }

      const replacement = controlledStream();
      const replacementWrapped = diagnostics.wrap(replacement.stream);
      const replacementReader = replacementWrapped.readable.getReader();
      replacement.push(
        message({ jsonrpc: "2.0", id: "shared-id", result: {} })
      );
      await replacementReader.read();
      await replacementReader.cancel();

      const response = JSON.parse(sink.lines.at(-1)!);
      assert.strictEqual(response.method, "unknown");
      assert.strictEqual(response.correlation, null);
      assert.strictEqual(response.outcome, "unmatched");
    });
  }

  test("registers diagnostics and lifecycle commands", async () => {
    const extension = vscode.extensions.getExtension("omercnet.vscode-acp");
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "vscode-acp.showDiagnostics",
      "vscode-acp.restartAgent",
      "vscode-acp.disconnectAgent",
    ]) {
      assert.ok(commands.includes(command), `${command} was not registered`);
    }
  });
});
