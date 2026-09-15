import { EventEmitter, Readable, Writable } from "stream";
import * as acp from "@agentclientprotocol/sdk";

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export type ProtocolErrorDemoMode =
  | "error-parse"
  | "error-invalid-request"
  | "error-method-not-found"
  | "error-invalid-params"
  | "error-internal"
  | "error-auth-required"
  | "error-resource-not-found";

export type AuthenticationDemoMode =
  | "authentication"
  | "authentication-failure"
  | "authentication-mcp"
  | "authentication-terminal"
  | "authentication-unknown-type";

/**
 * Advertised `authMethods`. Values are raw JSON because agents are untrusted
 * and `initialize` responses are not schema-validated on the wire, so the mock
 * must be able to send a `type` the SDK union does not model.
 */
const AUTH_METHODS_BY_DEMO_MODE: Partial<Record<DemoMode, unknown[]>> = {
  authentication: [{ id: "browser", name: "Browser sign-in" }],
  "authentication-failure": [{ id: "browser", name: "Browser sign-in" }],
  "authentication-mcp": [{ id: "browser", name: "Browser sign-in" }],
  "authentication-terminal": [
    { id: "terminal", name: "Terminal sign-in", type: "terminal" },
  ],
  "authentication-unknown-type": [
    { id: "future", name: "Future sign-in", type: "terminal-v2" },
  ],
};

const PROTOCOL_ERRORS: Record<
  ProtocolErrorDemoMode,
  { code: number; message: string }
> = {
  "error-parse": { code: -32700, message: "Malformed agent response" },
  "error-invalid-request": { code: -32600, message: "Request shape rejected" },
  "error-method-not-found": { code: -32601, message: "Prompt is unavailable" },
  "error-invalid-params": {
    code: -32602,
    message: "Prompt parameters rejected",
  },
  "error-internal": { code: -32603, message: "Agent execution failed" },
  "error-auth-required": { code: -32000, message: "Sign in to continue" },
  "error-resource-not-found": {
    code: -32002,
    message: "Workspace file missing",
  },
};

