import * as assert from "assert";
import * as vscode from "vscode";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  getMcpConfigurationResource,
  McpConfigurationError,
  McpSecretRedactor,
  validateMcpServers,
} from "../acp/mcp";

suite("MCP server configuration", () => {
  test("preserves remote workspace URIs for resource-scoped settings", () => {
    const remoteUri = vscode.Uri.parse(
      "vscode-remote://ssh-remote+host/workspace"
    );
    const workspaceFolder = {
      index: 0,
      name: "remote",
      uri: remoteUri,
    };

    assert.strictEqual(
      getMcpConfigurationResource(remoteUri.fsPath, [workspaceFolder]),
      remoteUri
    );
  });

  test("uses the exact resource when workspace fsPaths collide", () => {
    const localUri = vscode.Uri.file("/workspace");
    const remoteUri = vscode.Uri.parse(
      "vscode-remote://ssh-remote+host/workspace"
    );
    const workspaceFolders = [
      { index: 0, name: "local", uri: localUri },
      { index: 1, name: "remote", uri: remoteUri },
    ];

    assert.strictEqual(
      getMcpConfigurationResource(
        remoteUri.fsPath,
        workspaceFolders,
        remoteUri
      ),
      remoteUri
    );
    assert.strictEqual(
      getMcpConfigurationResource(remoteUri.fsPath, workspaceFolders).scheme,
      "file"
    );
  });

  test("validates and converts stdio configuration to SDK 1.4 types", () => {
    const servers = validateMcpServers(
      [
        {
          name: "filesystem",
          command: process.execPath,
          args: ["server.js", "--stdio"],
          env: [{ name: "MODE", value: "readonly" }],
        },
      ],
      {}
    );

    assert.deepStrictEqual(servers, [
      {
        name: "filesystem",
        command: process.execPath,
        args: ["server.js", "--stdio"],
        env: [{ name: "MODE", value: "readonly" }],
      },
    ]);
  });

  test("classifies malformed entries", () => {
    assertMcpError(
      () => validateMcpServers([{ name: "missing-command" }], {}),
      "MCP_CONFIG_MALFORMED"
    );
    assertMcpError(
      () =>
        validateMcpServers(
          [
            {
              name: "legacy-shape",
              command: process.execPath,
              env: { TOKEN: "value" },
            },
          ],
          {}
        ),
      "MCP_CONFIG_MALFORMED"
    );
    assertMcpError(
      () =>
        validateMcpServers(
          [{ type: "websocket", name: "unsupported-shape" }],
          {}
        ),
      "MCP_CONFIG_UNSUPPORTED"
    );
  });

  test("rejects duplicate server names case-insensitively", () => {
    assertMcpError(
      () =>
        validateMcpServers(
          [
            { name: "Filesystem", command: process.execPath },
            { name: "filesystem", command: process.execPath },
          ],
          {}
        ),
      "MCP_CONFIG_DUPLICATE"
    );
  });

  test("rejects duplicate environment variable names", () => {
    assertMcpError(
      () =>
        validateMcpServers(
          [
            {
              name: "stdio",
              command: process.execPath,
              env: [
                { name: "TOKEN", value: "first" },
                { name: "token", value: "second" },
              ],
            },
          ],
          {}
        ),
      "MCP_CONFIG_DUPLICATE"
    );
  });

  test("rejects aggregate configurations that exceed the byte budget", () => {
    const env = Array.from({ length: 33 }, (_, index) => ({
      name: `VALUE_${index}`,
      value: "x".repeat(8_192),
    }));

    assertMcpError(
      () =>
        validateMcpServers(
          [{ name: "oversized", command: process.execPath, env }],
          {}
        ),
      "MCP_CONFIG_UNSAFE"
    );
  });

  test("rejects unsafe executable paths and remote URLs", () => {
    assertMcpError(
      () => validateMcpServers([{ name: "stdio", command: "npx" }], {}),
      "MCP_CONFIG_UNSAFE"
    );
    assertMcpError(
      () =>
        validateMcpServers(
          [{ type: "http", name: "remote", url: "http://example.com" }],
          { http: true }
        ),
      "MCP_CONFIG_UNSAFE"
    );
    assertMcpError(
      () =>
        validateMcpServers(
          [
            {
              type: "http",
              name: "remote",
              url: "https://user:password@example.com/mcp",
            },
          ],
          { http: true }
        ),
      "MCP_CONFIG_UNSAFE"
    );
    assertMcpError(
      () =>
        validateMcpServers(
          [
            {
              type: "http",
              name: "remote",
              url: "https://example.com/mcp#secret",
            },
          ],
          { http: true }
        ),
      "MCP_CONFIG_UNSAFE"
    );
  });

  test("resolves environment references freshly without mutating configuration", () => {
    const configuration = [
      {
        name: "stdio",
        command: process.execPath,
        env: [{ name: "TOKEN", value: "Bearer ${env:MCP_TOKEN}" }],
      },
    ];

    const first = validateMcpServers(configuration, {}, { MCP_TOKEN: "first" });
    const second = validateMcpServers(
      configuration,
      {},
      { MCP_TOKEN: "second" }
    );

    assert.deepStrictEqual(first[0], {
      name: "stdio",
      command: process.execPath,
      args: [],
      env: [{ name: "TOKEN", value: "Bearer first" }],
    });
    assert.deepStrictEqual(second[0], {
      name: "stdio",
      command: process.execPath,
      args: [],
      env: [{ name: "TOKEN", value: "Bearer second" }],
    });
    assert.strictEqual(
      configuration[0].env[0].value,
      "Bearer ${env:MCP_TOKEN}"
    );
  });

  test("does not register literal configuration values as secrets", () => {
    const sensitiveValues = new Set<string>();
    validateMcpServers(
      [
        {
          name: "stdio",
          command: process.execPath,
          env: [
            { name: "NO_COLOR", value: "1" },
            { name: "MODE", value: "readonly" },
          ],
        },
      ],
      {},
      {},
      sensitiveValues
    );

    assert.deepStrictEqual([...sensitiveValues], []);
  });

  test("requires advertised HTTP and SSE capabilities", () => {
    const http = {
      type: "http",
      name: "http-server",
      url: "https://example.com/mcp",
    };
    const sse = {
      type: "sse",
      name: "sse-server",
      url: "https://example.com/events",
    };

    assertMcpError(
      () => validateMcpServers([http], {}),
      "MCP_CONFIG_UNSUPPORTED"
    );
    assertMcpError(
      () => validateMcpServers([sse], { http: true }),
      "MCP_CONFIG_UNSUPPORTED"
    );
    assert.deepStrictEqual(validateMcpServers([http], { http: true }), [
      { ...http, url: "https://example.com/mcp", headers: [] },
    ]);
    assert.deepStrictEqual(validateMcpServers([sse], { sse: true }), [
      { ...sse, url: "https://example.com/events", headers: [] },
    ]);
  });

  test("substitutes remote header secrets and redacts failures", () => {
    const configuration = [
      {
        type: "http",
        name: "remote",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer ${env:MCP_TOKEN}" }],
      },
    ];

    const servers = validateMcpServers(
      configuration,
      { http: true },
      {
        MCP_TOKEN: "top-secret",
      }
    );

    assert.deepStrictEqual(servers[0], {
      type: "http",
      name: "remote",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer top-secret" }],
    });

    const secret = "top-secret\r\nInjected: true";
    assert.throws(
      () =>
        validateMcpServers(
          configuration,
          { http: true },
          { MCP_TOKEN: secret }
        ),
      (error) => {
        assert.ok(error instanceof McpConfigurationError);
        assert.strictEqual(error.code, "MCP_CONFIG_UNSAFE");
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.stack?.includes(secret));
        return true;
      }
    );
  });
  test("redacts both resolved tokens and their containing values", () => {
    const redactor = new McpSecretRedactor();
    redactor.add(["top-secret", "Bearer top-secret"]);
    const diagnostic = redactor.redact(
      "agent echoed Bearer top-secret and then top-secret"
    );

    assert.strictEqual(
      diagnostic,
      "agent echoed [redacted] and then [redacted]"
    );
    assert.ok(!diagnostic.includes("top-secret"));
  });

  test("preserves RequestError identity and code while dropping secret data", () => {
    const redactor = new McpSecretRedactor();
    redactor.add(["top-secret"]);

    const redacted = redactor.redactError(
      new RequestError(-32000, "Authentication failed", {
        token: "top-secret",
      })
    );

    assert.ok(redacted instanceof RequestError);
    assert.strictEqual(redacted.code, -32000);
    assert.strictEqual(redacted.message, "Authentication failed");
    assert.strictEqual(redacted.data, undefined);
  });

  test("reports missing environment variables without exposing values", () => {
    assertMcpError(
      () =>
        validateMcpServers(
          [
            {
              name: "stdio",
              command: process.execPath,
              env: [{ name: "TOKEN", value: "${env:NOT_SET}" }],
            },
          ],
          {}
        ),
      "MCP_CONFIG_ENV"
    );
  });
});

function assertMcpError(
  operation: () => unknown,
  code: McpConfigurationError["code"]
): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof McpConfigurationError);
    assert.strictEqual(error.code, code);
    assert.match(error.message, new RegExp(`^\\[${code}\\]`));
    assert.match(error.message, /vscode-acp\.mcpServers/);
    return true;
  });
}
