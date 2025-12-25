import { ChildProcess, spawn } from "child_process";
import { Readable, Writable } from "stream";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type SessionModeState,
  type SessionModelState,
} from "@agentclientprotocol/sdk";
import { type AgentConfig, getDefaultAgent, isAgentAvailable } from "./agents";

export interface SessionMetadata {
  modes: SessionModeState | null;
  models: SessionModelState | null;
}

export type ACPConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

type StateChangeCallback = (state: ACPConnectionState) => void;
type SessionUpdateCallback = (update: SessionNotification) => void;

export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private state: ACPConnectionState = "disconnected";
  private currentSessionId: string | null = null;
  private sessionMetadata: SessionMetadata | null = null;
  private onStateChange: StateChangeCallback | null = null;
  private onSessionUpdate: SessionUpdateCallback | null = null;
  private agentConfig: AgentConfig;

  constructor(agentConfig?: AgentConfig) {
    this.agentConfig = agentConfig ?? getDefaultAgent();
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

  setOnStateChange(callback: StateChangeCallback): void {
    this.onStateChange = callback;
  }

  setOnSessionUpdate(callback: SessionUpdateCallback): void {
    this.onSessionUpdate = callback;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getState(): ACPConnectionState {
    return this.state;
  }

  async connect(): Promise<InitializeResponse> {
    if (this.state === "connected" || this.state === "connecting") {
      throw new Error("Already connected or connecting");
    }

    if (!isAgentAvailable(this.agentConfig.id)) {
      throw new Error(
        `Agent "${this.agentConfig.name}" is not installed. ` +
          `Please install "${this.agentConfig.command}" and try again.`,
      );
    }

    this.setState("connecting");

    try {
      this.process = spawn(this.agentConfig.command, this.agentConfig.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        console.error("[ACP stderr]", data.toString());
      });

      this.process.on("error", (error) => {
        console.error("[ACP] Process error:", error);
        this.setState("error");
      });

      this.process.on("exit", (code) => {
        console.log("[ACP] Process exited with code:", code);
        this.setState("disconnected");
        this.connection = null;
        this.process = null;
      });

      const stream = ndJsonStream(
        Writable.toWeb(this.process.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(this.process.stdout!) as ReadableStream<Uint8Array>,
      );

      const client: Client = {
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          console.log(
            "[ACP] Permission request:",
            JSON.stringify(params, null, 2),
          );
          // Auto-approve by selecting the first "allow" option
          const allowOption = params.options.find(
            (opt) => opt.kind === "allow_once" || opt.kind === "allow_always",
          );
          if (allowOption) {
            console.log(
              "[ACP] Auto-approving with option:",
              allowOption.optionId,
            );
            return {
              outcome: { outcome: "selected", optionId: allowOption.optionId },
            };
          }
          console.log("[ACP] No allow option found, cancelling");
          return { outcome: { outcome: "cancelled" } };
        },
        sessionUpdate: async (params: SessionNotification): Promise<void> => {
          console.log("[ACP] Session update:", JSON.stringify(params, null, 2));
          this.onSessionUpdate?.(params);
        },
      };

      this.connection = new ClientSideConnection(() => client, stream);

      const initResponse = await this.connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: "vscode-acp",
          version: "0.0.1",
        },
      });

      this.setState("connected");
      return initResponse;
    } catch (error) {
      this.setState("error");
      throw error;
    }
  }

  async newSession(workingDirectory: string): Promise<NewSessionResponse> {
    if (!this.connection) {
      throw new Error("Not connected");
    }

    const response = await this.connection.newSession({
      cwd: workingDirectory,
      mcpServers: [],
    });

    this.currentSessionId = response.sessionId;
    this.sessionMetadata = {
      modes: response.modes ?? null,
      models: response.models ?? null,
    };

    return response;
  }

  getSessionMetadata(): SessionMetadata | null {
    return this.sessionMetadata;
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    await this.connection.setSessionMode({
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

    await this.connection.unstable_setSessionModel({
      sessionId: this.currentSessionId,
      modelId,
    });

    if (this.sessionMetadata?.models) {
      this.sessionMetadata.models.currentModelId = modelId;
    }
  }

  async sendMessage(message: string): Promise<PromptResponse> {
    if (!this.connection || !this.currentSessionId) {
      throw new Error("No active session");
    }

    return this.connection.prompt({
      sessionId: this.currentSessionId,
      prompt: [{ type: "text", text: message }],
    });
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.currentSessionId) {
      return;
    }

    await this.connection.cancel({
      sessionId: this.currentSessionId,
    });
  }

  dispose(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
    this.currentSessionId = null;
    this.sessionMetadata = null;
    this.setState("disconnected");
  }

  private setState(state: ACPConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.onStateChange?.(state);
    }
  }
}
