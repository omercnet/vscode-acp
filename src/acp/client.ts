import { ChildProcess, spawn as nodeSpawn, SpawnOptions } from "child_process";
import { Readable, Writable } from "stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  buildPromptContent,
  type PromptAttachment,
} from "../shared/attachments";
import {
  type AgentConfig,
  getDefaultAgent,
  resolveAgentCommand,
} from "./agents";
import {
  createAgentEnvironment,
  type AgentCommandResolutionOptions,
} from "./agentCommand";

export type SupportedSessionConfigOption = Extract<
  acp.SessionConfigOption,
  { type: "select" }
>;

function parseSelectValue(value: unknown): acp.SessionConfigSelectOption {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid session configuration options");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.value !== "string" ||
    typeof candidate.name !== "string" ||
    (candidate.description !== undefined &&
      candidate.description !== null &&
      typeof candidate.description !== "string")
  ) {
    throw new Error("Invalid session configuration options");
  }
  return {
    value: candidate.value,
    name: candidate.name,
    ...(candidate.description !== undefined && {
      description: candidate.description as string | null,
    }),
  };
}

function parseSupportedConfigOptions(
  configOptions: unknown
): SupportedSessionConfigOption[] | null {
  if (configOptions == null) {
    return null;
  }
  if (!Array.isArray(configOptions)) {
    throw new Error("Invalid session configuration options");
  }

  const supported: SupportedSessionConfigOption[] = [];
  for (const value of configOptions) {
    if (typeof value !== "object" || value === null) {
      throw new Error("Invalid session configuration options");
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      (candidate.description !== undefined &&
        candidate.description !== null &&
        typeof candidate.description !== "string") ||
      (candidate.category !== undefined &&
        candidate.category !== null &&
        typeof candidate.category !== "string")
    ) {
      throw new Error("Invalid session configuration options");
    }
    if (candidate.type === "boolean") {
      if (typeof candidate.currentValue !== "boolean") {
        throw new Error("Invalid session configuration options");
      }
      continue;
    }
    if (
      candidate.type !== "select" ||
      typeof candidate.currentValue !== "string" ||
      !Array.isArray(candidate.options)
    ) {
      throw new Error("Invalid session configuration options");
    }

    const directOptions: acp.SessionConfigSelectOption[] = [];
    const groupedOptions: acp.SessionConfigSelectGroup[] = [];
    let optionKind: "direct" | "grouped" | null = null;
    const availableValues = new Set<string>();
    for (const entry of candidate.options) {
      if (typeof entry !== "object" || entry === null) {
        throw new Error("Invalid session configuration options");
      }
      const entryCandidate = entry as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(entryCandidate, "value")) {
        if (optionKind === "grouped") {
          throw new Error("Invalid session configuration options");
        }
        optionKind = "direct";
        const option = parseSelectValue(entryCandidate);
        directOptions.push(option);
        availableValues.add(option.value);
        continue;
      }
      if (
        optionKind === "direct" ||
        typeof entryCandidate.group !== "string" ||
        typeof entryCandidate.name !== "string" ||
        !Array.isArray(entryCandidate.options)
      ) {
        throw new Error("Invalid session configuration options");
      }
      optionKind = "grouped";
      const options = entryCandidate.options.map(parseSelectValue);
      for (const option of options) {
        availableValues.add(option.value);
      }
      groupedOptions.push({
        group: entryCandidate.group,
        name: entryCandidate.name,
        options,
      });
    }

    if (!availableValues.has(candidate.currentValue)) {
      continue;
    }
    const options: acp.SessionConfigSelectOptions =
      optionKind === "grouped" ? groupedOptions : directOptions;
    supported.push({
      id: candidate.id,
      name: candidate.name,
      type: "select",
      currentValue: candidate.currentValue,
      options,
      ...(candidate.description !== undefined && {
        description: candidate.description as string | null,
      }),
      ...(candidate.category !== undefined && {
        category: candidate.category as string | null,
      }),
    });
  }
  return supported;
}

function hasConfigValue(
  option: SupportedSessionConfigOption,
  value: string
): boolean {
  return option.options.some((candidate) =>
    "value" in candidate
      ? candidate.value === value
      : candidate.options.some((grouped) => grouped.value === value)
  );
}
/**
 * ACP discriminates auth methods on `type`, and treats a missing `type` as
 * `agent`. The SDK does not validate `initialize` responses, so unknown values
 * arrive verbatim from the agent process; only the documented agent-managed
 * shapes may be passed to `authenticate`.
 */
