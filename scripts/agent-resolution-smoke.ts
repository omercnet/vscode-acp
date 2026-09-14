#!/usr/bin/env npx tsx
/**
 * End-to-end demonstration that agent discovery and launch never execute a
 * workspace-controlled file. Every case uses the real filesystem and, where a
 * launch is expected, really spawns the resolved command with `shell: false`.
 */
import { spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";
import {
  createAgentEnvironment,
  resolveAgentCommand,
} from "../src/acp/agentCommand";

const windows = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "acp-agent-resolution-"));
const workspace = join(root, "untrusted-workspace");
const workspaceBin = join(workspace, "node_modules", ".bin");
const trustedBin = join(root, "Program Files", "OpenCode", "bin");
const nodeDirectory = dirname(process.execPath);
const excludedDirectories = [workspace];
const failures: string[] = [];

mkdirSync(workspaceBin, { recursive: true });
mkdirSync(trustedBin, { recursive: true });

function writeAgent(directory: string, label: string): void {
  if (windows) {
    writeFileSync(
      join(directory, "cli.js"),
      `console.log("${label}");\nconsole.log(process.env.PATH ?? "");\n`
    );
    writeFileSync(
      join(directory, "opencode.cmd"),
      [
        "@ECHO off",
        'SETLOCAL & SET "dp0=%~dp0"',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        ")",
        '"%_prog%"  "%dp0%\\cli.js" %*',
        "",
      ].join("\r\n")
    );
    return;
  }
  const executable = join(directory, "opencode");
  writeFileSync(executable, `#!/bin/sh\necho "${label}"\necho "$PATH"\n`);
  chmodSync(executable, 0o755);
}

function check(name: string, passed: boolean, detail: string): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
  if (!passed) {
    failures.push(name);
  }
}

writeAgent(workspaceBin, "MALICIOUS-WORKSPACE-AGENT");
writeAgent(trustedBin, "TRUSTED-AGENT");

// 1. A workspace copy that precedes the trusted install on PATH, plus the
//    current directory and empty/relative entries Windows would otherwise probe.
process.chdir(workspaceBin);
const searchPath = [
  "",
  ".",
  "node_modules/.bin",
  workspaceBin,
  trustedBin,
  nodeDirectory,
].join(delimiter);
const launch = resolveAgentCommand("opencode", ["acp"], {
  env: { ...process.env, PATH: searchPath, Path: searchPath },
  excludedDirectories,
});
check(
  "workspace executable is never selected",
  launch !== undefined && !launch.command.startsWith(workspace),
  `resolved ${launch?.command ?? "<none>"} (${launch?.source ?? "unavailable"})`
);

// 2. The resolved command really launches, with a sanitized PATH and no shell.
const environment = createAgentEnvironment({
  env: { ...process.env, PATH: searchPath, Path: searchPath },
  excludedDirectories,
});
const started = launch
  ? spawnSync(launch.command, launch.args, {
      shell: false,
      encoding: "utf8",
      env: environment,
    })
  : undefined;
const output = started?.stdout ?? "";
check(
  "launch executes the trusted installation",
  output.includes("TRUSTED-AGENT") && !output.includes("MALICIOUS"),
  `stdout: ${output.split(/\r?\n/)[0] || started?.error?.message || "<none>"}`
);
check(
  "child PATH cannot re-enter the workspace through an env shebang",
  !output.toLowerCase().includes(workspace.toLowerCase()) &&
    !(environment.PATH ?? "").toLowerCase().includes(workspace.toLowerCase()),
  `child PATH entries: ${(environment.PATH ?? "").split(delimiter).length}`
);

// 3. A workspace link that points outside the workspace stays excluded.
const escapeLink = join(workspace, "escape-bin");
symlinkSync(trustedBin, escapeLink, "junction");
const linked = resolveAgentCommand("opencode", ["acp"], {
  env: { ...process.env, PATH: escapeLink, Path: escapeLink },
  excludedDirectories,
});
check(
  "workspace link escaping the excluded root is rejected",
  linked === undefined,
  `resolved ${linked?.command ?? "<none>"}`
);

// 4. An explicit absolute path stays available for user configuration.
const explicitCommand = join(trustedBin, windows ? "opencode.cmd" : "opencode");
const explicit = resolveAgentCommand(explicitCommand, [], {
  env: { ...process.env, PATH: nodeDirectory, Path: nodeDirectory },
  excludedDirectories,
});
check(
  "explicit absolute installation remains launchable",
  explicit !== undefined,
  `resolved ${explicit?.command ?? "<none>"} (${explicit?.source ?? "unavailable"})`
);

console.log(
  `\n${failures.length === 0 ? "SMOKE OK" : "SMOKE FAILED"} on ${process.platform}`
);
process.exit(failures.length === 0 ? 0 : 1);
