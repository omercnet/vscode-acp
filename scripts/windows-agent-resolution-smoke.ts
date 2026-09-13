import { strict as assert } from "assert";
import {
  resolveAgentCommand,
  type AgentCommandFileSystem,
} from "../src/acp/agentCommand";

const malicious = "C:\\workspace\\opencode.exe";
const trusted = "C:\\Program Files\\OpenCode\\opencode.exe";
const files = new Set([malicious.toLowerCase(), trusted.toLowerCase()]);
const fileSystem: AgentCommandFileSystem = {
  isFile: (path) => files.has(path.toLowerCase()),
  isExecutable: (path) => files.has(path.toLowerCase()),
  readText: () => undefined,
  realpath: (path) => path,
};

const launch = resolveAgentCommand("opencode", ["acp"], {
  platform: "win32",
  env: {
    Path: "C:\\workspace;C:\\Program Files\\OpenCode",
    PATHEXT: ".EXE;.CMD",
  },
  excludedDirectories: ["C:\\workspace"],
  fileSystem,
});

assert.equal(launch?.command, trusted);
assert.equal(launch?.source, "PATH executable");
console.log(
  "PASS: Windows agent discovery ignored the untrusted workspace and selected a trusted absolute executable."
);