export function isAgentAuthMethod(
  method: unknown
): method is acp.AuthMethodAgent {
  if (typeof method !== "object" || method === null) {
    return false;
  }
  const candidate = method as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    (candidate.description === undefined ||
      typeof candidate.description === "string") &&
    (candidate.type === undefined || candidate.type === "agent")
  );
}
const AGENT_INFO_CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;
const MAX_AGENT_INFO_FIELD_LENGTH = 256;

function normalizeAgentInfo(value: unknown): acp.Implementation | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.version !== "string"
  ) {
    return null;
  }
  const normalizeField = (field: string): string => {
    const sanitized = field.replace(AGENT_INFO_CONTROL_CHARACTERS, " ").trim();
    let normalized = "";
    let length = 0;
    for (const character of sanitized) {
      if (length === MAX_AGENT_INFO_FIELD_LENGTH) {
        break;
      }
      normalized += character;
      length++;
    }
    return normalized;
  };
  const name = normalizeField(candidate.name);
  const version = normalizeField(candidate.version);
  if (!name || !version) {
    return null;
  }
  const title =
    typeof candidate.title === "string"
      ? normalizeField(candidate.title) || undefined
      : undefined;
  return { name, version, ...(title !== undefined && { title }) };
}

export interface SessionMetadata {
  modes: acp.SessionModeState | null;
  configOptions: SupportedSessionConfigOption[] | null;
  commands: acp.AvailableCommand[] | null;
}
export interface ACPSessionCapabilities {
  load: boolean;
  list: boolean;
  resume: boolean;
  additionalDirectories: boolean;
}

interface ActiveConfigMutation {
  connection: acp.ClientConnection;
  sessionId: acp.SessionId;
  sessionIdentityGeneration: number;
  responseReceived: boolean;
  precedingConfigOptions?: SupportedSessionConfigOption[];
  supersedingConfigOptions?: SupportedSessionConfigOption[];
}

export type ACPConnectionState =
  "disconnected" | "connecting" | "connected" | "error";

export type ACPErrorKind =
  | "protocol"
  | "invalid-request"
  | "unsupported-operation"
  | "invalid-parameters"
  | "agent"
  | "authentication-required"
  | "resource-not-found"
  | "cancelled"
  | "session-transition"
  | "unknown";

export interface ACPErrorPresentation {
  kind: ACPErrorKind;
  code?: number;
  summary: string;
  diagnostic: string;
}

const ERROR_PRESENTATIONS: Record<
  number,
  Pick<ACPErrorPresentation, "kind" | "summary">
> = {
  [-32700]: { kind: "protocol", summary: "Protocol error" },
  [-32600]: { kind: "invalid-request", summary: "Invalid request" },
  [-32601]: {
    kind: "unsupported-operation",
    summary: "Unsupported operation",
  },
  [-32602]: { kind: "invalid-parameters", summary: "Invalid parameters" },
  [-32603]: { kind: "agent", summary: "Agent error" },
  [-32000]: {
    kind: "authentication-required",
    summary: "Authentication required",
  },
  [-32002]: { kind: "resource-not-found", summary: "Resource not found" },
  [-32800]: { kind: "cancelled", summary: "Request cancelled" },
};

/**
 * Classifies structured JSON-RPC errors exposed by ACP SDK 1.4 and replaces
 * local lifecycle guard diagnostics with user-facing recovery guidance.
 * Other unstructured errors retain their diagnostic text.
 */
const SESSION_TRANSITION_DIAGNOSTICS: Readonly<Record<string, true>> = {
  "Already connected or connecting": true,
  "Session restoration already in progress": true,
  "Session creation already in progress": true,
  "Session loading already in progress": true,
  "No active session": true,
};

