import { ChildProcess, spawn as nodeSpawn, SpawnOptions } from "child_process";
import { Readable, Writable } from "stream";
import * as acp from "@agentclientprotocol/sdk";
import { type AgentConfig, getDefaultAgent, isAgentAvailable } from "./agents";

interface ModelSelectionState {
  configId: string;
  availableModels: Array<{ modelId: string; name: string }>;
  currentModelId: string;
}

function getModelState(
  configOptions: readonly acp.SessionConfigOption[] | null | undefined
): ModelSelectionState | null {
  const modelConfig = configOptions?.find(
    (option): option is Extract<acp.SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.category === "model"
  );

  if (!modelConfig) {
    return null;
  }

  const availableModels: ModelSelectionState["availableModels"] = [];
  for (const option of modelConfig.options) {
    if ("value" in option) {
      availableModels.push({ modelId: option.value, name: option.name });
    } else {
      for (const value of option.options) {
        availableModels.push({ modelId: value.value, name: value.name });
      }
    }
  }

  if (
    !availableModels.some((model) => model.modelId === modelConfig.currentValue)
  ) {
    return null;
  }

  return {
    configId: modelConfig.id,
    availableModels,
    currentModelId: modelConfig.currentValue,
  };
}

export interface SessionMetadata {
  modes: acp.SessionModeState | null;
  models: ModelSelectionState | null;
  commands: acp.AvailableCommand[] | null;
}

export type ACPConnectionState =
  "disconnected" | "connecting" | "connected" | "error";

type StateChangeCallback = (state: ACPConnectionState) => void;
type SessionUpdateCallback = (update: acp.SessionNotification) => void;
type StderrCallback = (data: string) => void;
type RequestPermissionCallback = (
  params: acp.RequestPermissionRequest
) => Promise<acp.RequestPermissionResponse>;
type ReadTextFileCallback = (
  params: acp.ReadTextFileRequest
) => Promise<acp.ReadTextFileResponse>;
type WriteTextFileCallback = (
  params: acp.WriteTextFileRequest
) => Promise<acp.WriteTextFileResponse>;
type CreateTerminalCallback = (
  params: acp.CreateTerminalRequest
) => Promise<acp.CreateTerminalResponse>;
type TerminalOutputCallback = (
  params: acp.TerminalOutputRequest
) => Promise<acp.TerminalOutputResponse>;
type WaitForTerminalExitCallback = (
  params: acp.WaitForTerminalExitRequest
) => Promise<acp.WaitForTerminalExitResponse>;
type KillTerminalCommandCallback = (
  params: acp.KillTerminalRequest
) => Promise<acp.KillTerminalResponse>;
type ReleaseTerminalCallback = (
  params: acp.ReleaseTerminalRequest
) => Promise<acp.ReleaseTerminalResponse>;

export type SpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess;

export interface ACPClientOptions {
  agentConfig?: AgentConfig;
  spawn?: SpawnFunction;
  skipAvailabilityCheck?: boolean;
}