export type DemoMode =
  | ProtocolErrorDemoMode
  | AuthenticationDemoMode
  | "agent-info"
  | "agent-info-normalization"
  | "ansi"
  | "capabilities"
  | "rich-attachments"
  | "deferred-config"
  | "cascading-config"
  | "invalid-config"
  | "invalid-version"
  | "late-permission"
  | "load"
  | "mcp-transports"
  | "load-failure"
  | "sessions"
  | "no-initialize"
  | "session-isolation"
  | "mode-update"
  | "permission"
  | "replacement-failure"
  | "session-close"
  | "session-close-hangs"
  | "plan"
  | "default";

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

  public lastPrompt: unknown[] = [];

  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;

  private stdinBuffer = "";
  private nextClientRequestId = 10_000;
  private pendingClientRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private permissionOutcomes: acp.RequestPermissionOutcome[] = [];
  private initializeRequest: acp.InitializeRequest | null = null;
  private closedSessionIds: string[] = [];
  private authenticated = false;
  private authenticationRequests: string[] = [];
  private newSessionRequestCount = 0;
  private newSessionRequests: acp.NewSessionRequest[] = [];
  private loadSessionRequests: acp.LoadSessionRequest[] = [];
  private listSessionRequests: acp.ListSessionsRequest[] = [];
  private resumeSessionRequests: acp.ResumeSessionRequest[] = [];
  private configOptionRequests: acp.SetSessionConfigOptionRequest[] = [];

  getInitializeRequest(): acp.InitializeRequest | null {
    return this.initializeRequest;
  }

  getPermissionOutcomes(): readonly acp.RequestPermissionOutcome[] {
    return this.permissionOutcomes;
  }

  getClosedSessionIds(): readonly string[] {
    return this.closedSessionIds;
  }
  getNewSessionRequests(): readonly acp.NewSessionRequest[] {
    return this.newSessionRequests;
  }
  getConfigOptionRequests(): readonly acp.SetSessionConfigOptionRequest[] {
    return this.configOptionRequests;
  }

  getLoadSessionRequests(): readonly acp.LoadSessionRequest[] {
    return this.loadSessionRequests;
  }
  getListSessionRequests(): readonly acp.ListSessionsRequest[] {
    return this.listSessionRequests;
  }

  getResumeSessionRequests(): readonly acp.ResumeSessionRequest[] {
    return this.resumeSessionRequests;
  }

  getAuthenticationRequests(): readonly string[] {
    return this.authenticationRequests;
  }

  getNewSessionRequestCount(): number {
    return this.newSessionRequestCount;
  }

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
      pendingRequest.resolve(response.result);
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
        if (params) {
          this.initializeRequest = params as acp.InitializeRequest;
        }
        if (id !== undefined && this.demoMode !== "no-initialize") {
          const authMethods = AUTH_METHODS_BY_DEMO_MODE[this.demoMode] ?? [];
          this.sendResponse(id, {
            protocolVersion:
              this.demoMode === "invalid-version"
                ? acp.PROTOCOL_VERSION + 1
                : acp.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession:
                this.demoMode === "load" ||
                this.demoMode === "load-failure" ||
                this.demoMode === "authentication-mcp" ||
                this.demoMode === "sessions",
              ...(this.demoMode === "mcp-transports" ||
              this.demoMode === "authentication-mcp"
                ? { mcpCapabilities: { http: true, sse: true } }
                : {}),
              ...((this.demoMode === "session-close" ||
                this.demoMode === "session-close-hangs" ||
                this.demoMode === "sessions") && {
                sessionCapabilities: {
                  ...(this.demoMode === "sessions"
                    ? {
                        list: {},
                        resume: {},
                        additionalDirectories: {},
                      }
                    : {}),
                  ...(this.demoMode === "session-close" ||
                  this.demoMode === "session-close-hangs"
                    ? { close: {} }
                    : {}),
                },
              }),
              ...(this.demoMode === "rich-attachments"
                ? {
                    promptCapabilities: {
                      image: true,
                      embeddedContext: true,
                    },
                  }
                : {}),
            },
            authMethods,
            ...(this.demoMode === "agent-info" && {
              agentInfo: {
                name: "metadata-agent",
                title: "Metadata Agent",
                version: "1.4.0",
              },
            }),
            ...(this.demoMode === "agent-info-normalization" && {
              agentInfo: {
                name: `\u0000${"a".repeat(255)}\u{10437}ignored`,
                title: "\u0000Metadata\u202eAgent\u0007",
                version: "\u00001.4.0\u0007",
              },
            }),
          });
        }
        break;
      case "authenticate":
        if (id !== undefined) {
          this.handleAuthenticate(id, params);
        }
        break;
      case "session/new":
        if (id !== undefined) {
          this.handleNewSession(id, params);
        }
        break;
      case "session/load":
        if (id !== undefined) {
          this.handleLoadSession(id, params);
        }
        break;
      case "session/list":
        if (id !== undefined) {
          this.handleListSessions(id, params);
        }
        break;
      case "session/resume":
        if (id !== undefined) {
          this.handleResumeSession(id, params);
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
      case "session/close":
        if (this.demoMode === "session-close-hangs") {
          break;
        }
        if (id !== undefined) {
          this.handleCloseSession(id, params);
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

  private handleAuthenticate(
    id: number,
    params?: Record<string, unknown>
  ): void {
    const methodId =
      typeof params?.methodId === "string" ? params.methodId : "";
    this.authenticationRequests.push(methodId);
    if (this.demoMode === "authentication-failure") {
      this.sendError(id, -32000, "Authentication failed");
      return;
    }
    if (
      (this.demoMode !== "authentication" &&
        this.demoMode !== "authentication-mcp") ||
      methodId !== "browser"
    ) {
      this.sendError(id, -32602, "Unsupported authentication method");
      return;
    }
    this.authenticated = true;
    this.sendResponse(id, {});
  }

  private handleNewSession(id: number, params?: Record<string, unknown>): void {
    this.newSessionRequestCount++;
    if (params) {
      this.newSessionRequests.push(params as acp.NewSessionRequest);
    }
    if (
      (this.demoMode === "authentication" ||
        this.demoMode === "authentication-failure" ||
        this.demoMode === "authentication-mcp") &&
      !this.authenticated
    ) {
      this.sendError(id, -32000, "Authentication required");
      return;
    }
    let previousSession: MockSession | undefined;
    if (this.demoMode === "replacement-failure" && this.sessionCounter === 1) {
      this.sendError(id, -32000, "Replacement session failed");
      return;
    }
    for (const session of this.sessions.values()) {
      previousSession = session;
    }

    if (this.demoMode === "late-permission" && previousSession) {
      void this.requestClient("session/request_permission", {
        sessionId: previousSession.id,
        toolCall: {
          toolCallId: "late-tool",
          title: "Late permission",
          kind: "edit",
        },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      })
        .then((response) => {
          const permission = response as acp.RequestPermissionResponse;
          this.permissionOutcomes.push(permission.outcome);
        })
        .catch(() => {});
    }

    const sessionId = `mock-session-${++this.sessionCounter}`;
    const cwd = typeof params?.cwd === "string" ? params.cwd : process.cwd();
    const isolatedModel = `session-${this.sessionCounter}-model`;
    const configOptions: acp.SessionConfigOption[] =
      this.demoMode === "deferred-config"
        ? [
            {
              id: "model",
              type: "select",
              name: "Model",
              category: "model",
              currentValue: "claude-3-opus",
              options: [
                {
                  group: "anthropic",
                  name: "Anthropic",
                  options: [
                    { value: "claude-3-sonnet", name: "Claude 3 Sonnet" },
                    { value: "claude-3-opus", name: "Claude 3 Opus" },
                  ],
                },
              ],
            },
          ]
        : this.demoMode === "cascading-config"
          ? [
              {
                id: "interaction",
                type: "select",
                name: "Interaction",
                category: "mode",
                currentValue: "build",
                options: [
                  { value: "build", name: "Build" },
                  { value: "review", name: "Review" },
                ],
              },
              {
                id: "model",
                type: "select",
                name: "Model",
                category: "model",
                currentValue: "fast",
                options: [
                  {
                    group: "speed",
                    name: "Fast models",
                    options: [{ value: "fast", name: "Fast" }],
                  },
                  {
                    group: "quality",
                    name: "Quality models",
                    options: [{ value: "accurate", name: "Accurate" }],
                  },
                ],
              },
              {
                id: "thought",
                type: "select",
                name: "Thought level",
                category: "thought_level",
                currentValue: "medium",
                options: [
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                ],
              },
            ]
          : [
              {
                id: "model",
                type: "select",
                name: "Model",
                category: "model",
                currentValue:
                  this.demoMode === "invalid-config"
                    ? "missing-model"
                    : this.demoMode === "session-isolation"
                      ? isolatedModel
                      : "claude-3-sonnet",
                options:
                  this.demoMode === "session-isolation"
                    ? [{ value: isolatedModel, name: isolatedModel }]
                    : [
                        {
                          value: "claude-3-sonnet",
                          name: "Claude 3 Sonnet",
                        },
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
      availableCommands:
        this.demoMode === "session-isolation"
          ? [
              {
                name: `session-${this.sessionCounter}`,
                description: `Commands for ${sessionId}`,
              },
            ]
          : [
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

    if (this.demoMode === "deferred-config") {
      // Config options streamed before the session/new response, which then
      // omits them entirely.
      this.sendSessionUpdate(sessionId, {
        sessionUpdate: "config_option_update",
        configOptions,
      });
    }

    const response: acp.NewSessionResponse = {
      sessionId,
      modes: {
        availableModes: [
          { id: "code", name: "Code" },
          { id: "architect", name: "Architect" },
        ],
        currentModeId: "code",
      },
      ...(this.demoMode === "deferred-config" ? {} : { configOptions }),
    };

    this.sendResponse(id, response);

    if (this.demoMode === "mode-update") {
      setImmediate(() => {
        this.sendSessionUpdate(sessionId, {
          sessionUpdate: "current_mode_update",
          currentModeId: "architect",
        });
      });
    }

    if (this.demoMode === "session-isolation" && previousSession) {
      setImmediate(() => {
        this.sendSessionUpdate(previousSession.id, {
          sessionUpdate: "config_option_update",
          configOptions: previousSession.configOptions,
        });
        this.sendSessionUpdate(previousSession.id, {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "stale", description: "Stale session command" },
          ],
        });
        void this.requestClient("fs/read_text_file", {
          sessionId: previousSession.id,
          path: "/workspace/stale.ts",
        }).catch(() => {});
      });
    }
  }

  private handleLoadSession(
    id: number,
    params?: Record<string, unknown>
  ): void {
    if (params) {
      this.loadSessionRequests.push(params as acp.LoadSessionRequest);
    }
    if (this.demoMode === "load-failure") {
      this.sendError(id, -32000, "Session load failed");
      return;
    }

    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId : undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      this.sendError(id, -32000, "Session not found");
      return;
    }

    this.sendSessionUpdate(session.id, {
      sessionUpdate: "user_message_chunk",
      messageId: "restored-user",
      content: { type: "text", text: "Restored " },
    });
    this.sendSessionUpdate(session.id, {
      sessionUpdate: "user_message_chunk",
      messageId: "restored-user",
      content: { type: "text", text: "question" },
    });
    this.sendSessionUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      messageId: "restored-agent",
      content: { type: "text", text: "Restored " },
    });
    this.sendSessionUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      messageId: "restored-agent",
      content: { type: "text", text: "answer" },
    });
    this.sendResponse(id, {
      modes: {
        availableModes: [
          { id: "code", name: "Code" },
          { id: "architect", name: "Architect" },
        ],
        currentModeId: "code",
      },
      configOptions: session.configOptions,
    } satisfies acp.LoadSessionResponse);
  }
  private handleListSessions(
    id: number,
    params?: Record<string, unknown>
  ): void {
    const request = (params ?? {}) as acp.ListSessionsRequest;
    this.listSessionRequests.push(request);
    if (request.cursor === "page-2") {
      this.sendResponse(id, {
        sessions: [
          {
            sessionId: "listed-session-2",
            cwd: "/test/dir",
            title: "Second listed session",
            updatedAt: "2026-09-15T12:00:00.000Z",
          },
        ],
      } satisfies acp.ListSessionsResponse);
      return;
    }
    this.sendResponse(id, {
      sessions: [
        {
          sessionId: "listed-session-1",
          cwd: "/test/dir",
          additionalDirectories: ["/test/shared"],
          title: "First listed session",
          updatedAt: "2026-09-15T11:00:00.000Z",
        },
      ],
      nextCursor: "page-2",
    } satisfies acp.ListSessionsResponse);
  }

  private handleResumeSession(
    id: number,
    params?: Record<string, unknown>
  ): void {
    if (params) {
      this.resumeSessionRequests.push(params as acp.ResumeSessionRequest);
    }
    this.sendResponse(id, {
      modes: {
        availableModes: [{ id: "code", name: "Code" }],
        currentModeId: "code",
      },
      configOptions: [],
    } satisfies acp.ResumeSessionResponse);
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
      (
        option
      ): option is Extract<acp.SessionConfigOption, { type: "select" }> =>
        option.id === configId && option.type === "select"
    );
    const valueAvailable = configOption?.options.some((entry) =>
      "value" in entry
        ? entry.value === value
        : entry.options.some((option) => option.value === value)
    );

    if (
      !session ||
      sessionId === null ||
      !configOption ||
      configId === null ||
      value === null ||
      !valueAvailable
    ) {
      this.sendError(id, -32602, "Invalid session configuration option");
      return;
    }

    this.configOptionRequests.push({ sessionId, configId, value });
    if (
      this.demoMode === "cascading-config" &&
      configId === "interaction" &&
      value === "review"
    ) {
      session.configOptions = [
        { ...configOption, currentValue: value },
        {
          id: "model",
          type: "select",
          name: "Model",
          category: "model",
          currentValue: "accurate",
          options: [
            {
              group: "quality",
              name: "Quality models",
              options: [{ value: "accurate", name: "Accurate" }],
            },
          ],
        },
      ];
    } else {
      configOption.currentValue = value;
    }
    this.sendResponse(id, { configOptions: session.configOptions });
    if (this.demoMode !== "cascading-config") {
      this.sendSessionUpdate(session.id, {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      });
    }
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

    this.lastPrompt = Array.isArray(params?.prompt) ? params.prompt : [];

    const protocolError =
      PROTOCOL_ERRORS[this.demoMode as ProtocolErrorDemoMode];
    if (protocolError) {
      this.sendError(id, protocolError.code, protocolError.message);
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
        case "permission":
          await this.demoPermission(session.id);
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
  ): Promise<unknown> {
    const id = this.nextClientRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingClientRequests.set(id, { resolve, reject });
      this.stdout.push(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      );
    });
  }

  private async demoPermission(
    sessionId: string,
    rawInput?: Record<string, unknown>
  ): Promise<void> {
    const permission = (await this.requestClient("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "tool-1",
        title: "Write file",
        kind: "edit",
        ...(rawInput && { rawInput }),
      },
      options: [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    })) as acp.RequestPermissionResponse;
    const outcome = permission.outcome;
    this.permissionOutcomes.push(outcome);
    this.sendSessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `permission:${
          outcome.outcome === "selected" ? outcome.optionId : outcome.outcome
        }`,
      },
    });
  }

  private async demoCapabilities(sessionId: string): Promise<void> {
    const terminalId = "mock-terminal";
    await this.demoPermission(sessionId, {
      command: "echo",
      args: ["capability"],
      cwd: "/workspace",
      env: [],
    });
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

  private handleCloseSession(
    id: number,
    params?: Record<string, unknown>
  ): void {
    const sessionId =
      typeof params?.sessionId === "string" ? params.sessionId : undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!sessionId || !session) {
      this.sendError(id, -32000, "Session not found");
      return;
    }

    session.pendingPrompt?.abort();
    this.sessions.delete(sessionId);
    this.closedSessionIds.push(sessionId);
    this.sendResponse(id, {});
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
  server: MockACPServer;
  kill: () => boolean;
}

export function createMockProcess(
  demoMode: DemoMode = "default"
): MockChildProcess {
  const server = new MockACPServer(demoMode);
  const mockProcess = new EventEmitter() as MockChildProcess;

  Object.defineProperty(mockProcess, "server", {
    value: server,
    writable: false,
  });

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
    // Real child processes report exit on a later turn of the event loop.
    setImmediate(() => mockProcess.emit("exit", 0));
    return true;
  };

  return mockProcess;
}
