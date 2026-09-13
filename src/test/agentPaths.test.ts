import * as assert from "assert";
import { selectAgentPaths } from "../acp/agentPaths";

suite("agent executable path configuration", () => {
  test("ignores workspace executable overrides in Restricted Mode", () => {
    const selected = selectAgentPaths(
      {
        globalValue: {
          opencode: "C:\\trusted\\opencode.exe",
          "claude-code": "C:\\trusted\\claude.exe",
        },
        workspaceValue: {
          opencode: "C:\\workspace\\opencode.exe",
        },
        workspaceFolderValue: {
          "claude-code": "C:\\workspace\\npx.cmd",
        },
      },
      false
    );

    assert.deepStrictEqual(
      { ...selected },
      {
        opencode: "C:\\trusted\\opencode.exe",
        "claude-code": "C:\\trusted\\claude.exe",
      }
    );
  });

  test("applies workspace executable overrides after trust is granted", () => {
    const selected = selectAgentPaths(
      {
        globalValue: { opencode: "/usr/local/bin/opencode" },
        workspaceValue: { opencode: "/opt/team/bin/opencode" },
      },
      true
    );

    assert.strictEqual(selected.opencode, "/opt/team/bin/opencode");
  });
});
