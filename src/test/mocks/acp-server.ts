import { EventEmitter, Readable, Writable } from "stream";
import * as acp from "@agentclientprotocol/sdk";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export type DemoMode = "ansi" | "capabilities" | "plan" | "default";

interface MockSession {
  id: string;
  cwd: string;
  configOptions: acp.SessionConfigOption[];
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
  private nextClientRequestId = 10_000;
  private pendingClientRequests = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();

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
      if (!line.trim()) {
        continue;
      }

      try {
        const message: JsonRpcMessage = JSON.parse(line);
        if (message.method !== undefined) {
          this.handleRequest(message);
        } else {
          this.handleClientResponse(message);
        }
      } catch {
        console.error("[MockACP] Failed to parse:", line);
      }
    }
  }

  private handleClientResponse(response: JsonRpcMessage): void {
    const id = response.id;
    if (id === undefined) {
      return;
    }

    const pendingRequest = this.pendingClientRequests.get(id);
    if (!pendingRequest) {
      return;
    }
    this.pendingClientRequests.delete(id);

    if (response.error === undefined) {
      pendingRequest.resolve();
    } else {
      pendingRequest.reject(new Error(JSON.stringify(response.error)));
    }
  }

  private handleRequest(request: JsonRpcMessage): void {
    const id = request.id;
    const method = request.method;
    const params = request.params;
    if (method === undefined) {
      return;
    }

    switch (method) {
      case "initialize":
        if (id !== undefined) {
          this.sendResponse(id, {
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: { loadSession: false },
          });
        }
        break;
      case "session/new":
        if (id !== undefined) {
          this.handleNewSession(id, params);
        }
        break;
      case "session/prompt":
        if (id !== undefined) {
          void this.handlePrompt(id, params);
        }
        break;
      case "session/set_mode":
        if (id !== undefined) {
          this.sendResponse(id, {});
        }
        break;
      case "session/set_config_option":
        if (id !== undefined) {
          this.handleSetConfigOption(id, params);
        }
        break;
      case "session/cancel":
        this.handleCancel(params);
        break;
      default:
        if (id !== undefined) {
          this.sendError(id, -32601, `Unknown method: ${method}`);
        }
    }
  }

  private handleNewSession(id: number, params?: Record<string, unknown>): void {
    const sessionId = `mock-session-${++this.sessionCounter}`;
    const cwd = typeof params?.cwd === "string" ? params.cwd : process.cwd();
    const configOptions: acp.SessionConfigOption[] = [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "claude-3-sonnet",
        options: [
          { value: "claude-3-sonnet", name: "Claude 3 Sonnet" },
          { value: "claude-3-opus", name: "Claude 3 Opus" },
        ],
      },
    ];

    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      configOptions,
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
      configOptions,
    };

    this.sendResponse(id, response);
  }

  private handleSetConfigOption(
    id: number,
    params?: Record<string, unknown>
  ): void {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId : null;
    const configId =
      typeof params?.configId === "string" ? params.configId : null;
    const value = typeof params?.value === "string" ? params.value : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const configOption = session?.configOptions.find(
      (option) => option.id === configId && option.type === "select"
    );

    if (!session || !configOption || !value) {
      this.sendError(id, -32602, "Invalid session configuration option");
      return;
    }

    configOption.currentValue = value;
    this.sendResponse(id, { configOptions: session.configOptions });
    this.sendSessionUpdate(session.id, {
      sessionUpdate: "config_option_update",
      configOptions: session.configOptions,
    });
  }

  private async handlePrompt(
    id: number,
    params?: Record<string, unknown>
  ): Promise<void> {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId : undefined;
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
        case "capabilities":
          await this.demoCapabilities(session.id);
          break;
        case "plan":
          await this.demoPlanDisplay(session.id);
          break;
        default:
          await this.demoDefault(session.id);
      }

      if (session.pendingPrompt?.signal.aborted) {
        this.sendResponse(id, { stopReason: "cancelled" });
        return;
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

  private requestClient(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const id = this.nextClientRequestId++;
    return new Promise<void>((resolve, reject) => {
      this.pendingClientRequests.set(id, { resolve, reject });
      this.stdout.push(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      );
    });
  }

  private async demoCapabilities(sessionId: string): Promise<void> {
    const terminalId = "mock-terminal";
    await this.requestClient("fs/read_text_file", {
      sessionId,
      path: "/workspace/input.ts",
    });
    await this.requestClient("fs/write_text_file", {
      sessionId,
      path: "/workspace/output.ts",
      content: "export {};\n",
    });
    await this.requestClient("terminal/create", {
      sessionId,
      command: "echo",
      args: ["capability"],
      cwd: "/workspace",
      outputByteLimit: 1024,
    });
    await this.requestClient("terminal/output", { sessionId, terminalId });
    await this.requestClient("terminal/wait_for_exit", {
      sessionId,
      terminalId,
    });
    await this.requestClient("terminal/kill", { sessionId, terminalId });
    await this.requestClient("terminal/release", { sessionId, terminalId });
    await this.demoDefault(sessionId);
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

  private handleCancel(params?: Record<string, unknown>): void {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId : undefined;
    if (sessionId) {
      this.sessions.get(sessionId)?.pendingPrompt?.abort();
    }
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
