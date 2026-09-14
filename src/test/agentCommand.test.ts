import * as assert from "assert";
import {
  createAgentEnvironment,
  resolveAgentCommand,
  type AgentCommandFileSystem,
} from "../acp/agentCommand";
function fakeFileSystem(
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string | true>>,
  canonicalPaths: Readonly<Record<string, string>> = {}
): AgentCommandFileSystem {
  const normalize = (path: string) =>
    platform === "win32" ? path.replace(/\//g, "\\").toLowerCase() : path;
  const normalizedFiles = new Map(
    Object.entries(files).map(([path, contents]) => [normalize(path), contents])
  );
  const normalizedCanonicalPaths = new Map(
    Object.entries(canonicalPaths).map(([path, target]) => [
      normalize(path),
      target,
    ])
  );

  return {
    isFile(path) {
      return normalizedFiles.has(normalize(path));
    },
    isExecutable(path) {
      return normalizedFiles.has(normalize(path));
    },
    readText(path) {
      const contents = normalizedFiles.get(normalize(path));
      return typeof contents === "string" ? contents : undefined;
    },
    realpath(path) {
      const normalized = normalize(path);
      const canonical = normalizedCanonicalPaths.get(normalized);
      if (canonical) {
        return canonical;
      }
      if (!normalizedFiles.has(normalized)) {
        throw new Error("missing file");
      }
      return path;
    },
  };
}

suite("agent command resolution", () => {
  test("resolves a POSIX command to an absolute PATH executable", () => {
    const result = resolveAgentCommand("opencode", ["acp"], {
      platform: "linux",
      env: { PATH: "/opt/opencode/bin:/usr/bin" },
      fileSystem: fakeFileSystem("linux", {
        "/opt/opencode/bin/opencode": true,
      }),
    });

    assert.deepStrictEqual(result, {
      command: "/opt/opencode/bin/opencode",
      args: ["acp"],
      cwd: "/opt/opencode/bin",
      source: "PATH executable",
    });
  });

  test("never searches empty or relative PATH entries", () => {
    const result = resolveAgentCommand("opencode", ["acp"], {
      platform: "linux",
      env: { PATH: ":./bin:bin:/trusted/bin" },
      fileSystem: fakeFileSystem("linux", {
        "/workspace/opencode": true,
        "/workspace/bin/opencode": true,
        "/trusted/bin/opencode": true,
      }),
    });

    assert.strictEqual(result?.command, "/trusted/bin/opencode");
  });

  test("sanitizes PATH inherited by env-based shebang interpreters", () => {
    const environment = createAgentEnvironment({
      platform: "linux",
      env: {
        PATH: ":relative:/workspace/bin:/linked-bin:/usr/bin",
        AGENT_TEST_VALUE: "preserved",
      },
      excludedDirectories: ["/workspace"],
      fileSystem: {
        isFile: () => false,
        isExecutable: () => false,
        readText: () => undefined,
        realpath(path) {
          if (path === "/linked-bin") {
            return "/workspace/bin";
          }
          return path;
        },
      },
    });

    assert.deepStrictEqual(environment, {
      PATH: "/usr/bin",
      AGENT_TEST_VALUE: "preserved",
    });
  });

  test("removes cwd search when no safe PATH directory remains", () => {
    const environment = createAgentEnvironment({
      platform: "linux",
      env: { PATH: ":relative", AGENT_TEST_VALUE: "preserved" },
      fileSystem: fakeFileSystem("linux", {}),
    });

    assert.deepStrictEqual(environment, {
      AGENT_TEST_VALUE: "preserved",
    });
  });

  test("skips untrusted workspace PATH entries and symlink targets", () => {
    const result = resolveAgentCommand("opencode", [], {
      platform: "win32",
      env: {
        Path: "C:\\workspace\\bin;C:\\trusted\\bin",
        PATHEXT: ".EXE;.CMD",
      },
      excludedDirectories: ["C:\\workspace"],
      fileSystem: fakeFileSystem(
        "win32",
        {
          "C:\\workspace\\bin\\opencode.exe": true,
          "C:\\trusted\\bin\\opencode.exe": true,
        },
        {
          "C:\\workspace\\bin\\opencode.exe":
            "C:\\workspace\\payload\\opencode.exe",
        }
      ),
    });

    assert.strictEqual(result?.command, "C:\\trusted\\bin\\opencode.exe");
  });

  test("does not probe the Windows working directory before PATH", () => {
    const result = resolveAgentCommand("opencode", [], {
      platform: "win32",
      env: { Path: "C:\\trusted\\bin", PATHEXT: ".EXE;.CMD" },
      fileSystem: fakeFileSystem("win32", {
        "C:\\workspace\\opencode.exe": true,
        "C:\\trusted\\bin\\opencode.exe": true,
      }),
    });

    assert.strictEqual(result?.command, "C:\\trusted\\bin\\opencode.exe");
  });

  test("prefers native Windows executables over command shims", () => {
    const result = resolveAgentCommand("opencode", ["acp"], {
      platform: "win32",
      env: { Path: "C:\\trusted\\bin", PATHEXT: ".CMD;.EXE" },
      fileSystem: fakeFileSystem("win32", {
        "C:\\trusted\\bin\\opencode.cmd": "malicious commands",
        "C:\\trusted\\bin\\opencode.exe": true,
      }),
    });

    assert.deepStrictEqual(result, {
      command: "C:\\trusted\\bin\\opencode.exe",
      args: ["acp"],
      cwd: "C:\\trusted\\bin",
      source: "PATH executable",
    });
  });

  test("honors PATHEXT and unwraps npm command shims without a shell", () => {
    const shim = [
      "@ECHO off",
      'SET "_prog=%dp0%\\node.exe"',
      'SET "_prog=node"',
      '"%_prog%" "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*',
    ].join("\r\n");
    const result = resolveAgentCommand(
      "npx",
      ["@zed-industries/claude-code-acp"],
      {
        platform: "win32",
        env: {
          Path: "C:\\workspace;C:\\Program Files\\nodejs",
          PATHEXT: ".CMD;.EXE",
        },
        excludedDirectories: ["C:\\workspace"],
        fileSystem: fakeFileSystem("win32", {
          "C:\\workspace\\npx.cmd": "malicious",
          "C:\\Program Files\\nodejs\\npx.cmd": shim,
          "C:\\Program Files\\nodejs\\node.exe": true,
          "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js": true,
        }),
      }
    );

    assert.deepStrictEqual(result, {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
        "@zed-industries/claude-code-acp",
      ],
      cwd: "C:\\Program Files\\nodejs",
      source: "Windows command shim",
    });
  });

  test("allows an explicit absolute executable chosen by the user", () => {
    const result = resolveAgentCommand(
      "C:\\workspace\\tools\\opencode.exe",
      ["acp"],
      {
        platform: "win32",
        env: { Path: "C:\\trusted\\bin", PATHEXT: ".EXE" },
        excludedDirectories: ["C:\\workspace"],
        fileSystem: fakeFileSystem("win32", {
          "C:\\workspace\\tools\\opencode.exe": true,
        }),
      }
    );

    assert.strictEqual(result?.command, "C:\\workspace\\tools\\opencode.exe");
    assert.strictEqual(result?.source, "explicit executable");
  });

  test("rejects relative command paths", () => {
    const result = resolveAgentCommand(".\\tools\\opencode.exe", [], {
      platform: "win32",
      env: { Path: "C:\\trusted\\bin", PATHEXT: ".EXE" },
      fileSystem: fakeFileSystem("win32", {
        "C:\\workspace\\tools\\opencode.exe": true,
      }),
    });

    assert.strictEqual(result, undefined);
  });

  test("rejects a workspace link whose target escapes the excluded root", () => {
    const result = resolveAgentCommand("opencode", ["acp"], {
      platform: "win32",
      env: {
        Path: "C:\\workspace\\node_modules\\.bin;C:\\trusted\\bin",
        PATHEXT: ".EXE",
      },
      excludedDirectories: ["C:\\workspace"],
      fileSystem: fakeFileSystem(
        "win32",
        {
          "C:\\workspace\\node_modules\\.bin\\opencode.exe": true,
          "C:\\trusted\\bin\\opencode.exe": true,
        },
        {
          "C:\\workspace\\node_modules\\.bin\\opencode.exe":
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        }
      ),
    });

    assert.strictEqual(result?.command, "C:\\trusted\\bin\\opencode.exe");
  });

  test("excludes extended-length spellings of the workspace root", () => {
    const result = resolveAgentCommand("opencode", [], {
      platform: "win32",
      env: { Path: "\\\\?\\C:\\workspace\\bin", PATHEXT: ".EXE" },
      excludedDirectories: ["C:\\workspace"],
      fileSystem: fakeFileSystem("win32", {
        "\\\\?\\C:\\workspace\\bin\\opencode.exe": true,
      }),
    });

    assert.strictEqual(result, undefined);
  });

  test("excludes forward-slash extended workspace paths", () => {
    const result = resolveAgentCommand("opencode", [], {
      platform: "win32",
      env: { Path: "//?/C:/workspace/bin", PATHEXT: ".EXE" },
      excludedDirectories: ["C:\\workspace"],
      fileSystem: fakeFileSystem("win32", {
        "//?/C:/workspace/bin/opencode.exe": true,
      }),
    });

    assert.strictEqual(result, undefined);
  });

  test("rejects a trusted-looking link into the workspace", () => {
    const result = resolveAgentCommand("opencode", [], {
      platform: "win32",
      env: { Path: "C:\\trusted-link", PATHEXT: ".EXE" },
      excludedDirectories: ["C:\\workspace"],
      fileSystem: fakeFileSystem(
        "win32",
        { "C:\\trusted-link\\opencode.exe": true },
        {
          "C:\\trusted-link\\opencode.exe": "C:\\workspace\\bin\\opencode.exe",
        }
      ),
    });

    assert.strictEqual(result, undefined);
  });

  test("removes PATH links that resolve into the workspace", () => {
    const environment = createAgentEnvironment({
      platform: "win32",
      env: { Path: "C:\\trusted-link;C:\\Windows\\System32" },
      excludedDirectories: ["C:\\workspace"],
      fileSystem: fakeFileSystem(
        "win32",
        {},
        {
          "C:\\trusted-link": "C:\\workspace\\bin",
          "C:\\Windows\\System32": "C:\\Windows\\System32",
        }
      ),
    });

    assert.strictEqual(environment.PATH, "C:\\Windows\\System32");
  });

  test("ignores Windows drive-relative PATH roots", () => {
    const result = resolveAgentCommand("opencode", [], {
      platform: "win32",
      env: { Path: "\\dropbox\\bin;C:\\trusted\\bin", PATHEXT: ".EXE" },
      fileSystem: fakeFileSystem("win32", {
        "\\dropbox\\bin\\opencode.exe": true,
        "C:\\trusted\\bin\\opencode.exe": true,
      }),
    });

    assert.strictEqual(result?.command, "C:\\trusted\\bin\\opencode.exe");
  });

  test("keeps interpreter arguments that a command shim supplies", () => {
    const shim = [
      "@ECHO off",
      'SET "_prog=%dp0%\\node.exe"',
      '"%_prog%"  "%dp0%\\cli.js" --no-deprecation %*',
    ].join("\r\n");
    const result = resolveAgentCommand("agent", ["acp"], {
      platform: "win32",
      env: { Path: "C:\\tools", PATHEXT: ".CMD;.EXE" },
      fileSystem: fakeFileSystem("win32", {
        "C:\\tools\\agent.cmd": shim,
        "C:\\tools\\node.exe": true,
        "C:\\tools\\cli.js": true,
      }),
    });

    assert.deepStrictEqual(result?.args, [
      "C:\\tools\\cli.js",
      "--no-deprecation",
      "acp",
    ]);
  });

  test("refuses command shims that inject shell operators", () => {
    const shim = [
      "@ECHO off",
      'SET "_prog=%dp0%\\node.exe"',
      '"%_prog%"  "%dp0%\\cli.js" & calc.exe %*',
    ].join("\r\n");
    const result = resolveAgentCommand("agent", [], {
      platform: "win32",
      env: { Path: "C:\\tools", PATHEXT: ".CMD;.EXE" },
      fileSystem: fakeFileSystem("win32", {
        "C:\\tools\\agent.cmd": shim,
        "C:\\tools\\node.exe": true,
        "C:\\tools\\cli.js": true,
      }),
    });

    assert.strictEqual(result, undefined);
  });

  test("rejects a filesystem result that is not an absolute launch path", () => {
    const result = resolveAgentCommand("opencode", [], {
      platform: "linux",
      env: { PATH: "/trusted/bin" },
      fileSystem: {
        isFile: () => true,
        isExecutable: () => true,
        readText: () => undefined,
        realpath: () => "relative/opencode",
      },
    });

    assert.strictEqual(result, undefined);
  });
});