export function describeACPError(error: unknown): ACPErrorPresentation {
  if (error instanceof acp.RequestError) {
    const presentation = ERROR_PRESENTATIONS[error.code];
    if (presentation) {
      return {
        ...presentation,
        code: error.code,
        diagnostic: error.message,
      };
    }

    return {
      kind: "unknown",
      code: error.code,
      summary: "ACP request failed",
      diagnostic: error.message,
    };
  }

  if (error instanceof Error && SESSION_TRANSITION_DIAGNOSTICS[error.message]) {
    return {
      kind: "session-transition",
      summary: "Session is still getting ready",
      diagnostic:
        "Session is still getting ready. Wait for setup to finish, then try again.",
    };
  }

  return {
    kind: "unknown",
    summary: "Error",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Renders a presentation as user-facing text.
 *
 * Unclassified errors keep their own wording instead of gaining a synthetic
 * "Error" prefix, and agents that send the SDK's default message for a code
 * (for example `RequestError.authRequired()`) do not repeat the summary.
 */
export function formatACPError(error: unknown): string {
  const { code, summary, diagnostic } = describeACPError(error);
  const detail = diagnostic.trim();
  if (!detail) {
    return summary;
  }
  if (code === undefined) {
    return detail;
  }

  const lowerDetail = detail.toLowerCase();
  const lowerSummary = summary.toLowerCase();
  if (lowerDetail === lowerSummary) {
    return summary;
  }
  return lowerDetail.startsWith(`${lowerSummary}: `)
    ? `${summary}: ${detail.slice(summary.length + 2)}`
    : `${summary}: ${detail}`;
}

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
type FileSystemCapabilitiesCallback = () => Promise<{
  readTextFile: boolean;
  writeTextFile: boolean;
}>;
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
  resolutionOptions?: () => AgentCommandResolutionOptions;
}

export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private state: ACPConnectionState = "disconnected";
  private currentSessionId: string | null = null;
  private sessionMetadata: SessionMetadata | null = null;
  private authenticationMethods: acp.AuthMethod[] = [];
  private agentInfo: acp.Implementation | null = null;
  private pendingCommandsBySession = new Map<
    acp.SessionId,
    acp.AvailableCommand[]
  >();
  private pendingConfigOptionsBySession = new Map<
    acp.SessionId,
    SupportedSessionConfigOption[]
  >();
  private pendingModeBySession = new Map<acp.SessionId, acp.SessionModeId>();
  private fileSystemCapabilitiesHandler: FileSystemCapabilitiesCallback | null =
    null;
  private connectionGeneration = 0;
  private sessionRequestGeneration = 0;
  private pendingSessionRequestGeneration: number | null = null;
  private sessionIdentityGeneration = 0;
  private sessionTransitionSettled: Promise<void> = Promise.resolve();
  private canCloseSessions = false;
  private supportsSessionLoading = false;
  private supportsSessionListing = false;
  private supportsSessionResuming = false;
  private supportsAdditionalSessionDirectories = false;
  private loadingSessionId: acp.SessionId | null = null;
  private mcpCapabilities: acp.McpCapabilities = {};
  private promptCapabilities: acp.PromptCapabilities = {};
  private configOptionMutationTail: Promise<void> = Promise.resolve();
  private activeConfigMutations = new Set<ActiveConfigMutation>();
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
  private resolutionOptions: () => AgentCommandResolutionOptions;

  constructor(options?: ACPClientOptions | AgentConfig) {
    if (options && "id" in options) {
      this.agentConfig = options;
      this.spawnFn = nodeSpawn as SpawnFunction;
      this.resolutionOptions = () => ({});
    } else {
      this.agentConfig = options?.agentConfig ?? getDefaultAgent();
      this.spawnFn = options?.spawn ?? (nodeSpawn as SpawnFunction);
      this.resolutionOptions = options?.resolutionOptions ?? (() => ({}));
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

  private async waitForSessionTransition(
    connection: acp.ClientConnection,
    sessionIdentityGeneration: number
  ): Promise<void> {
    while (
      connection === this.connection &&
      sessionIdentityGeneration === this.sessionIdentityGeneration &&
      this.pendingSessionRequestGeneration !== null
    ) {
      await this.sessionTransitionSettled;
    }
  }

  setAgent(config: AgentConfig): void {
    if (this.state !== "disconnected") {
      this.dispose();
    }
    this.agentInfo = null;
    this.agentConfig = config;
  }

  getAgentId(): string {
    return this.agentConfig.id;
  }
  getAgentInfo(): acp.Implementation | null {
    return this.agentInfo ? { ...this.agentInfo } : null;
  }

  getCurrentSessionId(): string | null {
    return this.isConnected() ? this.currentSessionId : null;
  }

  getAuthenticationMethods(): readonly acp.AuthMethod[] {
    return [...this.authenticationMethods];
  }

  /**
   * Identifies the connection attempt that produced the current
   * {@link getAuthenticationMethods} list, so a selection made while the agent
   * was replaced cannot be applied to the replacement.
   */
  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  supportsSessionLoad(): boolean {
    return this.supportsSessionLoading;
  }
  getSessionCapabilities(): ACPSessionCapabilities {
    return {
      load: this.supportsSessionLoading,
      list: this.supportsSessionListing,
      resume: this.supportsSessionResuming,
      additionalDirectories: this.supportsAdditionalSessionDirectories,
    };
  }
  getMcpCapabilities(): acp.McpCapabilities {
    return { ...this.mcpCapabilities };
  }
  getPromptCapabilities(): acp.PromptCapabilities {
    return { ...this.promptCapabilities };
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
  setFileSystemCapabilities(callback: FileSystemCapabilitiesCallback): void {
    this.fileSystemCapabilitiesHandler = callback;
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

    const resolutionOptions = this.resolutionOptions();
    const launch = resolveAgentCommand(this.agentConfig, resolutionOptions);
    if (!launch) {
      throw new Error(
        `Agent "${this.agentConfig.name}" is unavailable. ` +
          "Install it on the extension host PATH or configure an absolute executable path."
      );
    }

    const availableFileSystemCapabilities = this.fileSystemCapabilitiesHandler
      ? await this.fileSystemCapabilitiesHandler()
      : { readTextFile: true, writeTextFile: true };

    const attemptGeneration = ++this.connectionGeneration;
    let child: ChildProcess | null = null;
    let connection: acp.ClientConnection | null = null;
    this.authenticationMethods = [];
    this.agentInfo = null;
    this.canCloseSessions = false;
    this.supportsSessionLoading = false;
    this.mcpCapabilities = {};
    this.promptCapabilities = {};
    this.supportsSessionListing = false;
    this.supportsSessionResuming = false;
    this.supportsAdditionalSessionDirectories = false;
    this.currentSessionId = null;
    this.sessionMetadata = null;
    this.pendingCommandsBySession.clear();
    this.pendingConfigOptionsBySession.clear();
    this.pendingModeBySession.clear();
    this.pendingSessionRequestGeneration = null;
    this.sessionIdentityGeneration++;
    this.sessionTransitionSettled = Promise.resolve();
    this.loadingSessionId = null;
    this.configOptionMutationTail = Promise.resolve();
    this.activeConfigMutations.clear();
    this.setState("connecting");

    try {
      console.log(
        `[ACP] Launching ${this.agentConfig.name} via ${launch.source}`
      );
      try {
        child = this.spawnFn(launch.command, launch.args, {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: launch.cwd,
          env: createAgentEnvironment(resolutionOptions),
          shell: false,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "unknown";
        throw new Error(
          `Unable to launch agent "${this.agentConfig.name}" (${code})`
        );
      }
      this.process = child;

      child.stderr?.on("data", (data: Buffer) => {
        if (this.process !== child) {
          return;
        }
        const text = data.toString();
        this.stderrListeners.forEach((callback) => callback(text));
      });

      child.on("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code ?? "unknown";
        console.error(`[ACP] ${this.agentConfig.name} process error (${code})`);
        if (this.process !== child) {
          return;
        }
        connection?.close(error);
        this.agentInfo = null;
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
        this.agentInfo = null;
        this.currentSessionId = null;
        this.sessionMetadata = null;
        this.pendingCommandsBySession.clear();
        this.pendingConfigOptionsBySession.clear();
        this.pendingSessionRequestGeneration = null;
        this.pendingModeBySession.clear();
        this.activePrompt = null;
        this.canCloseSessions = false;
        this.supportsSessionLoading = false;
        this.supportsSessionListing = false;
        this.supportsSessionResuming = false;
        this.supportsAdditionalSessionDirectories = false;
        this.authenticationMethods = [];
        this.loadingSessionId = null;
        this.mcpCapabilities = {};
        this.promptCapabilities = {};
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
            if (!this.isActiveSession(params.sessionId)) {
              return { outcome: { outcome: "cancelled" as const } };
            }
            console.log("[ACP] Permission request received");
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
          if (!availableFileSystemCapabilities.readTextFile) {
            throw new Error("readTextFile is unavailable on this host");
          }
          if (this.readTextFileHandler) {
            return this.readTextFileHandler(params);
          }
          throw new Error("No readTextFile handler registered");
        })
        .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          if (!availableFileSystemCapabilities.writeTextFile) {
            throw new Error("writeTextFile is unavailable on this host");
          }
          if (this.writeTextFileHandler) {
            return this.writeTextFileHandler(params);
          }
          throw new Error("No writeTextFile handler registered");
        })
        .onRequest(acp.methods.client.terminal.create, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          if (this.createTerminalHandler) {
            return this.createTerminalHandler(params);
          }
          throw new Error("No createTerminal handler registered");
        })
        .onRequest(acp.methods.client.terminal.output, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          if (this.terminalOutputHandler) {
            return this.terminalOutputHandler(params);
          }
          throw new Error("No terminalOutput handler registered");
        })
        .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          if (this.waitForTerminalExitHandler) {
            return this.waitForTerminalExitHandler(params);
          }
          throw new Error("No waitForTerminalExit handler registered");
        })
        .onRequest(acp.methods.client.terminal.kill, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          if (this.killTerminalCommandHandler) {
            return this.killTerminalCommandHandler(params);
          }
          throw new Error("No killTerminalCommand handler registered");
        })
        .onRequest(acp.methods.client.terminal.release, ({ params }) => {
          this.requireActiveSession(params.sessionId);
          if (this.releaseTerminalHandler) {
            return this.releaseTerminalHandler(params);
          }
          throw new Error("No releaseTerminal handler registered");
        })
        .connect(stream);
      this.connection = connection;
      void connection.closed.then(() => {
        if (this.connection === connection && this.state === "connected") {
          this.dispose();
        }
      });

      const clientCapabilities: acp.ClientCapabilities = {};
      const readTextFile =
        availableFileSystemCapabilities.readTextFile &&
        this.readTextFileHandler !== null;
      const writeTextFile =
        availableFileSystemCapabilities.writeTextFile &&
        this.writeTextFileHandler !== null;
      if (readTextFile || writeTextFile) {
        clientCapabilities.fs = { readTextFile, writeTextFile };
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
      clientCapabilities.session = { configOptions: {} };

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
        this.process !== child ||
        connection.signal.aborted
      ) {
        throw new Error("Connection attempt was disposed");
      }
      if (initResponse.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported ACP protocol version: ${initResponse.protocolVersion}`
        );
      }
      this.agentInfo = normalizeAgentInfo(initResponse.agentInfo);
      this.canCloseSessions =
        initResponse.agentCapabilities?.sessionCapabilities?.close != null;
      this.supportsSessionLoading =
        initResponse.agentCapabilities?.loadSession === true;
      this.supportsSessionListing =
        initResponse.agentCapabilities?.sessionCapabilities?.list != null;
      this.supportsSessionResuming =
        initResponse.agentCapabilities?.sessionCapabilities?.resume != null;
      this.supportsAdditionalSessionDirectories =
        initResponse.agentCapabilities?.sessionCapabilities
          ?.additionalDirectories != null;
      const advertisedAuthMethods: unknown = initResponse.authMethods;
      this.authenticationMethods = Array.isArray(advertisedAuthMethods)
        ? advertisedAuthMethods.filter(isAgentAuthMethod)
        : [];
      this.mcpCapabilities = {
        ...initResponse.agentCapabilities?.mcpCapabilities,
      };
      this.promptCapabilities = {
        image:
          initResponse.agentCapabilities?.promptCapabilities?.image === true,
        embeddedContext:
          initResponse.agentCapabilities?.promptCapabilities
            ?.embeddedContext === true,
      };

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
        this.agentInfo = null;
        this.sessionMetadata = null;
        this.canCloseSessions = false;
        this.supportsSessionLoading = false;
        this.supportsSessionListing = false;
        this.supportsSessionResuming = false;
        this.supportsAdditionalSessionDirectories = false;
        this.loadingSessionId = null;
        this.authenticationMethods = [];
        this.mcpCapabilities = {};
        this.promptCapabilities = {};
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
      let configOptions: SupportedSessionConfigOption[];
      try {
        const parsed = parseSupportedConfigOptions(update.configOptions);
        if (parsed === null) {
          throw new Error("Invalid session configuration options");
        }
        configOptions = parsed;
      } catch {
        console.error("[ACP] Invalid session configuration options update");
        return;
      }
      let activeMutation: ActiveConfigMutation | undefined;
      for (const mutation of this.activeConfigMutations) {
        if (
          mutation.connection === this.connection &&
          mutation.sessionId === params.sessionId &&
          mutation.sessionIdentityGeneration === this.sessionIdentityGeneration
        ) {
          activeMutation = mutation;
          break;
        }
      }
      if (activeMutation) {
        if (activeMutation.responseReceived) {
          activeMutation.supersedingConfigOptions = configOptions;
        } else {
          activeMutation.precedingConfigOptions = configOptions;
        }
        return;
      }
      if (isCurrentSession && this.sessionMetadata) {
        this.sessionMetadata.configOptions = configOptions;
      } else if (this.pendingSessionRequestGeneration !== null) {
        this.pendingConfigOptionsBySession.set(params.sessionId, configOptions);
      }
    } else if (update.sessionUpdate === "current_mode_update") {
      if (isCurrentSession && this.sessionMetadata?.modes) {
        this.sessionMetadata.modes.currentModeId = update.currentModeId;
      } else if (this.pendingSessionRequestGeneration !== null) {
        this.pendingModeBySession.set(params.sessionId, update.currentModeId);
      }
    }

    if (!isCurrentSession && params.sessionId !== this.loadingSessionId) {
      return;
    }
    try {
      this.sessionUpdateListeners.forEach((callback) => callback(params));
    } catch {
      console.error("[ACP] Session update listener failed");
    }
  }

  async newSession(
    params: acp.NewSessionRequest
  ): Promise<acp.NewSessionResponse> {
    const connection = this.connection;
    if (!connection) {
      throw new Error("Not connected");
    }
    if (this.pendingSessionRequestGeneration !== null) {
      throw new Error("Session creation already in progress");
    }

    let settleSessionTransition!: () => void;
    const sessionTransitionSettled = new Promise<void>((resolve) => {
      settleSessionTransition = resolve;
    });
    this.sessionTransitionSettled = sessionTransitionSettled;
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
        params
      );

      if (
        connection !== this.connection ||
        requestGeneration !== this.sessionRequestGeneration
      ) {
        return response;
      }

      const hasBufferedConfigOptions = this.pendingConfigOptionsBySession.has(
        response.sessionId
      );
      const bufferedConfigOptions = this.pendingConfigOptionsBySession.get(
        response.sessionId
      );
      const responseConfigOptions = parseSupportedConfigOptions(
        response.configOptions
      );
      const configOptions = hasBufferedConfigOptions
        ? bufferedConfigOptions ?? []
        : responseConfigOptions;
      const modes = response.modes ?? null;
      const bufferedMode = this.pendingModeBySession.get(response.sessionId);
      if (
        modes &&
        bufferedMode &&
        modes.availableModes.some((mode) => mode.id === bufferedMode)
      ) {
        modes.currentModeId = bufferedMode;
      }
      const metadata: SessionMetadata = {
        modes,
        configOptions,
        commands: this.pendingCommandsBySession.get(response.sessionId) ?? null,
      };
      this.sessionIdentityGeneration++;
      this.configOptionMutationTail = Promise.resolve();
      this.activeConfigMutations.clear();
      this.currentSessionId = response.sessionId;
      this.sessionMetadata = metadata;
      if (replacedSessionId && this.canCloseSessions) {
        void connection.agent
          .request(acp.methods.agent.session.close, {
            sessionId: replacedSessionId,
          })
          .catch(() => {
            if (!connection.signal.aborted) {
              console.warn("[ACP] Failed to close replaced session");
            }
          });
      }
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
            replacedSessionMetadata.configOptions = configOptions;
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
    } finally {
      settleSessionTransition();
    }
  }
  async listSessions(
    params: acp.ListSessionsRequest
  ): Promise<acp.ListSessionsResponse> {
    const connection = this.connection;
    if (!connection) {
      throw new Error("Not connected");
    }
    if (!this.supportsSessionListing) {
      throw new Error("Agent does not support session listing");
    }
    return connection.agent.request(acp.methods.agent.session.list, params);
  }

  async loadSession(
    params: acp.LoadSessionRequest
  ): Promise<acp.LoadSessionResponse> {
    if (!this.supportsSessionLoading) {
      throw new Error("Agent does not support session loading");
    }
    return this.restoreSession("load", params);
  }

  async resumeSession(
    params: acp.ResumeSessionRequest
  ): Promise<acp.ResumeSessionResponse> {
    if (!this.supportsSessionResuming) {
      throw new Error("Agent does not support session resuming");
    }
    return this.restoreSession("resume", params);
  }

  private async restoreSession(
    mode: "load" | "resume",
    params: acp.LoadSessionRequest | acp.ResumeSessionRequest
  ): Promise<acp.LoadSessionResponse | acp.ResumeSessionResponse> {
    const sessionId = params.sessionId;
    const connection = this.connection;
    if (!connection) {
      throw new Error("Not connected");
    }
    if (this.pendingSessionRequestGeneration !== null) {
      throw new Error("Session restoration already in progress");
    }

    let settleSessionTransition!: () => void;
    const sessionTransitionSettled = new Promise<void>((resolve) => {
      settleSessionTransition = resolve;
    });
    this.sessionTransitionSettled = sessionTransitionSettled;
    const requestGeneration = ++this.sessionRequestGeneration;
    this.pendingSessionRequestGeneration = requestGeneration;
    this.loadingSessionId = sessionId;
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

      const response =
        mode === "load"
          ? await connection.agent.request(
              acp.methods.agent.session.load,
              params as acp.LoadSessionRequest
            )
          : await connection.agent.request(
              acp.methods.agent.session.resume,
              params as acp.ResumeSessionRequest
            );

      if (
        connection !== this.connection ||
        requestGeneration !== this.sessionRequestGeneration
      ) {
        return response;
      }

      const hasBufferedConfigOptions =
        this.pendingConfigOptionsBySession.has(sessionId);
      const bufferedConfigOptions =
        this.pendingConfigOptionsBySession.get(sessionId);
      const responseConfigOptions = parseSupportedConfigOptions(
        response.configOptions
      );
      const configOptions = hasBufferedConfigOptions
        ? bufferedConfigOptions ?? []
        : responseConfigOptions;
      const modes = response.modes ?? null;
      const bufferedMode = this.pendingModeBySession.get(sessionId);
      if (
        modes &&
        bufferedMode &&
        modes.availableModes.some((available) => available.id === bufferedMode)
      ) {
        modes.currentModeId = bufferedMode;
      }
      const metadata: SessionMetadata = {
        modes,
        configOptions,
        commands: this.pendingCommandsBySession.get(sessionId) ?? null,
      };
      if (replacedSessionId !== sessionId) {
        this.sessionIdentityGeneration++;
        this.configOptionMutationTail = Promise.resolve();
        this.activeConfigMutations.clear();
      }
      this.currentSessionId = sessionId;
      this.sessionMetadata = metadata;
      if (
        replacedSessionId &&
        replacedSessionId !== sessionId &&
        this.canCloseSessions
      ) {
        void connection.agent
          .request(acp.methods.agent.session.close, {
            sessionId: replacedSessionId,
          })
          .catch(() => {
            if (!connection.signal.aborted) {
              console.warn("[ACP] Failed to close replaced session");
            }
          });
      }
      this.pendingSessionRequestGeneration = null;
      this.loadingSessionId = null;
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
            replacedSessionMetadata.configOptions = configOptions;
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
        this.loadingSessionId = null;
        this.pendingCommandsBySession.clear();
        this.pendingConfigOptionsBySession.clear();
        this.pendingModeBySession.clear();
      }
      throw error;
    } finally {
      settleSessionTransition();
    }
  }

  getSessionMetadata(): SessionMetadata | null {
    return this.sessionMetadata;
  }

  /**
   * Sends an agent-managed ACP `authenticate` request.
   *
   * `selectedGeneration` is the {@link getConnectionGeneration} value observed
   * when the method list was presented. A mismatch means the agent process was
   * replaced while the user was choosing, so the selection is discarded instead
   * of being applied to a different agent.
   */
  async authenticate(
    methodId: acp.AuthMethodId,
    selectedGeneration: number
  ): Promise<void> {
    const connection = this.connection;
    const method = this.authenticationMethods.find(
      (candidate) => candidate.id === methodId
    );
    if (!connection) {
      throw new Error("Not connected");
    }
    if (selectedGeneration !== this.connectionGeneration) {
      throw new Error("Authentication selection is stale");
    }
    if (!method || !isAgentAuthMethod(method)) {
      throw new Error("Authentication method is not available");
    }

    await connection.agent.request(acp.methods.agent.authenticate, {
      methodId,
    });

    if (connection !== this.connection) {
      throw new Error("Authentication result is stale");
    }
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

  async setSessionConfigOption(configId: string, value: string): Promise<void> {
    const connection = this.connection;
    const sessionId = this.currentSessionId;
    const sessionIdentityGeneration = this.sessionIdentityGeneration;
    if (!connection || !sessionId) {
      throw new Error("No active session");
    }

    const operation = this.configOptionMutationTail.then(async () => {
      await this.waitForSessionTransition(
        connection,
        sessionIdentityGeneration
      );
      if (
        connection !== this.connection ||
        sessionId !== this.currentSessionId ||
        sessionIdentityGeneration !== this.sessionIdentityGeneration
      ) {
        throw new Error("Configuration selection is stale");
      }
      const option = this.sessionMetadata?.configOptions?.find(
        (candidate) => candidate.id === configId
      );
      if (!option) {
        throw new Error(`Configuration option is not available: ${configId}`);
      }
      if (!hasConfigValue(option, value)) {
        throw new Error(`Configuration value is not available: ${value}`);
      }

      const mutation: ActiveConfigMutation = {
        connection,
        sessionId,
        sessionIdentityGeneration,
        responseReceived: false,
      };
      this.activeConfigMutations.add(mutation);
      try {
        const response = await connection.agent.request(
          acp.methods.agent.session.setConfigOption,
          { sessionId, configId, value }
        );
        mutation.responseReceived = true;
        await this.waitForSessionTransition(
          connection,
          sessionIdentityGeneration
        );
        const configOptions = parseSupportedConfigOptions(
          response.configOptions
        );
        if (configOptions === null) {
          throw new Error("Invalid session configuration options");
        }
        if (
          connection !== this.connection ||
          sessionId !== this.currentSessionId ||
          sessionIdentityGeneration !== this.sessionIdentityGeneration ||
          !this.sessionMetadata
        ) {
          throw new Error("Configuration selection is stale");
        }
        this.sessionMetadata.configOptions =
          mutation.supersedingConfigOptions ?? configOptions;
      } catch (error) {
        await this.waitForSessionTransition(
          connection,
          sessionIdentityGeneration
        );
        const bufferedConfigOptions =
          mutation.supersedingConfigOptions ?? mutation.precedingConfigOptions;
        if (
          bufferedConfigOptions &&
          connection === this.connection &&
          sessionId === this.currentSessionId &&
          sessionIdentityGeneration === this.sessionIdentityGeneration &&
          this.sessionMetadata
        ) {
          this.sessionMetadata.configOptions = bufferedConfigOptions;
        }
        throw error;
      } finally {
        this.activeConfigMutations.delete(mutation);
      }
    });
    this.configOptionMutationTail = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
  }

  async sendMessage(
    message: string,
    attachments?: readonly PromptAttachment[]
  ): Promise<acp.PromptResponse> {
    const connection = this.connection;
    const sessionId = this.currentSessionId;
    if (!connection || !sessionId) {
      throw new Error("No active session");
    }

    const content = buildPromptContent(
      message,
      attachments ?? [],
      this.promptCapabilities
    );
    if (content.length === 0) {
      throw new Error("Cannot send an empty prompt");
    }

    const prompt = { connection, sessionId };
    this.activePrompt = prompt;
    try {
      const response = await connection.agent.request(
        acp.methods.agent.session.prompt,
        {
          sessionId,
          prompt: content,
        }
      );
      console.log(`[ACP] Prompt completed: ${response.stopReason}`);
      return response;
    } catch (error) {
      const code = error instanceof acp.RequestError ? error.code : undefined;
      console.error("[ACP] Prompt request failed", { code });
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
    this.agentInfo = null;
    this.sessionMetadata = null;
    this.pendingCommandsBySession.clear();
    this.pendingConfigOptionsBySession.clear();
    this.pendingModeBySession.clear();
    this.pendingSessionRequestGeneration = null;
    this.sessionIdentityGeneration++;
    this.sessionTransitionSettled = Promise.resolve();
    this.configOptionMutationTail = Promise.resolve();
    this.activeConfigMutations.clear();
    this.canCloseSessions = false;
    this.supportsSessionLoading = false;
    this.supportsSessionListing = false;
    this.supportsSessionResuming = false;
    this.supportsAdditionalSessionDirectories = false;
    this.loadingSessionId = null;
    this.mcpCapabilities = {};
    this.promptCapabilities = {};
    this.activePrompt = null;
    this.authenticationMethods = [];
    this.setState("disconnected");
  }

  private setState(state: ACPConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.stateChangeListeners.forEach((cb) => cb(state));
    }
  }
}
