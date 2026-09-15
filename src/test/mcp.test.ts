import * as assert from "assert";
import * as vscode from "vscode";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  configureMcpServers,
  getConfiguredSession,
  getMcpConfigurationResource,
  getMcpProjectConfigurationUri,
  McpConfigurationError,
  McpSecretRedactor,
  parseMcpProjectConfiguration,
  selectMcpSettingSources,
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

  test("preserves a saved remote URI when another host has the same path", () => {
    const saved = vscode.Uri.parse("vscode-remote://ssh-remote+old/workspace");
    const replacement = vscode.Uri.parse(
      "vscode-remote://ssh-remote+new/workspace"
    );
    assert.strictEqual(
      getMcpConfigurationResource(
        saved.fsPath,
        [{ index: 0, name: "replacement", uri: replacement }],
        saved
      ),
      saved
    );
  });

  test("selects the exact remote folder for project configuration", () => {
    const localUri = vscode.Uri.file("/workspace");
    const remoteUri = vscode.Uri.parse(
      "vscode-remote://ssh-remote+host/workspace"
    );
    const workspaceFolders = [
      { index: 0, name: "local", uri: localUri },
      { index: 1, name: "remote", uri: remoteUri },
    ];

    const projectUri = getMcpProjectConfigurationUri(
      remoteUri.fsPath,
      workspaceFolders,
      remoteUri
    );
    assert.strictEqual(projectUri?.scheme, remoteUri.scheme);
    assert.strictEqual(projectUri?.authority, remoteUri.authority);
    assert.strictEqual(projectUri?.path, "/workspace/.vscode/mcp.json");
    assert.strictEqual(
      getMcpProjectConfigurationUri(remoteUri.fsPath, workspaceFolders),
      undefined
    );
  });

  test("never derives a project config path from an unrecognized resource", () => {
    const workspaceUri = vscode.Uri.file("/workspace");
    const workspaceFolders = [
      { index: 0, name: "workspace", uri: workspaceUri },
    ];

    assert.strictEqual(
      getMcpProjectConfigurationUri(
        "/outside",
        workspaceFolders,
        vscode.Uri.file("/outside")
      ),
      undefined
    );
    assert.strictEqual(
      getMcpProjectConfigurationUri(
        "/workspace/../../outside",
        workspaceFolders,
        workspaceUri
      )?.path,
      "/workspace/.vscode/mcp.json"
    );
  });

  test("excludes repository-controlled sources in Restricted Mode", () => {
    const inspected = {
      globalValue: [{ name: "user", command: process.execPath }],
      workspaceValue: [{ name: "workspace", command: process.execPath }],
      workspaceFolderValue: [{ name: "folder", command: process.execPath }],
    };

    assert.deepStrictEqual(
      selectMcpSettingSources(inspected, false).map(
        (source) => source.configuration
      ),
      [inspected.globalValue]
    );
    assert.deepStrictEqual(
      selectMcpSettingSources(inspected, true).map(
        (source) => source.configuration
      ),
      [
        inspected.globalValue,
        inspected.workspaceValue,
        inspected.workspaceFolderValue,
      ]
    );
  });

  test("preserves explicit invalid setting values for fail-closed validation", () => {
    const sources = selectMcpSettingSources(
      {
        globalValue: null,
        workspaceValue: null,
        workspaceFolderValue: null,
      },
      true
    );

    for (const source of sources) {
      assert.throws(
        () => configureMcpServers([source], {}),
        (error) =>
          error instanceof McpConfigurationError &&
          error.code === "MCP_CONFIG_MALFORMED"
      );
    }
  });

  test("parses the VS Code mcp.json convention through the ACP validator", () => {
    const parsed = parseMcpProjectConfiguration(
      new TextEncoder().encode(`{
        // Project MCP servers use the established VS Code object form.
        "servers": {
          "stdio": {
            "command": ${JSON.stringify(process.execPath)},
            "args": ["server.js"],
            "env": { "TOKEN": "${"${env:MCP_TOKEN}"}" },
          },
          "remote": {
            "type": "http",
            "url": "https://example.com/mcp",
            "headers": { "Authorization": "Bearer ${"${env:MCP_TOKEN}"}" },
          },
        },
      }`)
    );
    const sensitiveValues = new Set<string>();

    const configured = configureMcpServers(
      [{ location: ".vscode/mcp.json.servers", configuration: parsed }],
      { http: true },
      { MCP_TOKEN: "project-secret" },
      sensitiveValues
    );

    assert.deepStrictEqual(configured, [
      {
        name: "stdio",
        command: process.execPath,
        args: ["server.js"],
        env: [{ name: "TOKEN", value: "project-secret" }],
      },
      {
        type: "http",
        name: "remote",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer project-secret" }],
      },
    ]);
    assert.deepStrictEqual(
      [...sensitiveValues],
      ["project-secret", "Bearer project-secret"]
    );
    const reloaded = configureMcpServers(
      [{ location: ".vscode/mcp.json.servers", configuration: parsed }],
      { http: true },
      { MCP_TOKEN: "rotated-secret" }
    );
    assert.deepStrictEqual(reloaded[1], {
      type: "http",
      name: "remote",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer rotated-secret" }],
    });
    assert.match(JSON.stringify(parsed), /\$\{env:MCP_TOKEN\}/);
  });

  test("rejects duplicate JSONC properties before last-value parsing", () => {
    assert.throws(
      () =>
        parseMcpProjectConfiguration(
          new TextEncoder().encode(`{
            "servers": {
              "duplicate": { "command": ${JSON.stringify(process.execPath)} },
              "duplicate": { "command": "/unexpected/override" }
            }
          }`)
        ),
      (error) =>
        error instanceof McpConfigurationError &&
        error.code === "MCP_CONFIG_DUPLICATE"
    );
  });

  test("rejects malformed, non-UTF-8, and oversized project files", () => {
    const invalidInputs = [
      {
        contents: new TextEncoder().encode('{ "servers": {'),
        code: "MCP_CONFIG_MALFORMED",
      },
      {
        contents: Uint8Array.from([0xff]),
        code: "MCP_CONFIG_MALFORMED",
      },
      {
        contents: new Uint8Array(256 * 1024 + 1),
        code: "MCP_CONFIG_UNSAFE",
      },
    ] as const;

    for (const { contents, code } of invalidInputs) {
      assert.throws(
        () => parseMcpProjectConfiguration(contents),
        (error) => error instanceof McpConfigurationError && error.code === code
      );
    }
  });

  test("rejects excessive JSONC nesting before recursive parsing", () => {
    const contents = Buffer.from(
      '{"servers":' + "[".repeat(20_000) + "0" + "]".repeat(20_000) + "}"
    );
    assert.throws(
      () => parseMcpProjectConfiguration(contents),
      (error) =>
        error instanceof McpConfigurationError &&
        error.code === "MCP_CONFIG_UNSAFE"
    );
    const literal = "[".repeat(128);
    const parsed = parseMcpProjectConfiguration(
      Buffer.from(
        `/* ${literal} */` +
          JSON.stringify({
            servers: {
              safe: { command: process.execPath, args: [literal] },
            },
          })
      )
    );
    assert.deepStrictEqual(
      configureMcpServers([{ location: "project", configuration: parsed }], {}),
      [{ name: "safe", command: process.execPath, args: [literal], env: [] }]
    );
  });

  test("rejects wide JSONC arrays without exceeding the argument stack", () => {
    const contents = Buffer.from('{"servers":[' + "0,".repeat(131_000) + "0]}");
    assert.throws(
      () => parseMcpProjectConfiguration(contents),
      (error) =>
        error instanceof McpConfigurationError &&
        error.code === "MCP_CONFIG_MALFORMED"
    );
  });

  test("does not echo untrusted JSONC keys in configuration errors", () => {
    const secret = "credential-that-must-not-appear";
    for (const text of [
      `{"servers":{"one":{"headers":{"${secret}":1,"${secret}":2}}}}`,
      JSON.stringify({ servers: { [secret]: { name: "invalid" } } }),
      JSON.stringify({ servers: { one: { env: { [secret]: 42 } } } }),
    ]) {
      assert.throws(
        () => parseMcpProjectConfiguration(Buffer.from(text)),
        (error) => {
          assert.ok(error instanceof McpConfigurationError);
          assert.ok(!error.message.includes(secret));
          assert.ok(!error.stack?.includes(secret));
          return true;
        }
      );
    }
  });

  test("treats resolved environment values as opaque", () => {
    const configured = configureMcpServers(
      [
        {
          location: "user",
          configuration: [
            {
              name: "opaque-secret",
              command: process.execPath,
              env: [{ name: "TOKEN", value: "${env:FIRST}" }],
            },
          ],
        },
      ],
      {},
      { FIRST: "${env:SECOND}", SECOND: "must-not-replace" }
    );

    assert.deepStrictEqual(configured[0], {
      name: "opaque-secret",
      command: process.execPath,
      args: [],
      env: [{ name: "TOKEN", value: "${env:SECOND}" }],
    });
  });

  test("applies user, workspace, folder, then project precedence by name", () => {
    const configured = configureMcpServers(
      [
        {
          location: "user",
          configuration: [
            { name: "userOnly", command: process.execPath, args: ["user"] },
            { name: "Shared", command: process.execPath, args: ["user"] },
          ],
        },
        {
          location: "workspace",
          configuration: [
            {
              name: "workspaceOnly",
              command: process.execPath,
              args: ["workspace"],
            },
            {
              name: "shared",
              command: process.execPath,
              args: ["workspace"],
            },
          ],
        },
        {
          location: "folder",
          configuration: [
            {
              name: "folderOnly",
              command: process.execPath,
              args: ["folder"],
            },
          ],
        },
        {
          location: "project",
          configuration: [
            {
              name: "SHARED",
              command: process.execPath,
              args: ["project"],
            },
            {
              name: "projectOnly",
              command: process.execPath,
              args: ["project"],
            },
          ],
        },
      ],
      {}
    );

    assert.deepStrictEqual(
      configured.map((server) => ({
        name: server.name,
        marker: "args" in server ? server.args[0] : undefined,
      })),
      [
        { name: "userOnly", marker: "user" },
        { name: "SHARED", marker: "project" },
        { name: "workspaceOnly", marker: "workspace" },
        { name: "folderOnly", marker: "folder" },
        { name: "projectOnly", marker: "project" },
      ]
    );
  });

  test("rejects unsupported project schema with structured paths", () => {
    assert.throws(
      () =>
        parseMcpProjectConfiguration(
          new TextEncoder().encode(
            JSON.stringify({ servers: {}, inputs: [{ id: "secret" }] })
          )
        ),
      (error) => {
        assert.ok(error instanceof McpConfigurationError);
        assert.strictEqual(error.code, "MCP_CONFIG_MALFORMED");
        assert.match(error.message, /^\[MCP_CONFIG_MALFORMED\]/);
        assert.match(error.message, /\.vscode\/mcp\.json/);
        return true;
      }
    );
  });

  test("attributes project validation failures to the project source", () => {
    const parsed = parseMcpProjectConfiguration(
      new TextEncoder().encode(
        JSON.stringify({ servers: { unsafe: { command: "npx" } } })
      )
    );

    assert.throws(
      () =>
        configureMcpServers(
          [{ location: ".vscode/mcp.json.servers", configuration: parsed }],
          {}
        ),
      (error) => {
        assert.ok(error instanceof McpConfigurationError);
        assert.strictEqual(error.code, "MCP_CONFIG_UNSAFE");
        assert.match(
          error.message,
          /\.vscode\/mcp\.json\.servers\[0\]\.command/
        );
        return true;
      }
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

  test("rejects Windows scripts that trigger an implicit command shell", function () {
    if (process.platform !== "win32") this.skip();
    for (const extension of [".cmd", ".bat", ".js"]) {
      assertMcpError(
        () =>
          validateMcpServers(
            [
              {
                name: "script",
                command: process.execPath + extension,
                args: ["literal&argument"],
              },
            ],
            {}
          ),
        "MCP_CONFIG_UNSAFE"
      );
    }
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

  test("redacts resolved secrets when agent errors JSON-escape them", () => {
    const values = new Set<string>();
    const servers = validateMcpServers(
      [
        {
          name: "stdio",
          command: process.execPath,
          env: [{ name: "TOKEN", value: "${env:TOKEN}" }],
        },
      ],
      {},
      { TOKEN: 'secret"with\\slashes\nand-lines' },
      values
    );
    const redactor = new McpSecretRedactor();
    redactor.add(values);
    const redacted = redactor.redactError(
      new RequestError(-32000, JSON.stringify(servers))
    );
    const logged = JSON.parse(redacted.message);
    assert.strictEqual(logged[0].env[0].value, "[redacted]");
    assert.strictEqual((redacted as RequestError).code, -32000);
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

  suite("project file loading", () => {
    let filesystemDescriptor: PropertyDescriptor;
    let originalConfiguration: typeof vscode.workspace.getConfiguration;
    let trustDescriptor: PropertyDescriptor;
    let reads: number;
    let stats: number;
    let contents: Uint8Array;
    let metadata: vscode.FileStat;
    let trusted: boolean;

    setup(() => {
      filesystemDescriptor = Object.getOwnPropertyDescriptor(
        vscode.workspace,
        "fs"
      )!;
      originalConfiguration = vscode.workspace.getConfiguration;
      trustDescriptor = Object.getOwnPropertyDescriptor(
        vscode.workspace,
        "isTrusted"
      )!;
      trusted = true;
      reads = 0;
      stats = 0;
      contents = Buffer.from(
        JSON.stringify({
          servers: {
            project: { command: process.execPath },
          },
        })
      );
      metadata = {
        type: vscode.FileType.File,
        size: contents.byteLength,
        ctime: 0,
        mtime: 0,
      };
      Object.defineProperty(vscode.workspace, "isTrusted", {
        configurable: true,
        get: () => trusted,
      });
      Object.defineProperty(vscode.workspace, "fs", {
        configurable: true,
        value: {
          ...vscode.workspace.fs,
          stat: async () => {
            stats++;
            return metadata;
          },
          readFile: async () => {
            reads++;
            return contents;
          },
        },
      });
    });

    teardown(() => {
      Object.defineProperty(vscode.workspace, "fs", filesystemDescriptor);
      vscode.workspace.getConfiguration = originalConfiguration;
      Object.defineProperty(vscode.workspace, "isTrusted", trustDescriptor);
    });

    function loadProject() {
      const folder = vscode.workspace.workspaceFolders![0];
      return getConfiguredSession(folder.uri.fsPath, {}, {}, folder.uri);
    }

    test("does not inherit another folder's settings for a missing saved URI", async () => {
      const folder = vscode.workspace.workspaceFolders![0];
      const saved = folder.uri.with({
        scheme: "vscode-remote",
        authority: "ssh-remote+removed",
      });
      vscode.workspace.getConfiguration = () =>
        ({
          inspect: () => ({
            globalValue: [{ name: "user", command: process.execPath }],
            workspaceValue: [
              { name: "other-workspace", command: process.execPath },
            ],
            workspaceFolderValue: [
              { name: "other-folder", command: process.execPath },
            ],
          }),
        }) as unknown as vscode.WorkspaceConfiguration;
      const configured = await getConfiguredSession(
        folder.uri.fsPath,
        {},
        {},
        saved
      );
      assert.deepStrictEqual(
        configured.parameters.mcpServers.map((server) => server.name),
        ["user"]
      );
      assert.strictEqual(stats, 0);
      assert.strictEqual(reads, 0);
    });

    test("refuses an oversized project before reading its bytes", async () => {
      metadata.size = 256 * 1024 + 1;
      await assert.rejects(
        loadProject(),
        (error) =>
          error instanceof McpConfigurationError &&
          error.code === "MCP_CONFIG_UNSAFE"
      );
      assert.strictEqual(reads, 0);
    });

    test("rejects a project that grows past its stat size", async () => {
      contents = new Uint8Array(256 * 1024 + 1);
      await assert.rejects(
        loadProject(),
        (error) =>
          error instanceof McpConfigurationError &&
          error.code === "MCP_CONFIG_UNSAFE"
      );
    });

    test("refuses directories and special files without reading them", async () => {
      for (const type of [vscode.FileType.Directory, vscode.FileType.Unknown]) {
        metadata.type = type;
        await assert.rejects(
          loadProject(),
          (error) =>
            error instanceof McpConfigurationError &&
            error.code === "MCP_CONFIG_READ"
        );
      }
      assert.strictEqual(reads, 0);
    });

    test("ignores project files in Restricted Mode", async () => {
      trusted = false;
      const configured = await loadProject();
      assert.deepStrictEqual(configured.parameters.mcpServers, []);
      assert.strictEqual(stats, 0);
      assert.strictEqual(reads, 0);
    });

    test("does not read a project after trust changes during stat", async () => {
      vscode.workspace.fs.stat = async () => {
        trusted = false;
        return metadata;
      };
      const configured = await loadProject();
      assert.deepStrictEqual(configured.parameters.mcpServers, []);
      assert.strictEqual(reads, 0);
    });

    test("discards project contents after trust changes during read", async () => {
      vscode.workspace.fs.readFile = async () => {
        trusted = false;
        return contents;
      };
      const configured = await loadProject();
      assert.deepStrictEqual(configured.parameters.mcpServers, []);
    });

    test("ignores absent files but fails closed on provider read errors", async () => {
      vscode.workspace.fs.stat = async () => {
        throw vscode.FileSystemError.FileNotFound();
      };
      assert.deepStrictEqual((await loadProject()).parameters.mcpServers, []);
      vscode.workspace.fs.stat = async () => metadata;
      vscode.workspace.fs.readFile = async () => {
        throw vscode.FileSystemError.NoPermissions("provider-secret");
      };
      await assert.rejects(loadProject(), (error) => {
        assert.ok(error instanceof McpConfigurationError);
        assert.strictEqual(error.code, "MCP_CONFIG_READ");
        assert.ok(!error.message.includes("provider-secret"));
        return true;
      });
    });
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
