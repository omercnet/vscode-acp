import { EventEmitter, Readable, Writable } from "stream";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface MockSession {
  id: string;
  cwd: string;
  modes: {
    availableModes: Array<{ id: string; name: string }>;
    currentModeId: string;
  };
  models: {
    availableModels: Array<{ modelId: string; name: string }>;
    currentModelId: string;
  };
  commands: Array<{
    name: string;
    description: string;
    input?: { hint: string };
  }>;
}

export class MockACPServer {
  private sessions: Map<string, MockSession> = new Map();
  private sessionCounter = 0;

  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private stdinBuffer = "";

  constructor() {
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
          const request: JsonRpcRequest = JSON.parse(line);
          this.handleRequest(request);
        } catch {
          console.error("[MockACP] Failed to parse:", line);
        }
      }
    }
  }

  private handleRequest(request: JsonRpcRequest): void {
    let response: JsonRpcResponse;

    switch (request.method) {
      case "initialize":
        response = this.handleInitialize(request);
        break;
      case "session/new":
        response = this.handleNewSession(request);
        break;
      case "session/prompt":
        response = this.handlePrompt(request);
        break;
      case "session/set_mode":
        response = this.handleSetMode(request);
        break;
      case "session/set_model":
        response = this.handleSetModel(request);
        break;
      case "session/cancel":
        this.handleCancel(request);
        return;
      default:
        response = {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Unknown method: ${request.method}` },
        };
    }

    this.sendResponse(response);
  }

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        serverInfo: {
          name: "mock-acp-server",
          version: "1.0.0",
        },
        serverCapabilities: {},
      },
    };
  }

  private handleNewSession(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params as { cwd: string };
    const sessionId = `mock-session-${++this.sessionCounter}`;

    const session: MockSession = {
      id: sessionId,
      cwd: params.cwd,
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
      commands: [
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
    };

    this.sessions.set(sessionId, session);

    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: session.commands,
    });

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId,
        modes: session.modes,
        models: session.models,
      },
    };
  }

  private handlePrompt(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params as { sessionId: string; prompt: unknown[] };
    const session = this.sessions.get(params.sessionId);

    if (!session) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "Session not found" },
      };
    }

    this.sendSessionUpdate(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello! " },
    });

    this.sendSessionUpdate(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "I'm a mock response." },
    });

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        stopReason: "end_turn",
      },
    };
  }

  private handleSetMode(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params as { sessionId: string; modeId: string };
    const session = this.sessions.get(params.sessionId);

    if (!session) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "Session not found" },
      };
    }

    session.modes.currentModeId = params.modeId;

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {},
    };
  }

  private handleSetModel(request: JsonRpcRequest): JsonRpcResponse {
    const params = request.params as { sessionId: string; modelId: string };
    const session = this.sessions.get(params.sessionId);

    if (!session) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "Session not found" },
      };
    }

    session.models.currentModelId = params.modelId;

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {},
    };
  }

  private handleCancel(request: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {},
    };
  }

  private sendResponse(response: JsonRpcResponse): void {
    const line = JSON.stringify(response) + "\n";
    this.stdout.push(line);
  }

  private sendSessionUpdate(
    sessionId: string,
    update: Record<string, unknown>,
  ): void {
    const notification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update,
      },
    };
    const line = JSON.stringify(notification) + "\n";
    this.stdout.push(line);
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

export function createMockProcess(): MockChildProcess {
  const server = new MockACPServer();

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
  Object.defineProperty(mockProcess, "killed", {
    get: () => killed,
  });

  mockProcess.kill = () => {
    server.kill();
    killed = true;
    mockProcess.emit("exit", 0);
    return true;
  };

  return mockProcess;
}
