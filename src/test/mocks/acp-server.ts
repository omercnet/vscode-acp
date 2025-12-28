import { EventEmitter, Readable, Writable } from "stream";
import * as acp from "@agentclientprotocol/sdk";

export type DemoMode = "ansi" | "plan" | "default";

interface MockSession {
  id: string;
  cwd: string;
  pendingPrompt: AbortController | null;
}

export class MockACPServer {
  private sessions: Map<string, MockSession> = new Map();
  private sessionCounter = 0;
  private demoMode: DemoMode;

  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private stdinBuffer = "";

  constructor(demoMode: DemoMode = "default") {
    this.demoMode = demoMode;

    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinBuffer += chunk.toString();
        this.processInput();
        callback();
      },
    });

    this.stdout = new Readable({
      read() {},
    });

    this.stderr = new Readable({
      read() {},
    });
  }

  private processInput(): void {
    const lines = this.stdinBuffer.split("\n");
    this.stdinBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        try {
          const request = JSON.parse(line);
          this.handleRequest(request);
        } catch {
          console.error("[MockACP] Failed to parse:", line);
        }
      }
    }
  }

  private handleRequest(request: {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: Record<string, unknown>;
  }): void {
    switch (request.method) {
      case "initialize":
        this.sendResponse(request.id, {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
        });
        break;
      case "session/new":
        this.handleNewSession(request.id, request.params);
        break;
      case "session/prompt":
        void this.handlePrompt(request.id, request.params);
        break;
      case "session/set_mode":
      case "session/set_model":
        this.sendResponse(request.id, {});
        break;
      case "session/cancel":
        this.handleCancel(request.id, request.params);
        break;
      default:
        this.sendError(request.id, -32601, `Unknown method: ${request.method}`);
    }
  }

  private handleNewSession(id: number, params?: Record<string, unknown>): void {
    const sessionId = `mock-session-${++this.sessionCounter}`;
    const cwd = (params?.cwd as string) || process.cwd();

    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      pendingPrompt: null,
    });

    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        {
          name: "web",
          description: "Search the web",
          input: { hint: "query" },
        },
        { name: "test", description: "Run tests" },
        {
          name: "plan",
          description: "Create a plan",
          input: { hint: "description" },
        },
      ],
    });

    const response: acp.NewSessionResponse = {
      sessionId,
      modes: {
        availableModes: [
          { id: "code", name: "Code" },
          { id: "architect", name: "Architect" },
        ],
        currentModeId: "code",
      },
      models: {
        availableModels: [
          { modelId: "claude-3-sonnet", name: "Claude 3 Sonnet" },
          { modelId: "claude-3-opus", name: "Claude 3 Opus" },
        ],
        currentModelId: "claude-3-sonnet",
      },
    };

    this.sendResponse(id, response);
  }

  private async handlePrompt(
    id: number,
    params?: Record<string, unknown>
  ): Promise<void> {
    const sessionId = params?.sessionId as string | undefined;
    const session = sessionId ? this.sessions.get(sessionId) : null;

    if (!session) {
      this.sendError(id, -32000, "Session not found");
      return;
    }

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();

    try {
      switch (this.demoMode) {
        case "ansi":
          await this.demoAnsiOutput(session.id);
          break;
        case "plan":
          await this.demoPlanDisplay(session.id);
          break;
        default:
          await this.demoDefault(session.id);
      }
    } catch (error) {
      if (session.pendingPrompt?.signal.aborted) {
        this.sendResponse(id, { stopReason: "cancelled" });
        return;
      }
      this.sendError(id, -32603, `Demo error: ${error}`);
      return;
    }

    session.pendingPrompt = null;
    this.sendResponse(id, { stopReason: "end_turn" });
  }

  private async demoDefault(sessionId: string): Promise<void> {
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello! " },
    });
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I'm a mock response." },
    });
  }

  private async demoAnsiOutput(sessionId: string): Promise<void> {
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Running tests to check the codebase..." },
    });

    await this.delay(300);

    const toolCallId = `tool-${Date.now()}`;
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Running tests",
      kind: "execute" satisfies acp.ToolKind,
      status: "in_progress" satisfies acp.ToolCallStatus,
      rawInput: { command: "npm test" },
    });

    await this.delay(500);

    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed" satisfies acp.ToolCallStatus,
      rawOutput: {
        output: [
          "",
          "\x1b[1m PASS \x1b[0m \x1b[2msrc/test/\x1b[0mwebview.test.ts",
          "  ansiToHtml",
          "    \x1b[32m✓\x1b[0m converts red foreground color \x1b[2m(2ms)\x1b[0m",
          "    \x1b[32m✓\x1b[0m converts green foreground color",
          "    \x1b[32m✓\x1b[0m converts bold style \x1b[2m(1ms)\x1b[0m",
          "    \x1b[32m✓\x1b[0m handles nested styles",
          "    \x1b[32m✓\x1b[0m escapes HTML in plain text",
          "",
          "\x1b[1m FAIL \x1b[0m \x1b[2msrc/test/\x1b[0mclient.test.ts",
          "  ACPClient",
          "    \x1b[32m✓\x1b[0m connects successfully",
          "    \x1b[31m✗\x1b[0m \x1b[31mhandles timeout correctly\x1b[0m \x1b[2m(5002ms)\x1b[0m",
          "",
          "\x1b[41m\x1b[37m RUNS \x1b[0m src/test/agents.test.ts",
          "",
          "\x1b[1mTest Suites:\x1b[0m \x1b[31m1 failed\x1b[0m, \x1b[32m1 passed\x1b[0m, 2 total",
          "\x1b[1mTests:\x1b[0m       \x1b[31m1 failed\x1b[0m, \x1b[32m6 passed\x1b[0m, 7 total",
          "\x1b[1mSnapshots:\x1b[0m   0 total",
          "\x1b[2mTime:\x1b[0m        \x1b[36m3.456s\x1b[0m",
          "",
        ].join("\n"),
      },
      content: [],
    });

    await this.delay(200);

    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "\n\nTests completed. Found 1 failing test in `client.test.ts`.",
      },
    });
  }

  private async demoPlanDisplay(sessionId: string): Promise<void> {
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "I'll help you refactor this module. Here's my plan:",
      },
    });

    await this.delay(300);

    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "plan",
      entries: [
        {
          content: "Read existing implementation",
          status: "completed",
          priority: "medium",
        },
        {
          content: "Identify code smells and improvements",
          status: "in_progress",
          priority: "high",
        },
        {
          content: "Extract shared utilities",
          status: "pending",
          priority: "medium",
        },
        {
          content: "Update imports across codebase",
          status: "pending",
          priority: "low",
        },
      ],
    });

    await this.delay(500);

    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "\n\nCurrently analyzing the code structure...",
      },
    });
  }

  private handleCancel(id: number, params?: Record<string, unknown>): void {
    const sessionId = params?.sessionId as string | undefined;
    if (sessionId) {
      this.sessions.get(sessionId)?.pendingPrompt?.abort();
    }
    this.sendResponse(id, {});
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private sendResponse(id: number, result: unknown): void {
    const response = { jsonrpc: "2.0", id, result };
    this.stdout.push(JSON.stringify(response) + "\n");
  }

  private sendError(id: number, code: number, message: string): void {
    const response = { jsonrpc: "2.0", id, error: { code, message } };
    this.stdout.push(JSON.stringify(response) + "\n");
  }

  private sendSessionUpdate(
    sessionId: string,
    update: Record<string, unknown>
  ): void {
    const notification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    };
    this.stdout.push(JSON.stringify(notification) + "\n");
  }

  kill(): void {
    this.stdout.push(null);
    this.stderr.push(null);
  }
}

export interface MockChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number;
  killed: boolean;
  kill: () => boolean;
}

export function createMockProcess(
  demoMode: DemoMode = "default"
): MockChildProcess {
  const server = new MockACPServer(demoMode);
  const mockProcess = new EventEmitter() as MockChildProcess;

  Object.defineProperty(mockProcess, "stdin", {
    value: server.stdin,
    writable: false,
  });
  Object.defineProperty(mockProcess, "stdout", {
    value: server.stdout,
    writable: false,
  });
  Object.defineProperty(mockProcess, "stderr", {
    value: server.stderr,
    writable: false,
  });
  Object.defineProperty(mockProcess, "pid", { value: 99999, writable: false });

  let killed = false;
  Object.defineProperty(mockProcess, "killed", { get: () => killed });

  mockProcess.kill = () => {
    server.kill();
    killed = true;
    mockProcess.emit("exit", 0);
    return true;
  };

  return mockProcess;
}
