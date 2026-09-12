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
  private pendingCommands: acp.AvailableCommand[] | null = null;
  private pendingConfigOptions: acp.SessionConfigOption[] | null = null;
  private stateChangeListeners: Set<StateChangeCallback> = new Set();
  private sessionUpdateListeners: Set<SessionUpdateCallback> = new Set();
  private stderrListeners: Set<StderrCallback> = new Set();
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

    this.setState("connecting");

    try {
      const child = this.spawnFn(
        this.agentConfig.command,
        this.agentConfig.args,
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        }
      );
      this.process = child;

      child.stderr?.on("data", (data: Buffer) => {
        if (this.process !== child) {
          return;
        }
        const text = data.toString();
        console.error("[ACP stderr]", text);
        this.stderrListeners.forEach((cb) => cb(text));
      });

      child.on("error", (error) => {
        console.error("[ACP] Process error:", error);
        if (this.process !== child) {
          return;
        }
        this.setState("error");
      });

      child.on("exit", (code) => {
        console.log("[ACP] Process exited with code:", code);
        if (this.process !== child) {
          return;
        }
        this.setState("disconnected");
        this.connection = null;
        this.process = null;
      });

      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      );

      this.connection = acp
        .client({ name: "vscode-acp" })
        .onRequest(
          acp.methods.client.session.requestPermission,
          ({ params }) => {
            console.log(
              "[ACP] Permission request:",
              JSON.stringify(params, null, 2)
            );
            const allowOption =
              params.options.find((option) => option.kind === "allow_once") ??
              params.options.find((option) => option.kind === "allow_always");
            if (allowOption) {
              console.log(
                "[ACP] Auto-approving with option:",
                allowOption.optionId
              );
              return {
                outcome: {
                  outcome: "selected" as const,
                  optionId: allowOption.optionId,
                },
              };
            }
            console.log("[ACP] No allow option found, cancelling");
            return { outcome: { outcome: "cancelled" as const } };
          }
        )
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          this.handleSessionUpdate(params);
        })
        .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => {
          console.log("[ACP] Read text file request:", params.path);
          if (this.readTextFileHandler) {
            return this.readTextFileHandler(params);
          }
          throw new Error("No readTextFile handler registered");
        })
        .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
          console.log("[ACP] Write text file request:", params.path);
          if (this.writeTextFileHandler) {
            return this.writeTextFileHandler(params);
          }
          throw new Error("No writeTextFile handler registered");
        })
        .onRequest(acp.methods.client.terminal.create, ({ params }) => {
          console.log("[ACP] Create terminal request:", params.command);
          if (this.createTerminalHandler) {
            return this.createTerminalHandler(params);
          }
          throw new Error("No createTerminal handler registered");
        })
        .onRequest(acp.methods.client.terminal.output, ({ params }) => {
          console.log("[ACP] Terminal output request:", params.terminalId);
          if (this.terminalOutputHandler) {
            return this.terminalOutputHandler(params);
          }
          throw new Error("No terminalOutput handler registered");
        })
        .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => {
          console.log("[ACP] Wait for terminal exit:", params.terminalId);
          if (this.waitForTerminalExitHandler) {
            return this.waitForTerminalExitHandler(params);
          }
          throw new Error("No waitForTerminalExit handler registered");
        })
        .onRequest(acp.methods.client.terminal.kill, ({ params }) => {
          console.log("[ACP] Kill terminal:", params.terminalId);
          if (this.killTerminalCommandHandler) {
            return this.killTerminalCommandHandler(params);
          }
          throw new Error("No killTerminalCommand handler registered");
        })
        .onRequest(acp.methods.client.terminal.release, ({ params }) => {
          console.log("[ACP] Release terminal:", params.terminalId);
          if (this.releaseTerminalHandler) {
            return this.releaseTerminalHandler(params);
          }
          throw new Error("No releaseTerminal handler registered");
        })
        .connect(stream);

      const initResponse = await this.connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
          clientInfo: {
            name: "vscode-acp",
            version: "0.0.1",
          },
        }
      );

      this.setState("connected");
      return initResponse;
    } catch (error) {
      this.connection?.close();
      this.connection = null;
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      this.setState("error");
      throw error;
    }
  }

  private handleSessionUpdate(params: acp.SessionNotification): void {
    const update = params.update;
    console.log(`[ACP] Session update: ${update.sessionUpdate}`);
    if (update.sessionUpdate === "agent_message_chunk") {
      console.log("[ACP] CHUNK:", JSON.stringify(update));
    }
    if (update.sessionUpdate === "available_commands_update") {
      if (this.sessionMetadata) {
        this.sessionMetadata.commands = update.availableCommands;
      } else {
        this.pendingCommands = update.availableCommands;
      }
      console.log("[ACP] Commands updated:", update.availableCommands.length);
    }
    if (update.sessionUpdate === "config_option_update") {
      if (this.sessionMetadata) {
        this.sessionMetadata.models = getModelState(update.configOptions);
      } else {
        this.pendingConfigOptions = update.configOptions;
      }
    }
    try {
      this.sessionUpdateListeners.forEach((callback) => callback(params));
    } catch (error) {
      console.error("[ACP] Error in session update listener:", error);
    }
  }

  async newSession(workingDirectory: string): Promise<acp.NewSessionResponse> {
    if (!this.connection) {
      throw new Error("Not connected");
    }

    const response = await this.connection.agent.request(
      acp.methods.agent.session.new,
      {
        cwd: workingDirectory,
        mcpServers: [],
      }
    );

    this.currentSessionId = response.sessionId;
    this.sessionMetadata = {
      modes: response.modes ?? null,
      models: getModelState(
        response.configOptions ?? this.pendingConfigOptions
      ),
      commands: this.pendingCommands,
    };
    this.pendingCommands = null;
    this.pendingConfigOptions = null;

    return response;
  }

  getSessionMetadata(): SessionMetadata | null {
    return this.sessionMetadata;
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: this.currentSessionId,
      modeId,
    });

    if (this.sessionMetadata?.modes) {
      this.sessionMetadata.modes.currentModeId = modeId;
    }
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    const models = this.sessionMetadata?.models;
    if (!models) {
      throw new Error("Agent does not support model selection");
    }

    const response = await this.connection.agent.request(
      acp.methods.agent.session.setConfigOption,
      {
        sessionId: this.currentSessionId,
        configId: models.configId,
        value: modelId,
      }
    );
    if (this.sessionMetadata) {
      this.sessionMetadata.models = getModelState(response.configOptions);
    }
  }

  async sendMessage(message: string): Promise<acp.PromptResponse> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    try {
      const response = await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId: this.currentSessionId,
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
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      return;
    }

    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.currentSessionId,
    });
  }

  dispose(): void {
    this.connection?.close();
    this.connection = null;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.currentSessionId = null;
    this.sessionMetadata = null;
    this.pendingCommands = null;
    this.pendingConfigOptions = null;
    this.setState("disconnected");
  }

  private setState(state: ACPConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.stateChangeListeners.forEach((cb) => cb(state));
    }
  }
}