export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private state: ACPConnectionState = "disconnected";
  private currentSessionId: string | null = null;
  private sessionMetadata: SessionMetadata | null = null;
  private pendingCommandsBySession = new Map<
    acp.SessionId,
    acp.AvailableCommand[]
  >();
  private pendingConfigOptionsBySession = new Map<
    acp.SessionId,
    acp.SessionConfigOption[]
  >();
  private pendingModeBySession = new Map<acp.SessionId, acp.SessionModeId>();
  private connectionGeneration = 0;
  private sessionRequestGeneration = 0;
  private pendingSessionRequestGeneration: number | null = null;
  private activePrompt: {
    connection: acp.ClientConnection;
    sessionId: acp.SessionId;
  } | null = null;
  private stateChangeListeners: Set<StateChangeCallback> = new Set();
  private sessionUpdateListeners: Set<SessionUpdateCallback> = new Set();
  private stderrListeners: Set<StderrCallback> = new Set();
  private requestPermissionHandler: RequestPermissionCallback | null = null;
  private readTextFileHandler: ReadTextFileCallback | null = null;
  private writeTextFileHandler: WriteTextFileCallback | null = null;
  private createTerminalHandler: CreateTerminalCallback | null = null;
  private terminalOutputHandler: TerminalOutputCallback | null = null;
  private waitForTerminalExitHandler: WaitForTerminalExitCallback | null = null;
  private killTerminalCommandHandler: KillTerminalCommandCallback | null = null;
  private releaseTerminalHandler: ReleaseTerminalCallback | null = null;
  private agentConfig: AgentConfig;
  private spawnFn: SpawnFunction;
  private skipAvailabilityCheck: boolean;

  constructor(options?: ACPClientOptions | AgentConfig) {
    if (options && "id" in options) {
      this.agentConfig = options;
      this.spawnFn = nodeSpawn as SpawnFunction;
      this.skipAvailabilityCheck = false;
    } else {
      this.agentConfig = options?.agentConfig ?? getDefaultAgent();
      this.spawnFn = options?.spawn ?? (nodeSpawn as SpawnFunction);
      this.skipAvailabilityCheck = options?.skipAvailabilityCheck ?? false;
    }
  }

  private isActiveSession(sessionId: acp.SessionId): boolean {
    return sessionId === this.currentSessionId;
  }

  private requireActiveSession(sessionId: acp.SessionId): void {
    if (!this.isActiveSession(sessionId)) {
      throw new Error(`Request for inactive session: ${sessionId}`);
    }
  }

  setAgent(config: AgentConfig): void {
    if (this.state !== "disconnected") {
      this.dispose();
    }
    this.agentConfig = config;
  }

  getAgentId(): string {
    return this.agentConfig.id;
  }

  setOnStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeListeners.add(callback);
    return () => this.stateChangeListeners.delete(callback);
  }

  setOnSessionUpdate(callback: SessionUpdateCallback): () => void {
    this.sessionUpdateListeners.add(callback);
    return () => this.sessionUpdateListeners.delete(callback);
  }

  setOnStderr(callback: StderrCallback): () => void {
    this.stderrListeners.add(callback);
    return () => this.stderrListeners.delete(callback);
  }

  setOnRequestPermission(callback: RequestPermissionCallback): void {
    this.requestPermissionHandler = callback;
  }

  setOnReadTextFile(callback: ReadTextFileCallback): void {
    this.readTextFileHandler = callback;
  }

  setOnWriteTextFile(callback: WriteTextFileCallback): void {
    this.writeTextFileHandler = callback;
  }

  setOnCreateTerminal(callback: CreateTerminalCallback): void {
    this.createTerminalHandler = callback;
  }

  setOnTerminalOutput(callback: TerminalOutputCallback): void {
    this.terminalOutputHandler = callback;
  }

  setOnWaitForTerminalExit(callback: WaitForTerminalExitCallback): void {
    this.waitForTerminalExitHandler = callback;
  }

  setOnKillTerminalCommand(callback: KillTerminalCommandCallback): void {
    this.killTerminalCommandHandler = callback;
  }

  setOnReleaseTerminal(callback: ReleaseTerminalCallback): void {
    this.releaseTerminalHandler = callback;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getState(): ACPConnectionState {
    return this.state;
  }

  async connect(): Promise<acp.InitializeResponse> {
    if (this.state === "connected" || this.state === "connecting") {
      throw new Error("Already connected or connecting");
    }

    if (!this.skipAvailabilityCheck && !isAgentAvailable(this.agentConfig.id)) {
      throw new Error(
        `Agent "${this.agentConfig.name}" is not installed. ` +
          `Please install "${this.agentConfig.command}" and try again.`
      );
    }

    const attemptGeneration = ++this.connectionGeneration;
    let child: ChildProcess | null = null;
    let connection: acp.ClientConnection | null = null;
    this.setState("connecting");

    try {
      child = this.spawnFn(this.agentConfig.command, this.agentConfig.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      this.process = child;

      child.stderr?.on("data", (data: Buffer) => {
        if (this.process !== child) {
          return;
        }
        const text = data.toString();
        console.error("[ACP stderr]", text);
        this.stderrListeners.forEach((callback) => callback(text));
      });

      child.on("error", (error) => {
        console.error("[ACP] Process error:", error);
        if (this.process !== child) {
          return;
        }
        connection?.close(error);
        this.setState("error");
      });

      child.on("exit", (code) => {
        console.log("[ACP] Process exited with code:", code);
        if (this.process !== child) {
          return;
        }
        connection?.close();
        if (this.connection === connection) {
          this.connection = null;
        }
        this.process = null;
        this.currentSessionId = null;
        this.sessionMetadata = null;
        this.pendingCommandsBySession.clear();
        this.pendingConfigOptionsBySession.clear();
        this.pendingSessionRequestGeneration = null;
        this.pendingModeBySession.clear();
        this.activePrompt = null;
        this.setState("disconnected");
      });

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      );

      connection = acp
        .client({ name: "vscode-acp" })
        .onRequest(
          acp.methods.client.session.requestPermission,
          async ({ params }) => {
            this.requireActiveSession(params.sessionId);
            console.log(
              "[ACP] Permission request:",
              JSON.stringify(params, null, 2)
            );
            if (this.requestPermissionHandler) {
              const response = await this.requestPermissionHandler(params);
              return this.isActiveSession(params.sessionId)
                ? response
                : { outcome: { outcome: "cancelled" as const } };
            }
            console.log("[ACP] No permission handler registered, cancelling");
            return { outcome: { outcome: "cancelled" as const } };
          }
        )
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          this.handleSessionUpdate(params);
        })
        .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          console.log("[ACP] Read text file request:", params.path);
          if (this.readTextFileHandler) {
            return this.readTextFileHandler(params);
          }
          throw new Error("No readTextFile handler registered");
        })
        .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          console.log("[ACP] Write text file request:", params.path);
          if (this.writeTextFileHandler) {
            return this.writeTextFileHandler(params);
          }
          throw new Error("No writeTextFile handler registered");
        })
        .onRequest(acp.methods.client.terminal.create, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          console.log("[ACP] Create terminal request:", params.command);
          if (this.createTerminalHandler) {
            return this.createTerminalHandler(params);
          }
          throw new Error("No createTerminal handler registered");
        })
        .onRequest(acp.methods.client.terminal.output, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          console.log("[ACP] Terminal output request:", params.terminalId);
          if (this.terminalOutputHandler) {
            return this.terminalOutputHandler(params);
          }
          throw new Error("No terminalOutput handler registered");
        })
        .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          console.log("[ACP] Wait for terminal exit:", params.terminalId);
          if (this.waitForTerminalExitHandler) {
            return this.waitForTerminalExitHandler(params);
          }
          throw new Error("No waitForTerminalExit handler registered");
        })
        .onRequest(acp.methods.client.terminal.kill, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          console.log("[ACP] Kill terminal:", params.terminalId);
          if (this.killTerminalCommandHandler) {
            return this.killTerminalCommandHandler(params);
          }
          throw new Error("No killTerminalCommand handler registered");
        })
        .onRequest(acp.methods.client.terminal.release, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          console.log("[ACP] Release terminal:", params.terminalId);
          if (this.releaseTerminalHandler) {
            return this.releaseTerminalHandler(params);
          }
          throw new Error("No releaseTerminal handler registered");
        })
        .connect(stream);
      this.connection = connection;

      const clientCapabilities: acp.ClientCapabilities = {};
      if (this.readTextFileHandler || this.writeTextFileHandler) {
        clientCapabilities.fs = {
          readTextFile: this.readTextFileHandler !== null,
          writeTextFile: this.writeTextFileHandler !== null,
        };
      }
      if (
        this.createTerminalHandler &&
        this.terminalOutputHandler &&
        this.waitForTerminalExitHandler &&
        this.killTerminalCommandHandler &&
        this.releaseTerminalHandler
      ) {
        clientCapabilities.terminal = true;
      }

      const initResponse = await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities,
          clientInfo: {
            name: "vscode-acp",
            version: "0.0.1",
          },
        }
      );

      if (
        attemptGeneration !== this.connectionGeneration ||
        this.connection !== connection ||
        this.process !== child
      ) {
        throw new Error("Connection attempt was disposed");
      }
      if (initResponse.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported ACP protocol version: ${initResponse.protocolVersion}`
        );
      }

      this.setState("connected");
      return initResponse;
    } catch (error) {
      const isCurrentAttempt =
        attemptGeneration === this.connectionGeneration &&
        (this.connection === connection || this.process === child);
      connection?.close();
      if (this.connection === connection) {
        this.connection = null;
      }
      if (this.process === child) {
        child?.kill();
        this.process = null;
      }
      if (isCurrentAttempt) {
        this.currentSessionId = null;
        this.sessionMetadata = null;
        this.setState("error");
      }
      throw error;
    }
  }

  private handleSessionUpdate(params: acp.SessionNotification): void {
    const update = params.update;
    const isCurrentSession = this.isActiveSession(params.sessionId);
    console.log(`[ACP] Session update: ${update.sessionUpdate}`);

    if (update.sessionUpdate === "available_commands_update") {
      if (isCurrentSession && this.sessionMetadata) {
        this.sessionMetadata.commands = update.availableCommands;
      } else if (this.pendingSessionRequestGeneration !== null) {
        this.pendingCommandsBySession.set(
          params.sessionId,
          update.availableCommands
        );
      }
      console.log("[ACP] Commands updated:", update.availableCommands.length);
    } else if (update.sessionUpdate === "config_option_update") {
      if (isCurrentSession && this.sessionMetadata) {
        this.sessionMetadata.models = getModelState(update.configOptions);
      } else if (this.pendingSessionRequestGeneration !== null) {
        this.pendingConfigOptionsBySession.set(
          params.sessionId,
          update.configOptions
        );
      }
    } else if (update.sessionUpdate === "current_mode_update") {
      if (isCurrentSession && this.sessionMetadata?.modes) {
        this.sessionMetadata.modes.currentModeId = update.currentModeId;
      } else if (this.pendingSessionRequestGeneration !== null) {
        this.pendingModeBySession.set(params.sessionId, update.currentModeId);
      }
    }

    if (!isCurrentSession) {
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      console.log("[ACP] CHUNK:", JSON.stringify(update));
    }
    try {
      this.sessionUpdateListeners.forEach((callback) => callback(params));
    } catch (error) {
      console.error("[ACP] Error in session update listener:", error);
    }
  }

  async newSession(workingDirectory: string): Promise<acp.NewSessionResponse> {
    const connection = this.connection;
    if (!connection) {
      throw new Error("Not connected");
    }
    if (this.pendingSessionRequestGeneration !== null) {
      throw new Error("Session creation already in progress");
    }

    const requestGeneration = ++this.sessionRequestGeneration;
    this.pendingSessionRequestGeneration = requestGeneration;
    this.pendingCommandsBySession.clear();
    this.pendingConfigOptionsBySession.clear();
    this.pendingModeBySession.clear();
    const replacedSessionId = this.currentSessionId;
    const replacedSessionMetadata = this.sessionMetadata;
    this.currentSessionId = null;
    this.sessionMetadata = null;

    const replacedPromptSessionId = this.activePrompt?.sessionId;

    try {
      if (replacedPromptSessionId) {
        await connection.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: replacedPromptSessionId,
        });
      }

      const response = await connection.agent.request(
        acp.methods.agent.session.new,
        {
          cwd: workingDirectory,
          mcpServers: [],
        }
      );

      if (
        connection !== this.connection ||
        requestGeneration !== this.sessionRequestGeneration
      ) {
        return response;
      }

      const bufferedConfigOptions = this.pendingConfigOptionsBySession.get(
        response.sessionId
      );
      const modes = response.modes ?? null;
      const bufferedMode = this.pendingModeBySession.get(response.sessionId);
      if (
        modes &&
        bufferedMode &&
        modes.availableModes.some((mode) => mode.id === bufferedMode)
      ) {
        modes.currentModeId = bufferedMode;
      }
      this.currentSessionId = response.sessionId;
      this.sessionMetadata = {
        modes,
        models: getModelState(
          response.configOptions === undefined
            ? bufferedConfigOptions
            : response.configOptions
        ),
        commands: this.pendingCommandsBySession.get(response.sessionId) ?? null,
      };
      this.pendingSessionRequestGeneration = null;
      this.pendingCommandsBySession.clear();
      this.pendingConfigOptionsBySession.clear();
      this.pendingModeBySession.clear();

      return response;
    } catch (error) {
      if (this.pendingSessionRequestGeneration === requestGeneration) {
        if (
          !connection.signal.aborted &&
          replacedSessionId &&
          replacedSessionMetadata
        ) {
          const commands = this.pendingCommandsBySession.get(replacedSessionId);
          const configOptions =
            this.pendingConfigOptionsBySession.get(replacedSessionId);
          const modeId = this.pendingModeBySession.get(replacedSessionId);
          if (commands) {
            replacedSessionMetadata.commands = commands;
          }
          if (configOptions) {
            replacedSessionMetadata.models = getModelState(configOptions);
          }
          if (
            modeId &&
            replacedSessionMetadata.modes?.availableModes.some(
              (mode) => mode.id === modeId
            )
          ) {
            replacedSessionMetadata.modes.currentModeId = modeId;
          }
          this.currentSessionId = replacedSessionId;
          this.sessionMetadata = replacedSessionMetadata;
        }
        this.pendingSessionRequestGeneration = null;
        this.pendingCommandsBySession.clear();
        this.pendingConfigOptionsBySession.clear();
        this.pendingModeBySession.clear();
      }
      throw error;
    }
  }

  getSessionMetadata(): SessionMetadata | null {
    return this.sessionMetadata;
  }

  async setMode(modeId: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.currentSessionId;
    const modes = this.sessionMetadata?.modes;
    if (!connection || !sessionId) {
      throw new Error("No active session");
    }
    if (!modes) {
      throw new Error("Agent does not support mode selection");
    }
    if (!modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Mode is not available: ${modeId}`);
    }

    await connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId,
      modeId,
    });

    if (
      connection === this.connection &&
      sessionId === this.currentSessionId &&
      this.sessionMetadata?.modes
    ) {
      this.sessionMetadata.modes.currentModeId = modeId;
    }
  }

  async setModel(modelId: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.currentSessionId;
    const models = this.sessionMetadata?.models;
    if (!connection || !sessionId) {
      throw new Error("No active session");
    }
    if (!models) {
      throw new Error("Agent does not support model selection");
    }
    if (!models.availableModels.some((model) => model.modelId === modelId)) {
      throw new Error(`Model is not available: ${modelId}`);
    }

    const response = await connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId,
        configId: models.configId,
        value: modelId,
      }
    );
    if (
      connection === this.connection &&
      sessionId === this.currentSessionId &&
      this.sessionMetadata
    ) {
      this.sessionMetadata.models = getModelState(response.configOptions);
    }
  }

  async sendMessage(message: string): Promise<acp.PromptResponse> {
    const connection = this.connection;
    const sessionId = this.currentSessionId;
    if (!connection || !sessionId) {
      throw new Error("No active session");
    }

    const prompt = { connection, sessionId };
    this.activePrompt = prompt;
    try {
      const response = await connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId,
          prompt: [{ type: "text", text: message }],
        }
      );
      console.log("[ACP] Prompt completed:", JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      console.error("[ACP] Prompt error:", error);
      if (error instanceof Error) {
        console.error("[ACP] Error details:", error.message, error.stack);
      }
      console.error("[ACP] Raw error:", JSON.stringify(error, null, 2));
      throw error;
    } finally {
      if (this.activePrompt === prompt) {
        this.activePrompt = null;
      }
    }
  }

  async cancel(): Promise<void> {
    const connection = this.connection;
    const sessionId = this.activePrompt?.sessionId ?? this.currentSessionId;
    if (!connection || !sessionId) {
      return;
    }

    await connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
  }

  dispose(): void {
    ++this.connectionGeneration;
    ++this.sessionRequestGeneration;
    this.connection?.close();
    this.connection = null;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.currentSessionId = null;
    this.sessionMetadata = null;
    this.pendingCommandsBySession.clear();
    this.pendingConfigOptionsBySession.clear();
    this.pendingModeBySession.clear();
    this.pendingSessionRequestGeneration = null;
    this.activePrompt = null;
    this.setState("disconnected");
  }

  private setState(state: ACPConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.stateChangeListeners.forEach((cb) => cb(state));
    }
  }
}
