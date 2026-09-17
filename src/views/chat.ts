import * as vscode from "vscode";
import { spawn, type ChildProcess } from "child_process";
import { createHash, randomUUID } from "crypto";
import { realpath, stat } from "fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "path";
import {
  ACPClient,
  describeACPError,
  formatACPError,
  isAgentAuthMethod,
  type SupportedSessionConfigOption,
  runBoundedTerminationCommand,
} from "../acp/client";
import { getConfiguredSession, McpSecretRedactor } from "../acp/mcp";
import {
  getAgent,
  getAgentsWithStatus,
  getFirstAvailableAgent,
  type AgentDiscoveryOptions,
} from "../acp/agents";
import {
  createAgentEnvironment,
  resolveAgentCommand,
  type AgentCommandResolutionOptions,
} from "../acp/agentCommand";
import { selectAgentPaths } from "../acp/agentPaths";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  canonicalizeUnder,
  isPathWithin,
  openTrustedWorkspaceFile,
  readOpenedWorkspaceFile,
  writeOpenedWorkspaceFile,
  workspaceFileCapabilities,
  type OpenedWorkspaceFile,
} from "../acp/workspace-files";
import type {
  AuthMethodId,
  SessionNotification,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  NewSessionRequest,
} from "@agentclientprotocol/sdk";
import {
  AttachmentInputError,
  createFileAttachment,
  createInlineAttachment,
  createReplayAttachment,
  createSelectionAttachment,
  isTrustedWorkspaceFile,
  pickAttachmentUris,
  prepareFileAttachment,
} from "../attachments";
import {
  MAX_ATTACHMENTS,
  MAX_INLINE_ATTACHMENT_BYTES,
  decodedBase64Size,
  isEmbeddableTextMimeType,
  toAttachmentMetadata,
  type FileAttachment,
  type PromptAttachment,
} from "../shared/attachments";
import {
  readStoredSessions,
  DEFAULT_SESSION_HISTORY_LIMIT,
  updateStoredSessions,
  type StoredSession,
} from "../sessions";
import type { AgentSessionOpenRequest, SessionOpenMode } from "./sessions";

interface WebviewToolLocation {
  path: string;
  label: string;
  line?: number;
}

export const DIRTY_EDITOR_WRITE_CONFLICT =
  "ACP write refused because the file has unsaved editor changes. Save or revert the file, then retry.";

const SELECTED_AGENT_KEY = "vscode-acp.selectedAgent";
const SELECTED_MODE_KEY = "vscode-acp.selectedMode";
const SELECTED_MODEL_KEY = "vscode-acp.selectedModel";
const SELECTED_THOUGHT_LEVEL_KEY = "vscode-acp.selectedThoughtLevel";
const SELECTED_CONFIG_OPTIONS_KEY = "vscode-acp.selectedConfigOptions";

type SessionContext = Pick<
  StoredSession,
  "cwd" | "configurationResource" | "additionalDirectories"
>;

type PersistedSessionConfigCategory = "mode" | "model" | "thought_level";
interface PersistedSessionConfigValue {
  configId: string;
  value: string;
}

interface ReplayMessage {
  role: "user" | "assistant";
  messageId: string | null;
  text: string;
  attachments: FileAttachment[];
}

const PERSISTED_SESSION_CONFIG_KEYS: Record<
  PersistedSessionConfigCategory,
  string
> = {
  mode: SELECTED_MODE_KEY,
  model: SELECTED_MODEL_KEY,
  thought_level: SELECTED_THOUGHT_LEVEL_KEY,
};

const PERSISTED_SESSION_CONFIG_CATEGORIES: readonly PersistedSessionConfigCategory[] =
  ["mode", "model", "thought_level"];

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

interface EditorSelectionContext {
  uri: vscode.Uri;
  text: string;
  startLine: number;
  endLine: number;
}

interface QueuedEditorSelection {
  selection: EditorSelectionContext;
  conversationGeneration: number;
}

interface AuthenticationPickItem extends vscode.QuickPickItem {
  methodId: AuthMethodId;
}

/**
 * VS Code substitutes `$(name)` in quick pick labels with a codicon glyph. Auth
 * method names and descriptions come straight from the agent process, so the
 * sequence is escaped to stop an agent rendering trust iconography (for example
 * `$(verified)`) inside the authentication prompt.
 */
function escapeQuickPickIcons(value: string): string {
  return value.replace(/\$\(/g, "\\$(");
}

interface WebviewMessage {
  type:
    | "sendMessage"
    | "ready"
    | "selectAgent"
    | "selectMode"
    | "selectModel"
    | "selectConfigOption"
    | "connect"
    | "newChat"
    | "clearChat"
    | "copyMessage"
    | "permissionResponse"
    | "selectSession"
    | "deleteSession"
    | "requestAttachFiles"
    | "attachContent"
    | "removeAttachment"
    | "openToolLocation";
  text?: string;
  name?: string;
  data?: string;
  mimeType?: string;
  agentId?: string;
  modeId?: string;
  modelId?: string;
  configId?: string;
  value?: string;
  requestId?: string;
  sessionId?: string;
  optionId?: string;
  cancelled?: boolean;
  attachmentIds?: string[];
  attachmentId?: string;
  attachmentCount?: number;
  locationPath?: string;
  locationLine?: number;
}

interface ManagedTerminal {
  id: string;
  sessionId: string;
  generation: number;
  terminal?: vscode.Terminal;
  proc: ChildProcess | null;
  processId: number | null;
  output: string;
  outputByteLimit: number | null;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exitPromise: Promise<void>;
  exitResolve: () => void;
  waitAbortPromise: Promise<void>;
  waitAbortResolve: () => void;
  waitPending: boolean;
  closing: boolean;
  terminationPromise: Promise<boolean> | null;
}

interface TerminalExecutable {
  args: string[];
  command: string;
}

interface TerminalLaunchDescriptor extends TerminalExecutable {
  cwd: string;
  env: Record<string, string>;
}

interface PreparedTerminalLaunch extends TerminalExecutable {
  cwd: string;
  env: NodeJS.ProcessEnv;
  descriptor: TerminalLaunchDescriptor;
  outputByteLimit: number | null;
}

const SAFE_INHERITED_ENVIRONMENT_NAMES = [
  "COLORTERM",
  "ComSpec",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
] as const;

const MAX_TERMINAL_PERMISSION_BYTES = 3000;
const MAX_TERMINAL_PERMISSION_ARGUMENTS = 50;
const MAX_TERMINAL_PERMISSION_VALUE_LENGTH = 1024;
const TERMINAL_CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Ceiling for retained terminal output when the agent supplies no
 * `outputByteLimit`. Without it a single approved long-running command can
 * grow an unbounded string in the extension host.
 */
const MAX_TERMINAL_OUTPUT_BYTES = 1_048_576;
/** Concurrent prompts an agent can force onto the user before we fail closed. */
const MAX_PENDING_PERMISSION_REQUESTS = 16;
/** Upper bound on retained grants so approvals cannot grow without limit. */
const MAX_TERMINAL_GRANTS = 64;
/** Small fixed envelope for one untrusted permission prompt. */
const MAX_PERMISSION_OPTIONS = 4;
const MAX_PERMISSION_OPTION_VALUE_LENGTH = 256;
const MAX_PERMISSION_PAYLOAD_BYTES = 32_768;
const MAX_PERMISSION_PAYLOAD_VALUE_LENGTH = 4096;
const MAX_PERMISSION_PAYLOAD_ENTRIES = 100;
const MAX_PERMISSION_PAYLOAD_DEPTH = 5;
const SENSITIVE_PERMISSION_KEYS =
  /authorization|credential|key|password|secret|token/i;
/**
 * `cmd.exe` truncates command lines beyond 8191 characters, so anything close
 * to that ceiling is refused rather than silently altered.
 */
const MAX_WINDOWS_COMMAND_LINE = 8000;
/** Live child processes one session may hold open at a time. */
const MAX_ACTIVE_TERMINALS = 8;
const TERMINAL_TERMINATION_GRACE_MS = 1000;
const MAX_TOOL_LOCATIONS = 20;
const MAX_TOOL_LOCATION_PATH_LENGTH = 4096;
const MAX_TOOL_LOCATION_LABEL_LENGTH = 160;
const TOOL_LOCATION_UNSAFE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const TOOL_LOCATION_DISPLAY_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;
const TOOL_LOCATION_ERROR =
  "Could not open this tool location. It must be an existing file inside a trusted local workspace.";

/**
 * Fields the user actually reviews in the permission modal. A grant is only
 * ever derived from a payload that contains nothing else.
 */
const REVIEWABLE_TERMINAL_KEYS: Record<string, true> = {
  command: true,
  args: true,
  cwd: true,
  env: true,
};
/**
 * Fields `terminal/create` may add on the wire. `sessionId` is bound through
 * the hash input and `outputByteLimit` only caps retained output, so neither
 * can widen what the user approved.
 */
const CREATE_TERMINAL_KEYS: Record<string, true> = {
  ...REVIEWABLE_TERMINAL_KEYS,
  sessionId: true,
  outputByteLimit: true,
};
const PERMISSION_OPTION_KINDS: Record<string, true> = {
  allow_once: true,
  allow_always: true,
  reject_once: true,
  reject_always: true,
};

function isWithinWorkspaceRoot(candidate: string, root: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function isSupportedPermissionOption(option: unknown): option is {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
} {
  if (!option || typeof option !== "object") {
    return false;
  }
  const candidate = option as Record<string, unknown>;
  return (
    typeof candidate.optionId === "string" &&
    candidate.optionId.length > 0 &&
    candidate.optionId.length <= MAX_PERMISSION_OPTION_VALUE_LENGTH &&
    !TERMINAL_CONTROL_CHARACTERS.test(candidate.optionId) &&
    typeof candidate.name === "string" &&
    candidate.name.length <= MAX_PERMISSION_OPTION_VALUE_LENGTH &&
    !TERMINAL_CONTROL_CHARACTERS.test(candidate.name) &&
    typeof candidate.kind === "string" &&
    PERMISSION_OPTION_KINDS[candidate.kind] === true
  );
}

function isBoundedPermissionPayload(value: unknown): boolean {
  let entries = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > MAX_PERMISSION_PAYLOAD_DEPTH) {
      return false;
    }
    if (typeof candidate === "string") {
      return candidate.length <= MAX_PERMISSION_PAYLOAD_VALUE_LENGTH;
    }
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "number"
    ) {
      return true;
    }
    if (typeof candidate !== "object") {
      return false;
    }
    const values = Array.isArray(candidate)
      ? candidate
      : Object.values(candidate as Record<string, unknown>);
    if (values.length > MAX_TERMINAL_PERMISSION_ARGUMENTS) {
      return false;
    }
    entries += values.length;
    return (
      entries <= MAX_PERMISSION_PAYLOAD_ENTRIES &&
      values.every((entry) => visit(entry, depth + 1))
    );
  };

  if (!visit(value, 0)) {
    return false;
  }
  try {
    const serialized = JSON.stringify(value);
    return (
      typeof serialized === "string" &&
      Buffer.byteLength(serialized, "utf8") <= MAX_PERMISSION_PAYLOAD_BYTES
    );
  } catch {
    return false;
  }
}

function permissionPayloadHasHiddenValues(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      SENSITIVE_PERMISSION_KEYS.test(key) ||
      key === "value" ||
      permissionPayloadHasHiddenValues(entry)
  );
}

function terminalLaunchDescriptor(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): TerminalLaunchDescriptor {
  return {
    args: [...args],
    command,
    cwd,
    env: Object.fromEntries(
      Object.entries(env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
    ),
  };
}

function terminalLaunchKey(
  sessionId: string,
  descriptor: TerminalLaunchDescriptor
): string {
  return createHash("sha256")
    .update(JSON.stringify({ descriptor, sessionId }))
    .digest("base64url");
}

/**
 * Canonical, collision-resistant identity of a terminal request.
 *
 * The same canonical form is hashed for the reviewed payload and for the
 * later `terminal/create`, so a grant can only be redeemed by a byte-identical
 * command, argument vector, cwd, and empty environment inside the same
 * session. `allowedKeys` differs between the two call sites because the wire
 * request carries transport fields the reviewed payload never has.
 */
function terminalPermissionKey(
  sessionId: string,
  value: unknown,
  allowedKeys: Record<string, true> = REVIEWABLE_TERMINAL_KEYS
): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (
    keys.some((key) => allowedKeys[key] !== true) ||
    typeof request.command !== "string" ||
    request.command.length === 0 ||
    request.command.length > MAX_TERMINAL_PERMISSION_VALUE_LENGTH ||
    TERMINAL_CONTROL_CHARACTERS.test(request.command) ||
    (request.cwd !== undefined &&
      request.cwd !== null &&
      (typeof request.cwd !== "string" ||
        request.cwd.length > MAX_TERMINAL_PERMISSION_VALUE_LENGTH ||
        TERMINAL_CONTROL_CHARACTERS.test(request.cwd))) ||
    (request.args !== undefined &&
      (!Array.isArray(request.args) ||
        request.args.length > MAX_TERMINAL_PERMISSION_ARGUMENTS ||
        request.args.some(
          (arg) =>
            typeof arg !== "string" ||
            arg.length > MAX_TERMINAL_PERMISSION_VALUE_LENGTH ||
            TERMINAL_CONTROL_CHARACTERS.test(arg)
        ))) ||
    (request.env !== undefined &&
      (!Array.isArray(request.env) || request.env.length > 0))
  ) {
    return null;
  }

  const serialized = JSON.stringify({
    args: request.args ?? [],
    command: request.command,
    cwd: request.cwd ?? null,
    env: [],
    sessionId,
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_TERMINAL_PERMISSION_BYTES) {
    return null;
  }
  return createHash("sha256").update(serialized).digest("base64url");
}

/**
 * Quotes a `.cmd`/`.bat` invocation for `cmd.exe /d /s /c`.
 *
 * Exported so the quoting rules are verifiable on every platform, not only on
 * the Windows runner. Metacharacters are rejected rather than escaped because
 * `cmd.exe` has no escape that survives every parsing stage, and an
 * over-length line is rejected because `cmd.exe` silently truncates at 8191
 * characters, which would run something other than what the user reviewed.
 */
export function buildWindowsBatchCommandLine(
  candidate: string,
  args: string[]
): string {
  const parts = [candidate, ...args];
  if (parts.some((value) => /["&|<>()^%!]/.test(value))) {
    throw new Error("Windows batch command contains unsupported characters.");
  }
  const commandLine = parts.map((value) => `"${value}"`).join(" ");
  if (commandLine.length > MAX_WINDOWS_COMMAND_LINE) {
    throw new Error("Windows batch command line is too long.");
  }
  return commandLine;
}

async function resolveTerminalExecutable(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  workspaceRoots: string[],
  options: AgentCommandResolutionOptions
): Promise<TerminalExecutable> {
  const resolutionOptions: AgentCommandResolutionOptions = {
    ...options,
    env,
    excludedDirectories: [
      ...(options.excludedDirectories ?? []),
      ...workspaceRoots,
    ],
  };
  const executable = resolveAgentCommand(command, args, resolutionOptions);
  if (executable) {
    return { command: executable.command, args: executable.args };
  }

  // Arbitrary explicit batch files cannot be decoded like npm shims. They are
  // still safe to launch through cmd.exe when both paths are absolute and the
  // reviewed argv contains no cmd metacharacters.
  if (
    process.platform === "win32" &&
    isAbsolute(command) &&
    /\.(cmd|bat)$/i.test(command)
  ) {
    const candidate = await realpath(command);
    const commandLine = buildWindowsBatchCommandLine(candidate, args);
    const commandProcessor = resolveAgentCommand(
      env.ComSpec ??
        join(
          env.SystemRoot ?? env.WINDIR ?? "C:\\Windows",
          "System32",
          "cmd.exe"
        ),
      [],
      resolutionOptions
    );
    if (commandProcessor) {
      return {
        command: commandProcessor.command,
        args: ["/d", "/s", "/c", `"${commandLine}"`],
      };
    }
  }

  throw new Error("Terminal command is unavailable.");
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vscode-acp.chatView";

  private view?: vscode.WebviewView;
  private hasSession = false;
  private globalState: vscode.Memento;
  private workspaceState: vscode.Memento;
  private streamingText = "";
  private hasRestoredLegacyMode = false;
  private isReplaying = false;
  private replayMessages: ReplayMessage[] = [];
  private connectionStart: Promise<void> | null = null;
  private sessionStart: Promise<void> | null = null;
  private sessionTransition: Promise<void> | null = null;
  private lifecycleCommandGeneration = 0;
  private sessionTransitionLabel: string | null = null;
  private sessionTransitionInputPaused = false;
  private activeSessionContext: SessionContext | null = null;
  private conversationGeneration = 0;
  private activePromptGeneration: number | null = null;
  private replayGeneration: number | null = null;
  private disposed = false;
  private terminals: Map<string, ManagedTerminal> = new Map();
  private retiringTerminals = new Set<ManagedTerminal>();
  private terminalCleanup: Promise<void> = Promise.resolve();
  private terminalGeneration = 0;
  private pendingTerminalCreates = 0;
  /**
   * Redeemable terminal grants keyed by the exact raw request identity. The
   * resolved descriptor binds the effective executable, argv, cwd, and env;
   * uses counts independently approved allow_once decisions.
   */
  private terminalPermissionGrants = new Map<
    string,
    { descriptorKey: string; persistent: boolean; uses: number }
  >();
  private permissionEpoch = 0;
  private permissionRequests: Map<
    string,
    {
      resolve: (response: RequestPermissionResponse) => void;
      timeoutId: NodeJS.Timeout;
      optionIds: Set<string>;
      epoch: number;
    }
  > = new Map();
  private readonly permissionRequestTimeoutMs = 60000;
  private readonly configurationSubscription: vscode.Disposable;
  private readonly workspaceTrustSubscription: vscode.Disposable;
  private pendingAttachments: Map<string, PromptAttachment> = new Map();
  private attachmentCounter = 0;
  private attachmentPickerActive = false;
  private attachmentDraftVersion = 0;
  private webviewReady = false;
  private queuedEditorSelections: QueuedEditorSelection[] = [];
  private editorSelectionPreparations = 0;
  private readonly openWorkspaceFile = openTrustedWorkspaceFile;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly acpClient: ACPClient,
    globalState: vscode.Memento,
    workspaceState: vscode.Memento = globalState,
    private readonly getAgentResolutionOptions: () => AgentCommandResolutionOptions = () => ({}),
    private readonly shouldPersistSessions: () => boolean = () =>
      vscode.workspace
        .getConfiguration("vscode-acp")
        .get<boolean>("sessions.autoSave", true)
  ) {
    this.globalState = globalState;
    this.workspaceState = workspaceState;

    const savedAgentId = this.globalState.get<string>(SELECTED_AGENT_KEY);
    if (savedAgentId) {
      const agent = this.getConfiguredAgent(savedAgentId);
      if (agent) {
        this.acpClient.setAgent(agent);
      }
    } else {
      this.acpClient.setAgent(
        getFirstAvailableAgent(this.getAgentDiscoveryOptions())
      );
    }

    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration("vscode-acp.agentPaths")) {
          this.refreshAgentConfiguration();
        }
      }
    );
    this.workspaceTrustSubscription = vscode.workspace.onDidGrantWorkspaceTrust(
      () => this.refreshAgentConfiguration()
    );

    this.acpClient.setOnStateChange((state) => {
      if (this.disposed) {
        return;
      }
      if (state === "disconnected" || state === "error") {
        this.handleConnectionEnded();
      }
      this.sendConnectionState(state);
    });

    this.acpClient.setOnSessionUpdate((update) => {
      this.handleSessionUpdate(update);
    });
    this.acpClient.setOnStderr((text) => {
      this.handleStderr(text);
    });

    this.acpClient.setFileSystemCapabilities(workspaceFileCapabilities);

    this.acpClient.setOnReadTextFile(async (params: ReadTextFileRequest) => {
      return this.handleReadTextFile(params);
    });

    this.acpClient.setOnWriteTextFile(async (params: WriteTextFileRequest) => {
      return this.handleWriteTextFile(params);
    });

    this.acpClient.setOnCreateTerminal(
      async (params: CreateTerminalRequest) => {
        return this.handleCreateTerminal(params);
      }
    );

    this.acpClient.setOnTerminalOutput(
      async (params: TerminalOutputRequest) => {
        return this.handleTerminalOutput(params);
      }
    );

    this.acpClient.setOnWaitForTerminalExit(
      async (params: WaitForTerminalExitRequest) => {
        return this.handleWaitForTerminalExit(params);
      }
    );

    this.acpClient.setOnKillTerminalCommand(
      async (params: KillTerminalRequest) => {
        return this.handleKillTerminalCommand(params);
      }
    );

    this.acpClient.setOnReleaseTerminal(
      async (params: ReleaseTerminalRequest) => {
        return this.handleReleaseTerminal(params);
      }
    );

    this.acpClient.setOnRequestPermission(
      async (params: RequestPermissionRequest) => {
        return this.handleRequestPermission(params);
      }
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    if (this.view && this.view !== webviewView) {
      this.expirePermissionRequests();
    }
    this.view = webviewView;
    this.webviewReady = false;

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.webviewReady = false;
        this.queuedEditorSelections = [];
        this.expirePermissionRequests();
      }
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case "sendMessage":
          if (message.text || (message.attachmentIds?.length ?? 0) > 0) {
            await this.handleUserMessage(
              message.text ?? "",
              message.attachmentIds
            );
          }
          break;
        case "selectAgent":
          if (message.agentId) {
            this.handleAgentChange(message.agentId);
          }
          break;
        case "selectMode":
          if (message.modeId) {
            await this.handleModeChange(message.modeId);
          }
          break;
        case "selectModel":
          if (message.modelId) {
            await this.handleModelChange(message.modelId);
          }
          break;
        case "selectConfigOption":
          if (message.configId !== undefined && message.value !== undefined) {
            await this.handleConfigOptionChange(
              message.configId,
              message.value
            );
          }
          break;
        case "connect":
          await this.handleConnect();
          break;
        case "newChat":
          await this.handleNewChat();
          break;
        case "clearChat":
          this.handleClearChat();
          break;
        case "copyMessage":
          if (message.text) {
            await vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage("Message copied to clipboard");
          }
          break;
        case "permissionResponse":
          this.handlePermissionResponse(message);
          break;
        case "selectSession":
          if (message.sessionId) {
            await this.handleSelectStoredSession(message.sessionId);
          }
          break;
        case "deleteSession":
          if (message.sessionId) {
            await this.handleDeleteStoredSession(message.sessionId);
          }
          break;
        case "requestAttachFiles":
          await this.handleRequestAttachFiles(message.attachmentCount ?? 0);
          break;
        case "attachContent":
          this.handleAttachContent(message);
          break;
        case "removeAttachment":
          this.pendingAttachments.delete(message.attachmentId ?? "");
          break;
        case "openToolLocation":
          await this.handleOpenToolLocation(
            message.locationPath,
            message.locationLine
          );
          break;
        case "ready": {
          // A freshly loaded composer starts with an empty attachment bar;
          // drop any draft the previous webview instance owned so its files
          // do not keep consuming the per-prompt budget invisibly.
          this.clearPendingAttachments();
          this.webviewReady = true;
          this.sendConnectionState();
          this.sendAgentStatus();
          this.sendSessionMetadata();
          if (
            this.sessionTransitionLabel &&
            !this.sessionTransitionInputPaused
          ) {
            this.postMessage({
              type: "sessionTransition",
              active: true,
              text: this.sessionTransitionLabel,
            });
          }
          const queuedSelections = this.queuedEditorSelections.splice(0);
          for (const queued of queuedSelections) {
            if (queued.conversationGeneration === this.conversationGeneration) {
              await this.addEditorSelection(queued.selection);
            }
          }
          break;
        }
      }
    });
  }

  public newChat(): void {
    this.postMessage({ type: "triggerNewChat" });
  }

  public clearChat(): void {
    this.postMessage({ type: "triggerClearChat" });
  }

  public async connect(): Promise<void> {
    await this.handleConnect();
  }

  public async addEditorSelection(
    selection: EditorSelectionContext
  ): Promise<void> {
    if (selection.text.length === 0) {
      return;
    }
    if (this.sessionTransition || this.isReplaying) {
      void vscode.window.showWarningMessage(
        "Wait for the current conversation transition before adding a selection."
      );
      return;
    }
    this.queuedEditorSelections = this.queuedEditorSelections.filter(
      (queued) => queued.conversationGeneration === this.conversationGeneration
    );
    if (!this.webviewReady) {
      if (
        this.pendingAttachments.size + this.queuedEditorSelections.length >=
        MAX_ATTACHMENTS
      ) {
        void vscode.window.showWarningMessage(
          `You can attach up to ${MAX_ATTACHMENTS} files or selections per prompt.`
        );
        return;
      }
      this.queuedEditorSelections.push({
        selection,
        conversationGeneration: this.conversationGeneration,
      });
      return;
    }
    if (this.pendingAttachments.size >= MAX_ATTACHMENTS) {
      void vscode.window.showWarningMessage(
        `You can attach up to ${MAX_ATTACHMENTS} files or selections per prompt.`
      );
      return;
    }
    if (
      !Number.isSafeInteger(selection.startLine) ||
      !Number.isSafeInteger(selection.endLine) ||
      selection.startLine < 1 ||
      selection.endLine < selection.startLine
    ) {
      void vscode.window.showWarningMessage(
        "Only selections from files inside a trusted local workspace can be added to chat."
      );
      return;
    }

    const draftVersion = this.attachmentDraftVersion;
    const generation = this.conversationGeneration;
    const originatingView = this.view;
    this.editorSelectionPreparations += 1;
    if (this.editorSelectionPreparations === 1) {
      this.postMessage({ type: "attachmentPreparation", active: true });
    }
    try {
      const trusted = await isTrustedWorkspaceFile(selection.uri);
      if (
        draftVersion !== this.attachmentDraftVersion ||
        generation !== this.conversationGeneration ||
        originatingView !== this.view ||
        !this.webviewReady ||
        this.sessionTransition !== null ||
        this.isReplaying
      ) {
        return;
      }
      if (!trusted) {
        void vscode.window.showWarningMessage(
          "Only selections from files inside a trusted local workspace can be added to chat."
        );
        return;
      }
      if (this.pendingAttachments.size >= MAX_ATTACHMENTS) {
        void vscode.window.showWarningMessage(
          `You can attach up to ${MAX_ATTACHMENTS} files or selections per prompt.`
        );
        return;
      }

      const relativePath = vscode.workspace
        .asRelativePath(selection.uri, true)
        .replace(/\\/g, "/");
      const lines =
        selection.startLine === selection.endLine
          ? `L${selection.startLine}`
          : `L${selection.startLine}-L${selection.endLine}`;
      const attachment = createSelectionAttachment(
        `${relativePath}:${lines}`,
        selection.text,
        this.nextAttachmentId(),
        this.pendingInlineBytes()
      );
      this.pendingAttachments.set(attachment.id, attachment);
      const published =
        (await originatingView?.webview.postMessage({
          type: "filesAttached",
          attachments: [toAttachmentMetadata(attachment)],
        })) ?? false;
      if (
        !published ||
        draftVersion !== this.attachmentDraftVersion ||
        generation !== this.conversationGeneration ||
        originatingView !== this.view ||
        !this.webviewReady
      ) {
        if (this.pendingAttachments.get(attachment.id) === attachment) {
          this.pendingAttachments.delete(attachment.id);
        }
        return;
      }
      this.postMessage({ type: "focusComposer" });
    } catch (error) {
      void vscode.window.showWarningMessage(
        error instanceof AttachmentInputError
          ? error.message
          : "The selection could not be added to chat."
      );
    } finally {
      this.editorSelectionPreparations -= 1;
      if (this.editorSelectionPreparations === 0) {
        this.postMessage({ type: "attachmentPreparation", active: false });
      }
    }
  }

  public async loadSession(): Promise<void> {
    await this.showSessionHistory("load");
  }

  public async deleteSession(): Promise<void> {
    await this.showSessionHistory("delete");
  }

  public async disconnectAgent(): Promise<void> {
    ++this.lifecycleCommandGeneration;
    const cleanup = this.disconnectCurrentAgent();
    void cleanup.catch(() => undefined);
    await this.runSessionTransition("Disconnecting agent…", async () => {
      await cleanup;
    });
  }

  public async restartAgent(): Promise<void> {
    const commandGeneration = ++this.lifecycleCommandGeneration;
    const cleanup = this.disconnectCurrentAgent();
    void cleanup.catch(() => undefined);
    this.clearPendingAttachments();
    this.postMessage({ type: "chatCleared" });
    await this.runSessionTransition("Restarting agent…", async () => {
      await cleanup;
      if (commandGeneration !== this.lifecycleCommandGeneration) {
        return;
      }
      const generation = this.conversationGeneration;
      try {
        await this.startWorkspaceSession(generation);
      } catch (error) {
        if (commandGeneration !== this.lifecycleCommandGeneration) {
          return;
        }
        throw this.mcpSecretRedactor.redactError(error);
      }
    });
  }

  private refreshAgentConfiguration(): void {
    const selectedAgent = this.getConfiguredAgent(this.acpClient.getAgentId());
    if (selectedAgent) {
      this.acpClient.setAgent(selectedAgent);
    }
    this.sendAgentStatus();
  }
  private getAgentDiscoveryOptions(): AgentDiscoveryOptions {
    const configuration = vscode.workspace.getConfiguration("vscode-acp");
    const agentPaths = selectAgentPaths(
      configuration.inspect<Record<string, string>>("agentPaths"),
      vscode.workspace.isTrusted
    );
    return { ...this.getAgentResolutionOptions(), agentPaths };
  }

  private getConfiguredAgent(agentId: string) {
    return getAgent(agentId, this.getAgentDiscoveryOptions().agentPaths);
  }

  private sendAgentStatus(): void {
    const agentsWithStatus = getAgentsWithStatus(
      this.getAgentDiscoveryOptions()
    );
    this.postMessage({
      type: "agents",
      agents: agentsWithStatus.map((agent) => ({
        id: agent.id,
        name: agent.name,
        available: agent.available,
      })),
      selected: this.acpClient.getAgentId(),
    });
  }

  private async showSessionHistory(mode: "load" | "delete"): Promise<void> {
    try {
      if (mode === "load") {
        await this.ensureConnection();
      }
      if (mode === "load") {
        const capabilities = this.acpClient.getSessionCapabilities();
        if (!capabilities.load && !capabilities.resume) {
          vscode.window.showErrorMessage(
            "The selected agent does not support loading or resuming previous sessions."
          );
          return;
        }
      }

      const sessions = this.getStoredSessions().filter(
        (session) => session.agentId === this.acpClient.getAgentId()
      );
      if (sessions.length === 0) {
        vscode.window.showInformationMessage(
          "No saved sessions are available for the selected agent."
        );
        return;
      }

      this.postMessage({ type: "sessionHistory", mode, sessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Failed to show session history: ${message}`
      );
    }
  }

  private async handleSelectStoredSession(sessionId: string): Promise<void> {
    const session = this.getStoredSessions().find(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.agentId === this.acpClient.getAgentId()
    );
    if (!session) {
      this.postMessage({
        type: "replayFailed",
        text: "Session is no longer available.",
      });
      this.settleSessionLock();
      return;
    }
    const capabilities = this.acpClient.getSessionCapabilities();
    const mode: SessionOpenMode = capabilities.load ? "load" : "resume";
    await this.openAgentSession({ ...session, mode });
  }

  private async handleDeleteStoredSession(sessionId: string): Promise<void> {
    const agentId = this.acpClient.getAgentId();
    try {
      let deleted = false;
      await updateStoredSessions(this.workspaceState, (history) => {
        const updated = history.filter(
          (entry) => entry.sessionId !== sessionId || entry.agentId !== agentId
        );
        deleted = updated.length !== history.length;
        return updated;
      });
      if (deleted) {
        this.postMessage({ type: "sessionDeleted", sessionId });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.postMessage({
        type: "replayFailed",
        text: `Failed to delete session: ${message}`,
      });
    }
  }

  private getStoredSessions(): StoredSession[] {
    return readStoredSessions(this.workspaceState);
  }

  private async saveCurrentSession(preview?: string): Promise<void> {
    if (!this.shouldPersistSessions()) {
      return;
    }
    const configuration = vscode.workspace.getConfiguration("vscode-acp");
    const sessionId = this.acpClient.getCurrentSessionId();
    if (!sessionId) {
      return;
    }

    const configuredLimit = configuration.get<number>(
      "sessions.maxHistory",
      DEFAULT_SESSION_HISTORY_LIMIT
    );
    const limit = Number.isFinite(configuredLimit)
      ? Math.max(1, Math.min(200, Math.floor(configuredLimit)))
      : DEFAULT_SESSION_HISTORY_LIMIT;
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const sessionContext = this.activeSessionContext ?? {
      cwd: workspaceFolder?.uri.fsPath || process.cwd(),
      configurationResource: workspaceFolder?.uri.toString(),
    };
    const agentId = this.acpClient.getAgentId();
    const normalizedPreview = preview
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const now = Date.now();
    await updateStoredSessions(this.workspaceState, (history) => {
      const existing = history.find(
        (session) =>
          session.sessionId === sessionId && session.agentId === agentId
      );
      const additionalDirectories =
        sessionContext.additionalDirectories !== undefined
          ? sessionContext.additionalDirectories
          : existing?.cwd === sessionContext.cwd
            ? existing.additionalDirectories
            : undefined;
      const entry: StoredSession = {
        sessionId,
        agentId,
        configurationResource: sessionContext.configurationResource,
        cwd: sessionContext.cwd,
        ...(additionalDirectories?.length
          ? { additionalDirectories: [...additionalDirectories] }
          : {}),
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
        preview: normalizedPreview || existing?.preview || "",
        messageCount: (existing?.messageCount ?? 0) + (preview ? 1 : 0),
      };
      return [
        entry,
        ...history.filter(
          (session) =>
            session.sessionId !== sessionId || session.agentId !== agentId
        ),
      ]
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .slice(0, limit);
    });
  }

  private async loadStoredSession(session: StoredSession): Promise<void> {
    await this.openAgentSession({ ...session, mode: "load" });
  }

  public async openAgentSession(
    request: AgentSessionOpenRequest
  ): Promise<boolean> {
    let opened = false;
    await this.runSessionTransition(
      request.mode === "load"
        ? "Loading conversation history…"
        : "Resuming conversation…",
      async () => {
        const sameAgent = this.acpClient.getAgentId() === request.agentId;
        const agent = sameAgent
          ? undefined
          : this.getConfiguredAgent(request.agentId);
        if (!sameAgent && !agent) {
          throw new Error("The selected agent is no longer configured");
        }
        const previousSessionContext = this.activeSessionContext;
        const hadSession = sameAgent && this.hasSession;
        const hadRestoredLegacyMode = sameAgent && this.hasRestoredLegacyMode;
        let generation = ++this.conversationGeneration;
        this.expirePermissionRequests();
        await this.disposeTerminals();
        if (!this.isCurrentConversation(generation)) {
          return;
        }

        if (!sameAgent) {
          this.mcpSecretRedactor.clear();
          this.acpClient.setAgent(agent!);
          generation = ++this.conversationGeneration;
          void Promise.resolve(
            this.globalState.update(SELECTED_AGENT_KEY, request.agentId)
          ).catch(() => {
            console.warn("[Chat] Failed to persist selected agent");
          });
          this.hasSession = false;
          this.activeSessionContext = null;
          this.clearPendingAttachments();
          this.postMessage({ type: "agentChanged", agentId: request.agentId });
          this.postMessage({
            type: "sessionMetadata",
            modes: null,
            models: null,
            commands: null,
          });
          this.sendAgentStatus();
        }

        this.isReplaying = request.mode === "load";
        this.replayGeneration = this.isReplaying ? generation : null;
        this.replayMessages = [];
        if (this.isReplaying) {
          this.postMessage({ type: "replayStart" });
        }

        try {
          await this.ensureConnection();
          if (!this.isCurrentConversation(generation)) {
            return;
          }
          const capabilities = this.acpClient.getSessionCapabilities();
          if (!capabilities[request.mode]) {
            throw new Error(
              request.mode === "load"
                ? "Agent does not support session loading"
                : "Agent does not support session resuming"
            );
          }
          const resource = request.configurationResource
            ? vscode.Uri.parse(request.configurationResource)
            : (vscode.workspace.workspaceFolders ?? []).find((folder) =>
                isPathWithin(folder.uri.fsPath, request.cwd)
              )?.uri;
          const parameters = await this.getSessionParameters(
            request.cwd,
            resource,
            generation
          );
          if (!parameters || !this.isCurrentConversation(generation)) {
            return;
          }
          const sessionRequest = {
            sessionId: request.sessionId,
            ...parameters,
            ...(capabilities.additionalDirectories &&
            request.additionalDirectories?.length
              ? {
                  additionalDirectories: [...request.additionalDirectories],
                }
              : {}),
          };
          await this.requestSessionWithAuthentication(
            () =>
              request.mode === "load"
                ? this.acpClient.loadSession(sessionRequest)
                : this.acpClient.resumeSession(sessionRequest),
            generation,
            request.mode === "load"
              ? () => {
                  this.replayMessages = [];
                }
              : undefined
          );
          if (!this.isCurrentConversation(generation)) {
            return;
          }

          this.activeSessionContext = {
            cwd: request.cwd,
            configurationResource:
              request.configurationResource ?? resource?.toString(),
            ...(request.additionalDirectories !== undefined
              ? {
                  additionalDirectories: [...request.additionalDirectories],
                }
              : {}),
          };
          this.hasSession = true;
          this.hasRestoredLegacyMode = false;
          await this.touchStoredSession({
            ...request,
            configurationResource:
              request.configurationResource ?? resource?.toString(),
          }).catch(() => {
            console.warn("[Chat] Failed to update session metadata");
          });
          if (
            !this.isCurrentConversation(generation) ||
            this.acpClient.getAgentId() !== request.agentId ||
            this.acpClient.getCurrentSessionId() !== request.sessionId
          ) {
            return;
          }
          this.isReplaying = false;
          this.replayGeneration = null;
          this.clearPendingAttachments();
          if (request.mode === "load") {
            this.postMessage({
              type: "replayComplete",
              messages: this.replayMessages.map((message) => ({
                role: message.role,
                text: message.text,
                ...(message.attachments.length > 0
                  ? { attachments: message.attachments }
                  : {}),
              })),
            });
          } else {
            this.postMessage({ type: "chatCleared" });
            vscode.window.showInformationMessage(
              "Session resumed without replaying conversation history."
            );
          }
          this.replayMessages = [];
          this.sendSessionMetadata();
          opened = true;
        } catch (error) {
          if (!this.isCurrentConversation(generation)) {
            return;
          }
          const redacted = this.mcpSecretRedactor.redactError(error);
          this.isReplaying = false;
          this.replayGeneration = null;
          this.replayMessages = [];
          this.hasSession = hadSession;
          this.hasRestoredLegacyMode = hadRestoredLegacyMode;
          this.activeSessionContext = sameAgent ? previousSessionContext : null;
          this.postMessage({
            type: "replayFailed",
            text: formatACPError(redacted),
          });
          this.sendSessionMetadata();
          throw redacted;
        }
      }
    );
    return opened;
  }

  private async touchStoredSession(
    session: AgentSessionOpenRequest
  ): Promise<void> {
    if (!this.shouldPersistSessions()) {
      return;
    }
    const configuration = vscode.workspace.getConfiguration("vscode-acp");
    const configuredLimit = configuration.get<number>(
      "sessions.maxHistory",
      DEFAULT_SESSION_HISTORY_LIMIT
    );
    const limit = Number.isFinite(configuredLimit)
      ? Math.max(1, Math.min(200, Math.floor(configuredLimit)))
      : DEFAULT_SESSION_HISTORY_LIMIT;
    const now = Date.now();
    await updateStoredSessions(this.workspaceState, (history) => {
      const existing = history.find(
        (entry) =>
          entry.sessionId === session.sessionId &&
          entry.agentId === session.agentId
      );
      const additionalDirectories =
        session.additionalDirectories !== undefined
          ? session.additionalDirectories
          : existing?.cwd === session.cwd
            ? existing.additionalDirectories
            : undefined;
      const updated: StoredSession = {
        sessionId: session.sessionId,
        agentId: session.agentId,
        cwd: session.cwd,
        ...(session.configurationResource
          ? { configurationResource: session.configurationResource }
          : {}),
        ...(additionalDirectories?.length
          ? { additionalDirectories: [...additionalDirectories] }
          : {}),
        createdAt: existing?.createdAt ?? now,
        lastUsedAt: now,
        preview: session.preview ?? existing?.preview ?? "",
        messageCount: existing?.messageCount ?? 0,
      };
      return [
        updated,
        ...history.filter(
          (entry) =>
            entry.sessionId !== session.sessionId ||
            entry.agentId !== session.agentId
        ),
      ]
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .slice(0, limit);
    });
  }
  private findOrCreateReplayMessage(
    role: ReplayMessage["role"],
    messageId: string | null | undefined
  ): ReplayMessage {
    const previous = this.replayMessages.at(-1);
    if (
      previous &&
      previous.role === role &&
      (messageId === null ||
        messageId === undefined ||
        previous.messageId === messageId)
    ) {
      return previous;
    }

    const message: ReplayMessage = {
      role,
      messageId: messageId ?? null,
      text: "",
      attachments: [],
    };
    this.replayMessages.push(message);
    return message;
  }

  private appendReplayChunk(
    role: ReplayMessage["role"],
    messageId: string | null | undefined,
    text: string
  ): void {
    this.findOrCreateReplayMessage(role, messageId).text += text;
  }

  private appendReplayAttachment(
    messageId: string | null | undefined,
    content: Extract<
      SessionNotification["update"],
      { sessionUpdate: "user_message_chunk" }
    >["content"]
  ): boolean {
    const message = this.findOrCreateReplayMessage("user", messageId);
    if (message.attachments.length >= MAX_ATTACHMENTS) {
      return false;
    }
    const attachment = createReplayAttachment(content, this.nextAttachmentId());
    if (!attachment) {
      return false;
    }
    const replayInlineBytes = message.attachments.reduce(
      (total, existing) =>
        existing.transport === "resource" || existing.transport === "image"
          ? total + (existing.size ?? 0)
          : total,
      0
    );
    if (
      attachment.transport !== "resource_link" &&
      replayInlineBytes + (attachment.size ?? 0) > MAX_INLINE_ATTACHMENT_BYTES
    ) {
      return false;
    }
    message.attachments.push(attachment);
    return true;
  }

  private stderrBuffer = "";
  private readonly mcpSecretRedactor = new McpSecretRedactor();

  private handleStderr(text: string): void {
    if (this.disposed) {
      return;
    }
    this.stderrBuffer += text;

    const errorMatch = this.stderrBuffer.match(
      /(\w+Error):\s*(\w+)?\s*\n?\s*data:\s*\{([^}]+)\}/
    );
    if (errorMatch) {
      console.error("[ACP stderr] Agent reported structured error output");
      this.postMessage({
        type: "agentError",
        text: "Agent reported an error.",
      });
      this.stderrBuffer = "";
    }

    if (this.stderrBuffer.length > 10000) {
      this.stderrBuffer = this.stderrBuffer.slice(-5000);
    }
  }

  private async handleReadTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    const opened = await this.openWorkspaceFile(params.path, "read");
    let content: string;
    try {
      // Read only the descriptor that passed containment. An editor buffer can
      // hold bytes loaded through an older symlink target and has no stable
      // file identity that can be compared with this descriptor.
      content = await readOpenedWorkspaceFile(opened);
    } finally {
      await opened.fileHandle.close();
    }

    if (params.line !== undefined || params.limit !== undefined) {
      const lines = content.split("\n");
      const startLine = Math.max((params.line ?? 1) - 1, 0);
      const lineLimit = params.limit ?? lines.length;
      const selectedLines = lines.slice(startLine, startLine + lineLimit);
      content = selectedLines.join("\n");
    }

    return { content };
  }

  private async assertNoDirtyEditor(
    canonicalPath: string,
    opened?: OpenedWorkspaceFile
  ): Promise<void> {
    const openedStats = await opened?.fileHandle.stat();
    const checked = new Set<vscode.TextDocument>();
    for (;;) {
      const documents = vscode.workspace.textDocuments.filter(
        (document) =>
          document.isDirty &&
          document.uri.scheme === "file" &&
          !checked.has(document)
      );
      if (documents.length === 0) {
        return;
      }
      for (const document of documents) {
        const documentPath = document.uri.fsPath;
        if (
          documentPath === canonicalPath ||
          documentPath === opened?.requestUri.fsPath
        ) {
          throw new Error(DIRTY_EDITOR_WRITE_CONFLICT);
        }
        let resolvedPath: string;
        let documentStats;
        try {
          const root = parse(documentPath).root;
          // Reuse missing-path resolution so deleted files and parents still
          // conflict through directory aliases before a write recreates them.
          resolvedPath = await canonicalizeUnder(
            root,
            relative(root, documentPath)
          );
          if (openedStats) {
            documentStats = await stat(documentPath).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") {
                  throw error;
                }
                return undefined;
              }
            );
          }
        } catch {
          throw new Error(
            "ACP write refused because an unsaved editor file could not be identified. Save or close that editor, then retry."
          );
        }
        if (
          resolvedPath === canonicalPath ||
          (openedStats &&
            documentStats &&
            openedStats.ino !== 0 &&
            documentStats.ino !== 0 &&
            openedStats.ino === documentStats.ino &&
            openedStats.dev === documentStats.dev)
        ) {
          throw new Error(DIRTY_EDITOR_WRITE_CONFLICT);
        }
        checked.add(document);
      }
      // Identity lookup yields to editor events. Check documents that became
      // dirty (or were opened) while the preceding batch was being resolved.
    }
  }

  private async handleWriteTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    const opened = await this.openWorkspaceFile(
      params.path,
      "write",
      vscode.workspace,
      undefined,
      (canonicalPath) => this.assertNoDirtyEditor(canonicalPath)
    );
    try {
      await writeOpenedWorkspaceFile(
        opened,
        new TextEncoder().encode(params.content),
        () => this.assertNoDirtyEditor(opened.canonicalPath, opened)
      );
    } finally {
      await opened.fileHandle.close();
    }
    return {};
  }
  private async prepareTerminalLaunch(
    params: CreateTerminalRequest
  ): Promise<PreparedTerminalLaunch> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Terminal execution requires a trusted workspace.");
    }
    if (
      typeof params.command !== "string" ||
      params.command.length === 0 ||
      params.command.length > MAX_TERMINAL_PERMISSION_VALUE_LENGTH ||
      TERMINAL_CONTROL_CHARACTERS.test(params.command)
    ) {
      throw new Error("Terminal command is invalid.");
    }

    const args = params.args ?? [];
    if (
      !Array.isArray(args) ||
      args.length > MAX_TERMINAL_PERMISSION_ARGUMENTS ||
      args.some(
        (arg) =>
          typeof arg !== "string" ||
          arg.length > MAX_TERMINAL_PERMISSION_VALUE_LENGTH ||
          TERMINAL_CONTROL_CHARACTERS.test(arg)
      )
    ) {
      throw new Error("Terminal arguments are invalid.");
    }
    if ((params.env?.length ?? 0) > 0) {
      throw new Error("Terminal environment overrides are not supported.");
    }

    const outputByteLimit = params.outputByteLimit ?? null;
    if (
      outputByteLimit !== null &&
      (!Number.isSafeInteger(outputByteLimit) || outputByteLimit < 0)
    ) {
      throw new Error("Terminal output limit is invalid.");
    }

    const localRoots = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === "file"
    );
    if (localRoots.length === 0) {
      throw new Error("Terminal execution requires a local workspace folder.");
    }
    if (
      params.cwd !== null &&
      params.cwd !== undefined &&
      (typeof params.cwd !== "string" ||
        !isAbsolute(params.cwd) ||
        params.cwd.length > MAX_TERMINAL_PERMISSION_VALUE_LENGTH ||
        TERMINAL_CONTROL_CHARACTERS.test(params.cwd))
    ) {
      throw new Error("Terminal working directory must be an absolute path.");
    }

    const requestedCwd = params.cwd ?? localRoots[0].uri.fsPath;
    const [cwd, ...roots] = await Promise.all([
      realpath(resolve(requestedCwd)),
      ...localRoots.map((folder) => realpath(resolve(folder.uri.fsPath))),
    ]);
    if (!roots.some((root) => isWithinWorkspaceRoot(cwd, root))) {
      throw new Error(
        "Terminal working directory must be inside a local workspace folder."
      );
    }

    const resolutionOptions: AgentCommandResolutionOptions = {
      ...this.getAgentResolutionOptions(),
      env: process.env,
      excludedDirectories: roots,
    };
    const inherited = createAgentEnvironment(resolutionOptions);
    const env: NodeJS.ProcessEnv = {};
    for (const name of SAFE_INHERITED_ENVIRONMENT_NAMES) {
      const sourceName =
        process.platform === "win32"
          ? Object.keys(inherited).find(
              (candidate) => candidate.toLowerCase() === name.toLowerCase()
            )
          : name;
      if (sourceName && inherited[sourceName] !== undefined) {
        env[name] = inherited[sourceName];
      }
    }
    const executable = await resolveTerminalExecutable(
      params.command,
      args,
      env,
      roots,
      resolutionOptions
    );
    const descriptor = terminalLaunchDescriptor(
      executable.command,
      executable.args,
      cwd,
      env
    );
    if (!isBoundedPermissionPayload(descriptor)) {
      throw new Error("Terminal launch description is too large to review.");
    }
    return {
      args: executable.args,
      command: executable.command,
      cwd,
      env,
      descriptor,
      outputByteLimit,
    };
  }

  private async handleCreateTerminal(
    params: CreateTerminalRequest
  ): Promise<CreateTerminalResponse> {
    const permissionKey = terminalPermissionKey(
      params.sessionId,
      params,
      CREATE_TERMINAL_KEYS
    );
    // This raw-key check happens before filesystem work. The resolved launch
    // descriptor is checked after preparation and again immediately at spawn.
    if (!permissionKey || !this.terminalPermissionGrants.has(permissionKey)) {
      throw new Error(
        "Terminal execution requires an approved permission request."
      );
    }
    if (
      this.terminals.size +
        this.retiringTerminals.size +
        this.pendingTerminalCreates >=
      MAX_ACTIVE_TERMINALS
    ) {
      throw new Error("Too many ACP terminals are already running.");
    }

    this.pendingTerminalCreates++;
    let reservationHeld = true;
    try {
      const launch = await this.prepareTerminalLaunch(params);
      const grant = this.terminalPermissionGrants.get(permissionKey);
      const descriptorKey = terminalLaunchKey(
        params.sessionId,
        launch.descriptor
      );
      if (!grant || grant.descriptorKey !== descriptorKey) {
        throw new Error(
          "Terminal execution requires an approved permission request."
        );
      }
      if (!grant.persistent) {
        if (grant.uses <= 1) {
          this.terminalPermissionGrants.delete(permissionKey);
        } else {
          grant.uses--;
        }
      }

      console.log("[Chat] Creating approved ACP terminal");
      const terminalId = `term-${randomUUID()}`;

      let exitResolve: () => void = () => {};
      const exitPromise = new Promise<void>((resolve) => {
        exitResolve = resolve;
      });
      let waitAbortResolve: () => void = () => {};
      const waitAbortPromise = new Promise<void>((resolve) => {
        waitAbortResolve = resolve;
      });

      const managedTerminal: ManagedTerminal = {
        id: terminalId,
        sessionId: params.sessionId,
        generation: this.terminalGeneration,
        proc: null,
        processId: null,
        output: "",
        outputByteLimit: launch.outputByteLimit,
        truncated: false,
        exitCode: null,
        signal: null,
        exitPromise,
        exitResolve,
        waitAbortPromise,
        waitAbortResolve,
        waitPending: false,
        closing: false,
        terminationPromise: null,
      };

      const writeEmitter = new vscode.EventEmitter<string>();
      const closeEmitter = new vscode.EventEmitter<number | void>();
      const approvedDescriptorKey = descriptorKey;

      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => {},
        close: () => {
          void this.terminateTerminalProcess(managedTerminal);
        },
      };

      const terminal = vscode.window.createTerminal({
        name: "ACP terminal",
        pty,
      });

      managedTerminal.terminal = terminal;
      this.terminals.set(terminalId, managedTerminal);
      this.pendingTerminalCreates--;
      reservationHeld = false;
      terminal.show(true);
      if (!vscode.workspace.isTrusted || managedTerminal.closing) {
        writeEmitter.fire("\r\nTerminal execution was denied.\r\n");
        managedTerminal.exitCode = 1;
        managedTerminal.exitResolve();
        closeEmitter.fire(1);
        return { terminalId };
      }

      let currentLaunch: PreparedTerminalLaunch;
      try {
        currentLaunch = await this.prepareTerminalLaunch(params);
        if (
          !vscode.workspace.isTrusted ||
          managedTerminal.closing ||
          managedTerminal.generation !== this.terminalGeneration ||
          this.terminals.get(terminalId) !== managedTerminal ||
          terminalLaunchKey(params.sessionId, currentLaunch.descriptor) !==
            approvedDescriptorKey
        ) {
          throw new Error("Terminal launch changed after approval.");
        }
      } catch {
        writeEmitter.fire("\r\nTerminal execution was denied.\r\n");
        managedTerminal.exitCode = 1;
        managedTerminal.exitResolve();
        closeEmitter.fire(1);
        return { terminalId };
      }

      let proc: ChildProcess;
      try {
        proc = spawn(currentLaunch.command, currentLaunch.args, {
          cwd: currentLaunch.cwd,
          env: currentLaunch.env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch {
        writeEmitter.fire("\r\nFailed to start ACP terminal.\r\n");
        this.appendTerminalOutput(
          managedTerminal,
          "\nFailed to start ACP terminal.\n"
        );
        managedTerminal.exitCode = 1;
        managedTerminal.exitResolve();
        closeEmitter.fire(1);
        return { terminalId };
      }

      managedTerminal.proc = proc;
      managedTerminal.processId = proc.pid ?? null;

      proc.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        writeEmitter.fire(text.replace(/\n/g, "\r\n"));
        this.appendTerminalOutput(managedTerminal, text);
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        writeEmitter.fire(text.replace(/\n/g, "\r\n"));
        this.appendTerminalOutput(managedTerminal, text);
      });

      proc.on("close", (code: number | null, signal: string | null) => {
        managedTerminal.exitCode = code;
        managedTerminal.signal = signal;
        managedTerminal.exitResolve();
        closeEmitter.fire(code ?? 0);
      });

      proc.on("error", () => {
        writeEmitter.fire("\r\nFailed to start ACP terminal.\r\n");
        this.appendTerminalOutput(
          managedTerminal,
          "\nFailed to start ACP terminal.\n"
        );
        managedTerminal.exitCode = 1;
        managedTerminal.exitResolve();
        closeEmitter.fire(1);
      });
      return { terminalId };
    } finally {
      if (reservationHeld) {
        this.pendingTerminalCreates--;
      }
    }
  }

  private appendTerminalOutput(terminal: ManagedTerminal, text: string): void {
    terminal.output += text;
    // An agent that omits `outputByteLimit` must not be able to grow the
    // extension host's heap without bound through a long-running command.
    const limit = Math.min(
      terminal.outputByteLimit ?? MAX_TERMINAL_OUTPUT_BYTES,
      MAX_TERMINAL_OUTPUT_BYTES
    );
    const byteLength = Buffer.byteLength(terminal.output, "utf8");
    if (byteLength > limit) {
      const encoded = Buffer.from(terminal.output, "utf8");
      let start = encoded.length - limit;
      while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) {
        start++;
      }
      terminal.output = encoded.subarray(start).toString("utf8");
      terminal.truncated = true;
    }
  }

  private getSessionTerminal(
    terminalId: string,
    sessionId: string
  ): ManagedTerminal {
    const terminal = this.terminals.get(terminalId);
    if (
      !terminal ||
      terminal.sessionId !== sessionId ||
      terminal.generation !== this.terminalGeneration
    ) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return terminal;
  }

  private async handleTerminalOutput(
    params: TerminalOutputRequest
  ): Promise<TerminalOutputResponse> {
    const terminal = this.getSessionTerminal(
      params.terminalId,
      params.sessionId
    );

    const exitStatus =
      terminal.exitCode !== null
        ? {
            exitCode: terminal.exitCode,
            ...(terminal.signal !== null && { signal: terminal.signal }),
          }
        : null;

    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus,
    };
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getSessionTerminal(
      params.terminalId,
      params.sessionId
    );
    if (terminal.waitPending) {
      throw new Error("A terminal exit wait is already pending.");
    }

    terminal.waitPending = true;
    try {
      await Promise.race([terminal.exitPromise, terminal.waitAbortPromise]);
      return {
        exitCode: terminal.exitCode,
        ...(terminal.signal !== null && { signal: terminal.signal }),
      };
    } finally {
      terminal.waitPending = false;
    }
  }

  private async runTerminationCommand(
    command: string,
    args: string[]
  ): Promise<boolean> {
    return runBoundedTerminationCommand(command, args);
  }

  private processExists(processId: number): boolean {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async waitForProcessExit(processId: number): Promise<boolean> {
    const deadline = Date.now() + TERMINAL_TERMINATION_GRACE_MS;
    while (this.processExists(processId)) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  private processGroupExists(processGroupId: number): boolean {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async waitForProcessGroupExit(
    processGroupId: number
  ): Promise<boolean> {
    const deadline = Date.now() + TERMINAL_TERMINATION_GRACE_MS;
    while (this.processGroupExists(processGroupId)) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  private async terminateWindowsProcessTree(
    processId: number
  ): Promise<boolean> {
    const windowsRoot =
      process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkill = join(windowsRoot, "System32", "taskkill.exe");
    if (this.processExists(processId)) {
      const taskkillCompleted = await this.runTerminationCommand(taskkill, [
        "/pid",
        String(processId),
        "/T",
        "/F",
      ]);
      if (taskkillCompleted && (await this.waitForProcessExit(processId))) {
        return true;
      }
    }

    // taskkill cannot traverse from a parent that already exited. Windows
    // preserves ParentProcessId, so a fixed PowerShell program can still find
    // and stop the orphaned descendants without accepting shell input.
    const powershell = join(
      windowsRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const script = [
      "$ErrorActionPreference='Stop'",
      `$root=[uint32]${processId}`,
      "$all=Get-CimInstance Win32_Process",
      "$queue=New-Object 'System.Collections.Generic.Queue[uint32]'",
      "$ids=New-Object 'System.Collections.Generic.List[uint32]'",
      "$queue.Enqueue($root)",
      "while($queue.Count -gt 0){$parent=$queue.Dequeue();foreach($p in $all){if($p.ParentProcessId -eq $parent){$ids.Add($p.ProcessId);$queue.Enqueue($p.ProcessId)}}}",
      "$ids | Sort-Object -Descending | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
      "Stop-Process -Id $root -Force -ErrorAction SilentlyContinue",
    ].join(";");
    const fallbackCompleted = await this.runTerminationCommand(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return fallbackCompleted && this.waitForProcessExit(processId);
  }

  private async terminateTerminalProcess(
    terminal: ManagedTerminal
  ): Promise<boolean> {
    if (terminal.terminationPromise) {
      return terminal.terminationPromise;
    }

    terminal.closing = true;
    terminal.waitAbortResolve();
    terminal.terminationPromise = (async () => {
      const processId = terminal.processId ?? terminal.proc?.pid ?? null;
      if (!processId) {
        terminal.exitCode = terminal.exitCode ?? 1;
        terminal.exitResolve();
        return true;
      }

      if (process.platform === "win32") {
        const terminated = await this.terminateWindowsProcessTree(processId);
        if (terminated) {
          terminal.signal = "SIGKILL";
        }
        return terminated;
      }

      if (!this.processGroupExists(processId)) {
        return true;
      }
      try {
        process.kill(-processId, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          return false;
        }
      }
      terminal.signal = "SIGTERM";
      if (await this.waitForProcessGroupExit(processId)) {
        return true;
      }

      try {
        process.kill(-processId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          return false;
        }
      }
      terminal.signal = "SIGKILL";
      return this.waitForProcessGroupExit(processId);
    })();
    return terminal.terminationPromise;
  }

  private async handleKillTerminalCommand(
    params: KillTerminalRequest
  ): Promise<KillTerminalResponse> {
    const terminal = this.getSessionTerminal(
      params.terminalId,
      params.sessionId
    );
    if (!(await this.terminateTerminalProcess(terminal))) {
      throw new Error("Failed to terminate ACP terminal process tree.");
    }
    terminal.terminal?.dispose();
    return {};
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest
  ): Promise<ReleaseTerminalResponse> {
    const terminal = this.getSessionTerminal(
      params.terminalId,
      params.sessionId
    );
    if (!(await this.terminateTerminalProcess(terminal))) {
      throw new Error("Failed to terminate ACP terminal process tree.");
    }
    terminal.terminal?.dispose();
    this.terminals.delete(params.terminalId);
    return {};
  }

  private storeTerminalPermissionGrant(
    key: string,
    descriptorKey: string,
    persistent: boolean
  ): void {
    const existing = this.terminalPermissionGrants.get(key);
    if (existing?.descriptorKey === descriptorKey) {
      if (existing.persistent || persistent) {
        existing.persistent = true;
        existing.uses = 0;
        return;
      }
      const units = Array.from(this.terminalPermissionGrants.values()).reduce(
        (total, grant) => total + (grant.persistent ? 1 : grant.uses),
        0
      );
      if (units < MAX_TERMINAL_GRANTS) {
        existing.uses++;
      }
      return;
    }

    if (existing) {
      this.terminalPermissionGrants.delete(key);
    }
    let units = Array.from(this.terminalPermissionGrants.values()).reduce(
      (total, grant) => total + (grant.persistent ? 1 : grant.uses),
      0
    );
    while (units >= MAX_TERMINAL_GRANTS) {
      const oldest = this.terminalPermissionGrants.keys().next();
      if (oldest.done) {
        return;
      }
      const evicted = this.terminalPermissionGrants.get(oldest.value);
      this.terminalPermissionGrants.delete(oldest.value);
      units -= evicted?.persistent ? 1 : (evicted?.uses ?? 0);
    }
    this.terminalPermissionGrants.set(key, {
      descriptorKey,
      persistent,
      uses: persistent ? 0 : 1,
    });
  }

  private async handleRequestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    console.log("[Chat] Permission request:", params.toolCall?.toolCallId);

    const requestView = this.view;
    if (!requestView) {
      console.log("[Chat] No webview available, cancelling permission request");
      return { outcome: { outcome: "cancelled" } };
    }

    const currentSessionId = this.acpClient.getCurrentSessionId();
    if (!currentSessionId || params.sessionId !== currentSessionId) {
      console.log("[Chat] Stale permission request cancelled");
      return { outcome: { outcome: "cancelled" } };
    }

    const rawInput = params.toolCall?.rawInput;
    if (
      !Array.isArray(params.options) ||
      params.options.length === 0 ||
      params.options.length > MAX_PERMISSION_OPTIONS ||
      !params.options.every(isSupportedPermissionOption) ||
      (rawInput !== undefined && !isBoundedPermissionPayload(rawInput))
    ) {
      console.log("[Chat] Invalid permission payload, cancelling request");
      return { outcome: { outcome: "cancelled" } };
    }
    const originalOptionIds = new Set(
      params.options.map((option) => option.optionId)
    );
    const optionKinds = new Set(params.options.map((option) => option.kind));
    if (
      originalOptionIds.size !== params.options.length ||
      optionKinds.size !== params.options.length
    ) {
      console.log("[Chat] Duplicate permission options, cancelling request");
      return { outcome: { outcome: "cancelled" } };
    }

    if (this.permissionRequests.size >= MAX_PENDING_PERMISSION_REQUESTS) {
      console.log("[Chat] Too many pending permission requests, cancelling");
      return { outcome: { outcome: "cancelled" } };
    }

    const requestId = `perm-${randomUUID()}`;
    const epoch = this.permissionEpoch;
    const response = new Promise<RequestPermissionResponse>((resolve) => {
      const timeoutId = setTimeout(() => {
        if (this.permissionRequests.delete(requestId)) {
          console.log("[Chat] Permission request timed out:", requestId);
          this.postMessage({ type: "permissionRequestExpired", requestId });
          resolve({ outcome: { outcome: "cancelled" } });
        }
      }, this.permissionRequestTimeoutMs);

      this.permissionRequests.set(requestId, {
        resolve,
        timeoutId,
        optionIds: originalOptionIds,
        epoch,
      });
    });

    const cancelRequest = (error?: unknown): void => {
      if (error) {
        console.error("[Chat] Failed to deliver permission request", error);
      }
      const pending = this.permissionRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.permissionRequests.delete(requestId);
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
    };

    const rawPermissionKey = terminalPermissionKey(params.sessionId, rawInput);
    let grantablePermissionKey = rawPermissionKey;
    let descriptorKey: string | null = null;
    let reviewContent = rawInput;
    if (rawPermissionKey) {
      try {
        const launch = await this.prepareTerminalLaunch({
          sessionId: params.sessionId,
          ...(rawInput as Omit<CreateTerminalRequest, "sessionId">),
        });
        descriptorKey = terminalLaunchKey(params.sessionId, launch.descriptor);
        reviewContent = launch.descriptor;
      } catch {
        grantablePermissionKey = null;
      }
    }

    if (
      !this.permissionRequests.has(requestId) ||
      epoch !== this.permissionEpoch ||
      this.view !== requestView ||
      this.acpClient.getCurrentSessionId() !== params.sessionId
    ) {
      cancelRequest();
      return response;
    }

    const presentedOptions = permissionPayloadHasHiddenValues(reviewContent)
      ? params.options.filter(
          (option) =>
            option.kind === "reject_once" || option.kind === "reject_always"
        )
      : params.options;
    if (presentedOptions.length === 0) {
      cancelRequest();
      return response;
    }
    const pending = this.permissionRequests.get(requestId);
    if (!pending) {
      return response;
    }
    pending.optionIds = new Set(
      presentedOptions.map((option) => option.optionId)
    );

    try {
      requestView.show?.(true);
    } catch (error) {
      console.error("[Chat] Failed to reveal the chat view", error);
    }

    try {
      const delivery = requestView.webview.postMessage({
        type: "permissionRequest",
        requestId,
        title: "Agent requests permission",
        executable: grantablePermissionKey !== null,
        rawInput: reviewContent,
        options: presentedOptions.map((option) => ({
          id: option.optionId,
          kind: option.kind,
        })),
      });
      void Promise.resolve(delivery).then(
        (delivered) => {
          if (!delivered) {
            cancelRequest();
          }
        },
        (error) => cancelRequest(error)
      );
    } catch (error) {
      cancelRequest(error);
    }

    const decision = await response;
    if (
      epoch !== this.permissionEpoch ||
      this.acpClient.getCurrentSessionId() !== params.sessionId
    ) {
      return { outcome: { outcome: "cancelled" } };
    }
    const outcome = decision.outcome;
    if (outcome.outcome === "selected") {
      const option = params.options.find(
        (candidate) => candidate.optionId === outcome.optionId
      );
      if (
        (option?.kind === "reject_once" || option?.kind === "reject_always") &&
        rawPermissionKey
      ) {
        this.terminalPermissionGrants.delete(rawPermissionKey);
      } else if (
        (option?.kind === "allow_once" || option?.kind === "allow_always") &&
        grantablePermissionKey &&
        descriptorKey
      ) {
        this.storeTerminalPermissionGrant(
          grantablePermissionKey,
          descriptorKey,
          option.kind === "allow_always"
        );
      }
    }
    return decision;
  }

  private handlePermissionResponse(message: WebviewMessage): void {
    if (!message.requestId) {
      return;
    }
    const pending = this.permissionRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.permissionRequests.delete(message.requestId);

    if (message.cancelled) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    } else if (message.optionId && pending.optionIds.has(message.optionId)) {
      pending.resolve({
        outcome: { outcome: "selected", optionId: message.optionId },
      });
    } else {
      console.error(
        "[Chat] Malformed permissionResponse; treating as cancelled",
        { requestId: message.requestId, optionId: message.optionId }
      );
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  private cancelPendingPermissionRequests(): void {
    for (const [requestId, pending] of this.permissionRequests.entries()) {
      clearTimeout(pending.timeoutId);
      this.postMessage({ type: "permissionRequestExpired", requestId });
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionRequests.clear();
  }

  private expirePermissionRequests(): void {
    this.permissionEpoch++;
    this.cancelPendingPermissionRequests();
    this.terminalPermissionGrants.clear();
  }

  private expireTurnPermissions(): void {
    this.permissionEpoch++;
    this.cancelPendingPermissionRequests();
    this.clearOneUseTerminalGrants();
  }

  private clearOneUseTerminalGrants(): void {
    for (const [key, grant] of this.terminalPermissionGrants) {
      if (!grant.persistent) {
        this.terminalPermissionGrants.delete(key);
      }
    }
  }

  private handleConnectionEnded(): void {
    const interruptedReplay = this.isReplaying;
    this.conversationGeneration++;
    this.hasSession = false;
    this.hasRestoredLegacyMode = false;
    this.isReplaying = false;
    this.replayGeneration = null;
    this.replayMessages = [];
    this.connectionStart = null;
    this.sessionStart = null;
    this.activeSessionContext = null;
    this.stderrBuffer = "";
    this.clearPendingAttachments();
    const cleanup = this.disposeTerminals();
    this.terminalCleanup = Promise.all([this.terminalCleanup, cleanup]).then(
      () => undefined
    );
    this.expirePermissionRequests();
    if (interruptedReplay) {
      this.postMessage({
        type: "replayFailed",
        text: "The agent disconnected while restoring this session.",
      });
    }
  }

  private disconnectCurrentAgent(): Promise<void> {
    const wasDisconnected = this.acpClient.getState() === "disconnected";
    const agentCleanup = this.acpClient.disconnect();
    if (wasDisconnected) {
      this.handleConnectionEnded();
    }
    return Promise.all([agentCleanup, this.terminalCleanup]).then(() => {
      this.mcpSecretRedactor.clear();
    });
  }

  private async disposeTerminals(): Promise<void> {
    this.terminalGeneration++;
    const terminals = Array.from(this.terminals.values());
    this.terminals.clear();
    for (const terminal of terminals) {
      terminal.closing = true;
      this.retiringTerminals.add(terminal);
    }
    await Promise.all(
      terminals.map(async (terminal) => {
        const terminated = await this.terminateTerminalProcess(terminal);
        if (!terminated) {
          return;
        }
        try {
          terminal.terminal?.dispose();
        } catch {}
        this.retiringTerminals.delete(terminal);
      })
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.conversationGeneration++;
    void this.disposeTerminals();
    this.mcpSecretRedactor.clear();
    this.activeSessionContext = null;
    this.clearPendingAttachments();
    this.expirePermissionRequests();
    this.configurationSubscription.dispose();
    this.workspaceTrustSubscription.dispose();
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    const updateGeneration = this.isReplaying
      ? this.replayGeneration
      : this.activePromptGeneration;
    if (
      updateGeneration !== null &&
      updateGeneration !== this.conversationGeneration
    ) {
      return;
    }
    console.log("[Chat] Session update received:", update.sessionUpdate);

    if (this.isReplaying) {
      if (
        update.sessionUpdate === "user_message_chunk" &&
        update.content.type === "text"
      ) {
        if (!this.appendReplayAttachment(update.messageId, update.content)) {
          this.appendReplayChunk("user", update.messageId, update.content.text);
        }
      } else if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        this.appendReplayChunk(
          "assistant",
          update.messageId,
          update.content.text
        );
      } else if (
        update.sessionUpdate === "user_message_chunk" &&
        (update.content.type === "resource_link" ||
          update.content.type === "resource" ||
          update.content.type === "image")
      ) {
        this.appendReplayAttachment(update.messageId, update.content);
      }
      return;
    }

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        this.streamingText += update.content.text;
        this.postMessage({ type: "streamChunk", text: update.content.text });
      } else {
        console.log("[Chat] Non-text chunk type:", update.content.type);
      }
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      let terminalOutput: string | undefined;

      if (update.content && update.content.length > 0) {
        const terminalContent = update.content.find(
          (c: { type: string; terminalId?: string }) => c.type === "terminal"
        );
        if (terminalContent && "terminalId" in terminalContent) {
          terminalOutput = `[Terminal: ${terminalContent.terminalId}]`;
        }
      }

      this.postMessage({
        type:
          update.sessionUpdate === "tool_call"
            ? "toolCallStart"
            : "toolCallUpdate",
        ...(update.sessionUpdate === "tool_call" && { name: update.title }),
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        content: update.content,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        status: update.status,
        terminalOutput,
        ...(update.locations !== undefined && {
          locations: this.toWebviewToolLocations(update.locations),
        }),
      });
    } else if (update.sessionUpdate === "current_mode_update") {
      this.postMessage({ type: "modeUpdate", modeId: update.currentModeId });
    } else if (update.sessionUpdate === "config_option_update") {
      this.sendSessionMetadata();
    } else if (update.sessionUpdate === "available_commands_update") {
      this.postMessage({
        type: "availableCommands",
        commands: update.availableCommands,
      });
    } else if (update.sessionUpdate === "plan") {
      this.postMessage({
        type: "plan",
        plan: { entries: update.entries },
      });
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content?.type === "text") {
        this.postMessage({
          type: "thoughtChunk",
          text: update.content.text,
        });
      }
    }
  }
  private postACPError(context: string, error: unknown): Error {
    const redacted = this.mcpSecretRedactor.redactError(error);
    const message = formatACPError(redacted);
    console.error(`[Chat] ${context}: ${message}`);
    this.postMessage({ type: "error", text: message });
    return redacted;
  }

  private async getSessionParameters(
    cwd: string,
    resource: vscode.Uri | undefined,
    generation: number
  ): Promise<NewSessionRequest | null> {
    const configured = await getConfiguredSession(
      cwd,
      this.acpClient.getMcpCapabilities(),
      process.env,
      resource
    );
    if (!this.isCurrentConversation(generation)) {
      return null;
    }
    this.mcpSecretRedactor.add(configured.sensitiveValues);
    return configured.parameters;
  }

  private isCurrentConversation(generation: number): boolean {
    return !this.disposed && generation === this.conversationGeneration;
  }
  private setSessionTransitionInputPaused(paused: boolean): void {
    this.sessionTransitionInputPaused = paused;
    if (paused) {
      this.postMessage({
        type: "sessionTransition",
        active: false,
        restoreFocus: false,
      });
    } else if (this.sessionTransitionLabel) {
      this.postMessage({
        type: "sessionTransition",
        active: true,
        text: this.sessionTransitionLabel,
      });
    }
  }

  private async runSessionTransition(
    label: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const previousTransition = this.sessionTransition;
    const transition = (async () => {
      if (previousTransition) {
        try {
          await previousTransition;
        } catch {
          // A new explicit transition can proceed from the restored client state.
        }
      }
      await operation();
    })();

    this.sessionTransition = transition;
    this.sessionTransitionInputPaused = false;
    this.sessionTransitionLabel = label;
    this.postMessage({ type: "sessionTransition", active: true, text: label });

    try {
      await transition;
    } finally {
      if (this.sessionTransition === transition) {
        this.sessionTransition = null;
        this.sessionTransitionLabel = null;
        this.sessionTransitionInputPaused = false;
        this.postMessage({ type: "sessionTransition", active: false });
      }
    }
  }

  private settleSessionLock(): void {
    if (!this.sessionTransition) {
      this.sessionTransitionLabel = null;
      this.sessionTransitionInputPaused = false;
      this.postMessage({ type: "sessionTransition", active: false });
    }
  }

  private async selectAuthenticationMethod(): Promise<AuthMethodId | null> {
    const methods = this.acpClient
      .getAuthenticationMethods()
      .filter(isAgentAuthMethod);
    if (methods.length === 0) {
      throw new Error("No supported authentication methods are available");
    }

    const selection = await vscode.window.showQuickPick<AuthenticationPickItem>(
      methods.map((method) => ({
        label: escapeQuickPickIcons(method.name),
        description: method.description
          ? escapeQuickPickIcons(method.description)
          : undefined,
        methodId: method.id,
      })),
      {
        title: "Authentication required",
        placeHolder: "Select an authentication method",
        ignoreFocusOut: true,
      }
    );
    return selection?.methodId ?? null;
  }

  private async requestSessionWithAuthentication<T>(
    request: () => Promise<T>,
    generation: number,
    prepareRetry?: () => void
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (
        !this.isCurrentConversation(generation) ||
        describeACPError(error).kind !== "authentication-required"
      ) {
        throw error;
      }

      const selectedGeneration = this.acpClient.getConnectionGeneration();
      const hasSupportedMethod = this.acpClient
        .getAuthenticationMethods()
        .some(isAgentAuthMethod);
      if (!hasSupportedMethod) {
        throw error;
      }

      this.setSessionTransitionInputPaused(true);
      let methodId: AuthMethodId | null;
      try {
        methodId = await this.selectAuthenticationMethod();
      } finally {
        this.setSessionTransitionInputPaused(false);
      }
      if (!this.isCurrentConversation(generation)) {
        throw new RequestError(-32800, "Request cancelled");
      }
      if (!methodId) {
        throw new Error("Authentication cancelled");
      }
      await this.acpClient.authenticate(methodId, selectedGeneration);
      if (!this.isCurrentConversation(generation)) {
        throw new RequestError(-32800, "Request cancelled");
      }
      prepareRetry?.();
      return request();
    }
  }

  private async ensureConnection(): Promise<void> {
    if (this.acpClient.isConnected()) {
      return;
    }
    if (!this.connectionStart) {
      this.connectionStart = this.acpClient
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connectionStart = null;
        });
    }
    await this.connectionStart;
  }

  private async startWorkspaceSession(generation: number): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
    await this.ensureConnection();
    if (!this.isCurrentConversation(generation) || this.hasSession) {
      return;
    }
    const resource = workspaceFolder?.uri;
    const request = await this.getSessionParameters(
      workingDir,
      resource,
      generation
    );
    if (
      !request ||
      !this.isCurrentConversation(generation) ||
      this.hasSession
    ) {
      return;
    }
    await this.requestSessionWithAuthentication(
      () => this.acpClient.newSession(request),
      generation
    );
    if (!this.isCurrentConversation(generation)) {
      return;
    }
    this.activeSessionContext = {
      cwd: workingDir,
      configurationResource: resource?.toString(),
    };
    this.hasSession = true;
    this.sendSessionMetadata();
  }

  private async ensureSession(): Promise<void> {
    while (this.sessionTransition) {
      const transition = this.sessionTransition;
      try {
        await transition;
      } catch (error) {
        if (!this.sessionTransition || this.sessionTransition === transition) {
          throw error;
        }
      }
    }

    if (this.hasSession || this.disposed) {
      return;
    }
    if (!this.sessionStart) {
      const label = this.acpClient.isConnected()
        ? "Starting session…"
        : "Connecting to agent…";
      this.sessionStart = this.runSessionTransition(label, async () => {
        const generation = this.conversationGeneration;
        try {
          await this.startWorkspaceSession(generation);
        } catch (error) {
          if (!this.isCurrentConversation(generation)) {
            return;
          }
          throw this.mcpSecretRedactor.redactError(error);
        }
      }).finally(() => {
        this.sessionStart = null;
      });
    }
    await this.sessionStart;
  }

  private async handleUserMessage(
    text: string,
    attachmentIds?: string[]
  ): Promise<void> {
    if (this.isReplaying && !this.sessionTransition) {
      this.postMessage({
        type: "agentError",
        text: "Wait for the conversation to finish restoring before sending.",
      });
      return;
    }

    if (this.editorSelectionPreparations > 0) {
      this.postMessage({ type: "restoreInput", text });
      const attachments = Array.from(this.pendingAttachments.values()).map(
        toAttachmentMetadata
      );
      if (attachments.length > 0) {
        this.postMessage({ type: "filesAttached", attachments });
      }
      this.postMessage({
        type: "attachmentWarning",
        text: "Wait for the editor selection to finish attaching before sending.",
      });
      this.postMessage({
        type: "streamEnd",
        stopReason: "error",
        suppressStopReason: true,
      });
      return;
    }

    const queuedGeneration = this.conversationGeneration;
    let promptStarted = false;
    const selectedAttachments = this.resolveAttachments(attachmentIds);
    const attachments: PromptAttachment[] = [];
    try {
      await this.ensureSession();
      if (queuedGeneration !== this.conversationGeneration) {
        throw new RequestError(-32800, "Request cancelled");
      }

      let inlineBytes = 0;
      for (const selected of selectedAttachments) {
        const prepared = await prepareFileAttachment(
          selected,
          this.acpClient.getPromptCapabilities(),
          inlineBytes
        );
        if (queuedGeneration !== this.conversationGeneration) {
          this.postMessage({
            type: "streamEnd",
            stopReason: "cancelled",
            suppressStopReason: true,
          });
          return;
        }
        if (!prepared) {
          this.postMessage({
            type: "attachmentWarning",
            text: `${selected.name} is no longer available inside the trusted workspace.`,
          });
          continue;
        }
        attachments.push(prepared.attachment);
        inlineBytes += prepared.inlineBytes;
        if (prepared.warning) {
          this.postMessage({
            type: "attachmentWarning",
            text: prepared.warning,
          });
        }
      }

      if (!text && attachments.length === 0) {
        this.postMessage({ type: "streamEnd", stopReason: "error" });
        return;
      }

      const attachmentMetadata = attachments.map(toAttachmentMetadata);
      this.postMessage({
        type: "userMessage",
        text,
        attachments: attachmentMetadata,
      });
      promptStarted = true;
      const promptGeneration = this.conversationGeneration;
      const promptSessionId = this.acpClient.getCurrentSessionId();
      this.streamingText = "";
      this.stderrBuffer = "";
      this.postMessage({ type: "streamStart" });
      this.activePromptGeneration = promptGeneration;
      console.log("[Chat] Sending message to ACP...");
      const response = await this.acpClient.sendMessage(text, attachments);
      console.log(`[Chat] Prompt completed: ${response.stopReason}`);
      if (
        promptGeneration !== this.conversationGeneration ||
        promptSessionId !== this.acpClient.getCurrentSessionId()
      ) {
        this.postMessage({
          type: "streamEnd",
          stopReason: "cancelled",
          suppressStopReason: true,
        });
        return;
      }

      const preview =
        text || attachments.map((attachment) => attachment.name).join(", ");
      try {
        await this.saveCurrentSession(preview);
      } catch (error) {
        console.warn("[Chat] Failed to save session metadata:", error);
      }
      if (
        !this.isCurrentConversation(promptGeneration) ||
        promptSessionId !== this.acpClient.getCurrentSessionId()
      ) {
        this.postMessage({
          type: "streamEnd",
          stopReason: "cancelled",
          suppressStopReason: true,
        });
        return;
      }

      if (this.streamingText.length === 0) {
        console.log(
          `[Chat] Prompt completed without text: ${response.stopReason}`
        );
      }
      this.postMessage({
        type: "streamEnd",
        stopReason: response.stopReason,
      });
      this.streamingText = "";
    } catch (error) {
      if (!promptStarted && queuedGeneration === this.conversationGeneration) {
        this.postMessage({ type: "restoreInput", text });
      }
      if (queuedGeneration === this.conversationGeneration) {
        const metadata: FileAttachment[] = [];
        for (const attachment of selectedAttachments) {
          if (this.pendingAttachments.size >= MAX_ATTACHMENTS) {
            break;
          }
          this.pendingAttachments.set(attachment.id, attachment);
          metadata.push(toAttachmentMetadata(attachment));
        }
        if (metadata.length > 0) {
          this.postMessage({ type: "filesAttached", attachments: metadata });
        }
      }
      const { kind } = describeACPError(error);
      if (kind === "cancelled") {
        console.log("[Chat] Prompt cancelled");
      } else if (queuedGeneration === this.conversationGeneration) {
        if (error instanceof AttachmentInputError) {
          this.postMessage({ type: "agentError", text: error.message });
        } else {
          this.postACPError("Error in handleUserMessage", error);
        }
      }
      this.postMessage({
        type: "streamEnd",
        stopReason: kind === "cancelled" ? "cancelled" : "error",
        ...(queuedGeneration !== this.conversationGeneration && {
          suppressStopReason: true,
        }),
      });

      this.streamingText = "";
      this.stderrBuffer = "";
    } finally {
      if (this.activePromptGeneration === queuedGeneration) {
        this.activePromptGeneration = null;
      }
      this.expireTurnPermissions();
    }
  }

  private handleAgentChange(agentId: string): void {
    const agent = this.getConfiguredAgent(agentId);
    if (agent) {
      this.conversationGeneration++;
      this.mcpSecretRedactor.clear();
      this.expirePermissionRequests();
      void this.disposeTerminals();
      this.acpClient.setAgent(agent);
      this.isReplaying = false;
      this.replayGeneration = null;
      this.replayMessages = [];
      this.expirePermissionRequests();
      this.globalState.update(SELECTED_AGENT_KEY, agentId);
      this.hasSession = false;
      this.hasRestoredLegacyMode = false;
      this.activeSessionContext = null;
      this.clearPendingAttachments();
      this.postMessage({ type: "agentChanged", agentId });
      this.postMessage({
        type: "sessionMetadata",
        modes: null,
        models: null,
        configOptions: null,
      });
    }
  }

  private async handleModeChange(modeId: string): Promise<void> {
    if (this.acpClient.getSessionMetadata()?.configOptions != null) {
      return;
    }
    try {
      await this.acpClient.setMode(modeId);
      await this.globalState.update(SELECTED_MODE_KEY, modeId);
      this.sendSessionMetadata();
    } catch (error) {
      this.postACPError("Failed to set mode", error);
      this.sendSessionMetadata();
    }
  }

  private async handleModelChange(modelId: string): Promise<void> {
    if (this.acpClient.getSessionMetadata()?.configOptions != null) {
      return;
    }
    try {
      await this.acpClient.setModel(modelId);
      await this.globalState.update(SELECTED_MODEL_KEY, modelId);
      this.sendSessionMetadata();
    } catch (error) {
      this.postACPError("Failed to set model", error);
      this.sendSessionMetadata();
    }
  }

  private async handleConfigOptionChange(
    configId: string,
    value: string
  ): Promise<void> {
    const persistedKey = this.getPersistedSessionConfigKey(configId);
    try {
      await this.acpClient.setSessionConfigOption(configId, value);
      const configOptions = this.acpClient.getSessionMetadata()?.configOptions;
      if (configOptions) {
        await this.persistSavedConfigOptions(configOptions);
      } else {
        await this.updateSavedConfigOptionValue(configId, value);
        if (persistedKey) {
          await this.globalState.update(persistedKey, value);
        }
      }
      this.sendSessionMetadata();
    } catch (error) {
      this.postACPError("Failed to set session option", error);
      this.sendSessionMetadata();
    }
  }

  private async handleConnect(): Promise<void> {
    try {
      await this.ensureSession();
    } catch (error) {
      throw this.postACPError("Failed to connect", error);
    }
  }

  private async handleNewChat(): Promise<void> {
    this.streamingText = "";

    if (!this.acpClient.isConnected() && !this.sessionTransition) {
      const generation = ++this.conversationGeneration;
      this.expirePermissionRequests();
      await this.disposeTerminals();
      if (!this.isCurrentConversation(generation)) {
        return;
      }
      this.isReplaying = false;
      this.replayGeneration = null;
      this.replayMessages = [];
      this.hasSession = false;
      this.hasRestoredLegacyMode = false;
      this.activeSessionContext = null;
      this.clearPendingAttachments();
      this.postMessage({ type: "chatCleared" });
      this.postMessage({
        type: "sessionMetadata",
        modes: null,
        models: null,
        configOptions: null,
      });
      this.settleSessionLock();
      return;
    }

    await this.runSessionTransition("Starting a new session…", async () => {
      const previousSessionContext = this.activeSessionContext;
      const hadSession = this.hasSession;
      const hadRestoredModeModel = this.hasRestoredLegacyMode;
      const generation = ++this.conversationGeneration;
      this.expirePermissionRequests();
      await this.disposeTerminals();
      if (!this.isCurrentConversation(generation)) {
        return;
      }
      this.isReplaying = false;
      this.replayGeneration = null;
      this.replayMessages = [];

      try {
        await this.ensureConnection();
        if (!this.isCurrentConversation(generation)) {
          return;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        const request = await this.getSessionParameters(
          workingDir,
          workspaceFolder?.uri,
          generation
        );
        if (!request || !this.isCurrentConversation(generation)) {
          return;
        }
        await this.requestSessionWithAuthentication(
          () => this.acpClient.newSession(request),
          generation
        );
        if (!this.isCurrentConversation(generation)) {
          return;
        }
        this.hasSession = true;
        this.activeSessionContext = {
          cwd: workingDir,
          configurationResource: workspaceFolder?.uri.toString(),
        };
        this.hasRestoredLegacyMode = false;
        this.clearPendingAttachments();
        this.postMessage({ type: "chatCleared" });
        this.sendSessionMetadata();
      } catch (error) {
        if (!this.isCurrentConversation(generation)) {
          return;
        }
        const redacted = this.mcpSecretRedactor.redactError(error);
        this.hasSession = hadSession;
        this.hasRestoredLegacyMode = hadRestoredModeModel;
        this.activeSessionContext = previousSessionContext;
        this.postACPError("Failed to create new session", redacted);
        this.sendSessionMetadata();
      }
    });
  }

  private handleClearChat(): void {
    this.expirePermissionRequests();
    this.clearPendingAttachments();
    this.postMessage({ type: "chatCleared" });
  }

  private resolveAttachments(attachmentIds?: string[]): PromptAttachment[] {
    if (!attachmentIds || attachmentIds.length === 0) {
      this.clearPendingAttachments();
      return [];
    }
    const resolved: PromptAttachment[] = [];
    const seen = new Set<string>();
    for (const id of attachmentIds.slice(0, MAX_ATTACHMENTS)) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const attachment = this.pendingAttachments.get(id);
      if (attachment) {
        resolved.push(attachment);
      }
    }
    this.clearPendingAttachments();
    return resolved;
  }

  private clearPendingAttachments(): void {
    this.pendingAttachments.clear();
    this.attachmentDraftVersion += 1;
  }

  private toWebviewToolLocations(locations: unknown): WebviewToolLocation[] {
    if (!Array.isArray(locations)) {
      return [];
    }
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const normalized: WebviewToolLocation[] = [];
    for (const entry of locations.slice(0, MAX_TOOL_LOCATIONS)) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.path !== "string" ||
        candidate.path.length === 0 ||
        !isAbsolute(candidate.path) ||
        candidate.path.length > MAX_TOOL_LOCATION_PATH_LENGTH ||
        TOOL_LOCATION_UNSAFE_CHARACTERS.test(candidate.path)
      ) {
        continue;
      }
      const requestPath = candidate.path;
      const workspaceFolder = workspaceFolders.find(
        (folder) =>
          folder.uri.scheme === "file" &&
          isWithinWorkspaceRoot(requestPath, folder.uri.fsPath)
      );
      const rawLabel = workspaceFolder
        ? relative(workspaceFolder.uri.fsPath, requestPath) || requestPath
        : requestPath;
      const safeLabel = rawLabel.replace(TOOL_LOCATION_DISPLAY_CHARACTERS, " ");
      const label =
        safeLabel.length > MAX_TOOL_LOCATION_LABEL_LENGTH
          ? `…${safeLabel.slice(-(MAX_TOOL_LOCATION_LABEL_LENGTH - 1))}`
          : safeLabel;
      const line =
        Number.isSafeInteger(candidate.line) && (candidate.line as number) > 0
          ? (candidate.line as number)
          : undefined;
      normalized.push({ path: requestPath, label, ...(line && { line }) });
    }
    return normalized;
  }

  private async handleOpenToolLocation(
    requestPath: unknown,
    requestedLine: unknown
  ): Promise<void> {
    try {
      if (
        !vscode.workspace.isTrusted ||
        typeof requestPath !== "string" ||
        requestPath.length === 0 ||
        requestPath.length > MAX_TOOL_LOCATION_PATH_LENGTH ||
        TOOL_LOCATION_UNSAFE_CHARACTERS.test(requestPath) ||
        !isAbsolute(requestPath)
      ) {
        throw new Error("Untrusted tool location");
      }
      const canonicalPath = await realpath(requestPath);
      let contained = false;
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== "file") {
          continue;
        }
        try {
          const canonicalRoot = await realpath(folder.uri.fsPath);
          if (isPathWithin(canonicalRoot, canonicalPath)) {
            contained = true;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!contained) {
        throw new Error("Tool location is outside the workspace");
      }

      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(canonicalPath)
      );
      const line =
        Number.isSafeInteger(requestedLine) && (requestedLine as number) > 0
          ? Math.min(requestedLine as number, document.lineCount) - 1
          : undefined;
      const selection =
        line === undefined
          ? undefined
          : new vscode.Range(
              new vscode.Position(line, 0),
              new vscode.Position(line, 0)
            );
      await vscode.window.showTextDocument(document, {
        preview: true,
        ...(selection && { selection }),
      });
    } catch {
      this.postMessage({
        type: "toolLocationError",
        text: TOOL_LOCATION_ERROR,
      });
    }
  }

  private nextAttachmentId(): string {
    this.attachmentCounter += 1;
    return `att-${this.attachmentCounter}-${Date.now()}`;
  }

  private pendingInlineBytes(): number {
    let total = 0;
    for (const attachment of this.pendingAttachments.values()) {
      if (attachment.payload?.type === "image") {
        total += decodedBase64Size(attachment.payload.data) ?? 0;
      } else if (attachment.payload?.type === "text") {
        total += Buffer.byteLength(attachment.payload.text, "utf8");
      }
    }
    return total;
  }

  private handleAttachContent(message: WebviewMessage): void {
    const reply = (result: Record<string, unknown>): void => {
      this.postMessage({
        ...result,
        ...(message.requestId ? { requestId: message.requestId } : {}),
      });
    };
    if (this.sessionTransition || this.isReplaying) {
      reply({
        type: "attachmentError",
        text: "Wait for the session transition to finish before attaching files.",
      });
      return;
    }
    if (!this.acpClient.isConnected()) {
      reply({
        type: "attachmentError",
        text: "Connect to an agent before pasting or dropping file content.",
      });
      return;
    }
    if (this.pendingAttachments.size >= MAX_ATTACHMENTS) {
      reply({
        type: "attachmentLimitReached",
        max: MAX_ATTACHMENTS,
      });
      return;
    }
    if (
      typeof message.name !== "string" ||
      typeof message.data !== "string" ||
      (message.mimeType !== undefined && typeof message.mimeType !== "string")
    ) {
      reply({
        type: "attachmentError",
        text: "The dropped or pasted attachment is invalid.",
      });
      return;
    }

    try {
      const attachment = createInlineAttachment(
        {
          name: message.name,
          mimeType: message.mimeType,
          data: message.data,
        },
        this.nextAttachmentId(),
        this.acpClient.getPromptCapabilities(),
        this.pendingInlineBytes()
      );
      this.pendingAttachments.set(attachment.id, attachment);
      reply({
        type: "filesAttached",
        attachments: [toAttachmentMetadata(attachment)],
      });
    } catch (error) {
      reply({
        type: "attachmentError",
        text:
          error instanceof AttachmentInputError
            ? error.message
            : "The attachment could not be added.",
      });
    }
  }

  private async handleRequestAttachFiles(currentCount: number): Promise<void> {
    if (this.attachmentPickerActive) {
      return;
    }

    const draftVersion = this.attachmentDraftVersion;
    const generation = this.conversationGeneration;
    const reportedCount = Number.isFinite(currentCount)
      ? Math.max(0, Math.floor(currentCount))
      : 0;
    const remaining =
      MAX_ATTACHMENTS - Math.max(reportedCount, this.pendingAttachments.size);
    if (remaining <= 0) {
      this.postMessage({
        type: "attachmentLimitReached",
        max: MAX_ATTACHMENTS,
      });
      this.postMessage({ type: "attachmentPreparation", active: false });
      return;
    }

    const attachments: PromptAttachment[] = [];
    let published = false;
    this.attachmentPickerActive = true;
    try {
      const uris = await pickAttachmentUris(remaining);
      if (
        uris.length === 0 ||
        generation !== this.conversationGeneration ||
        draftVersion !== this.attachmentDraftVersion
      ) {
        return;
      }

      let skippedCount = 0;
      let inlineBytes = this.pendingInlineBytes();
      const capabilities = this.acpClient.getPromptCapabilities();
      const pendingUris = new Set(
        Array.from(
          this.pendingAttachments.values(),
          (attachment) => attachment.uri
        )
      );
      for (let index = 0; index < uris.length; index += 1) {
        if (
          generation !== this.conversationGeneration ||
          draftVersion !== this.attachmentDraftVersion
        ) {
          return;
        }
        if (this.pendingAttachments.size >= MAX_ATTACHMENTS) {
          skippedCount += uris.length - index;
          break;
        }
        const metadata = await createFileAttachment(
          uris[index],
          this.nextAttachmentId()
        );
        if (
          generation !== this.conversationGeneration ||
          draftVersion !== this.attachmentDraftVersion
        ) {
          return;
        }
        if (
          !metadata ||
          this.pendingAttachments.size >= MAX_ATTACHMENTS ||
          pendingUris.has(metadata.uri)
        ) {
          skippedCount += 1;
          continue;
        }

        let attachment: PromptAttachment = {
          ...metadata,
          source: "file",
          transport:
            capabilities.embeddedContext === true &&
            isEmbeddableTextMimeType(metadata.mimeType)
              ? "resource"
              : "resource_link",
        };
        if (metadata.kind === "image" && capabilities.image === true) {
          const prepared = await prepareFileAttachment(
            attachment,
            capabilities,
            inlineBytes,
            true
          );
          if (
            generation !== this.conversationGeneration ||
            draftVersion !== this.attachmentDraftVersion
          ) {
            return;
          }
          if (!prepared) {
            skippedCount += 1;
            continue;
          }
          attachment = prepared.attachment;
          inlineBytes += prepared.inlineBytes;
          if (prepared.warning) {
            this.postMessage({
              type: "attachmentWarning",
              text: prepared.warning,
            });
          }
        }
        this.pendingAttachments.set(attachment.id, attachment);
        pendingUris.add(attachment.uri);
        attachments.push(attachment);
      }

      if (attachments.length > 0 || skippedCount > 0) {
        this.postMessage({
          type: "filesAttached",
          attachments: attachments.map(toAttachmentMetadata),
          skippedCount,
        });
      }
      published = true;
    } catch (error) {
      console.error("[Chat] Failed to attach files:", error);
      this.postMessage({
        type: "attachmentError",
        text: "The selected files could not be attached.",
      });
    } finally {
      if (!published) {
        for (const attachment of attachments) {
          this.pendingAttachments.delete(attachment.id);
        }
      }
      this.attachmentPickerActive = false;
      this.postMessage({ type: "attachmentPreparation", active: false });
    }
  }

  private sendConnectionState(state = this.acpClient.getState()): void {
    this.postMessage({
      type: "connectionState",
      state,
      agentInfo: state === "connected" ? this.acpClient.getAgentInfo() : null,
    });
  }

  private sendSessionMetadata(): void {
    const metadata = this.acpClient.getSessionMetadata();
    const configOptions = metadata?.configOptions ?? null;
    this.postMessage({
      type: "sessionMetadata",
      modes: metadata?.modes ?? null,
      models: configOptions === null ? (metadata?.models ?? null) : null,
      configOptions,
      commands: metadata?.commands ?? null,
      promptCapabilities: this.acpClient.getPromptCapabilities(),
    });

    if (!this.hasRestoredLegacyMode && this.hasSession) {
      this.hasRestoredLegacyMode = true;
      this.restoreSavedMode().catch((error) =>
        this.postACPError("Failed to restore saved mode/model", error)
      );
    }
  }

  private async restoreSavedMode(): Promise<void> {
    const metadata = this.acpClient.getSessionMetadata();
    const configOptions = metadata?.configOptions;
    if (configOptions !== null && configOptions !== undefined) {
      await this.restoreSavedConfigOptions();
      return;
    }
    const availableModes = Array.isArray(metadata?.modes?.availableModes)
      ? metadata.modes.availableModes
      : [];
    const availableModels = Array.isArray(metadata?.models?.availableModels)
      ? metadata.models.availableModels
      : [];
    const savedModeId = this.globalState.get<string>(SELECTED_MODE_KEY);
    const savedModelId = this.globalState.get<string>(SELECTED_MODEL_KEY);
    let restored = false;

    if (savedModeId && availableModes.some((mode) => mode.id === savedModeId)) {
      await this.acpClient.setMode(savedModeId);
      console.log("[Chat] Restored saved mode");
      restored = true;
    }
    if (
      savedModelId &&
      availableModels.some((model) => model.modelId === savedModelId)
    ) {
      await this.acpClient.setModel(savedModelId);
      console.log("[Chat] Restored saved model");
      restored = true;
    }
    if (restored) {
      this.sendSessionMetadata();
    }
  }

  private getPersistedSessionConfigKey(configId: string): string | null {
    const option = this.acpClient
      .getSessionMetadata()
      ?.configOptions?.find((candidate) => candidate.id === configId);
    if (!option) {
      return null;
    }
    return this.getPersistedSessionConfigKeyForOption(option);
  }

  private getPersistedSessionConfigKeyForOption(option: {
    category?: string | null;
  }): string | null {
    const category = option.category;
    if (
      category !== "mode" &&
      category !== "model" &&
      category !== "thought_level"
    ) {
      return null;
    }
    return PERSISTED_SESSION_CONFIG_KEYS[category];
  }

  private async restoreSavedConfigOptions(): Promise<void> {
    let restored = false;
    const savedConfigOptions = this.getSavedConfigOptionValues();
    const restoredConfigIds = new Set(
      savedConfigOptions.map((entry) => entry.configId)
    );
    for (const saved of savedConfigOptions) {
      const option = this.acpClient
        .getSessionMetadata()
        ?.configOptions?.find((candidate) => candidate.id === saved.configId);
      if (
        !option ||
        saved.value === option.currentValue ||
        !hasConfigValue(option, saved.value)
      ) {
        continue;
      }
      await this.acpClient.setSessionConfigOption(option.id, saved.value);
      restoredConfigIds.add(option.id);
      restored = true;
    }
    for (const category of PERSISTED_SESSION_CONFIG_CATEGORIES) {
      const persistedKey = PERSISTED_SESSION_CONFIG_KEYS[category];
      const savedValue = this.globalState.get<string>(persistedKey);
      if (!savedValue) {
        continue;
      }
      while (true) {
        const option = this.acpClient
          .getSessionMetadata()
          ?.configOptions?.find(
            (candidate) =>
              candidate.category === category &&
              !restoredConfigIds.has(candidate.id) &&
              candidate.currentValue !== savedValue &&
              hasConfigValue(candidate, savedValue)
          );
        if (!option) {
          break;
        }
        await this.acpClient.setSessionConfigOption(option.id, savedValue);
        restoredConfigIds.add(option.id);
        restored = true;
      }
    }
    if (restored) {
      console.log("[Chat] Restored saved session config");
      this.sendSessionMetadata();
    }
  }

  private async persistSavedConfigOptions(
    configOptions: readonly SupportedSessionConfigOption[]
  ): Promise<void> {
    await this.globalState.update(
      SELECTED_CONFIG_OPTIONS_KEY,
      configOptions.map(({ id, currentValue }) => ({
        configId: id,
        value: currentValue,
      }))
    );
    for (const category of PERSISTED_SESSION_CONFIG_CATEGORIES) {
      const option = configOptions.find(
        (candidate) => candidate.category === category
      );
      await this.globalState.update(
        PERSISTED_SESSION_CONFIG_KEYS[category],
        option?.currentValue
      );
    }
  }

  private getSavedConfigOptionValues(): readonly PersistedSessionConfigValue[] {
    const saved = this.globalState.get<unknown>(SELECTED_CONFIG_OPTIONS_KEY);
    if (Array.isArray(saved)) {
      return saved.filter(
        (entry): entry is PersistedSessionConfigValue =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.configId === "string" &&
          entry.configId.length > 0 &&
          typeof entry.value === "string"
      );
    }
    if (typeof saved !== "object" || saved === null) {
      return [];
    }
    return Object.entries(saved as Record<string, unknown>)
      .filter(
        ([configId, value]) => configId.length > 0 && typeof value === "string"
      )
      .map(([configId, value]) => ({
        configId,
        value: value as string,
      }));
  }

  private async updateSavedConfigOptionValue(
    configId: string,
    value: string
  ): Promise<void> {
    await this.globalState.update(SELECTED_CONFIG_OPTIONS_KEY, [
      ...this.getSavedConfigOptionValues().filter(
        (entry) => entry.configId !== configId
      ),
      { configId, value },
    ]);
  }

  private postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const styleResetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "reset.css")
    );
    const styleVSCodeUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "vscode.css")
    );
    const styleMainUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css")
    );
    const webviewScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src data:; form-action 'none'; frame-src 'none'; object-src 'none';">
  <link href="${styleResetUri}" rel="stylesheet">
  <link href="${styleVSCodeUri}" rel="stylesheet">
  <link href="${styleMainUri}" rel="stylesheet">
  <title>VSCode ACP Chat</title>
</head>
<body>
  <div id="top-bar" role="toolbar" aria-label="Chat controls">
    <span class="status-indicator" role="status" aria-live="polite">
      <span class="status-dot" id="status-dot" aria-hidden="true"></span>
      <span id="status-text">Disconnected</span>
    </span>
    <button id="connect-btn" aria-label="Connect to agent">Connect</button>
    <select id="agent-selector" class="inline-select" aria-label="Select AI agent"></select>
  </div>
  
  <div id="welcome-view" class="welcome-view" role="main" aria-label="Welcome">
    <h3>Welcome to VSCode ACP</h3>
    <p>Chat with AI coding agents directly in VS Code.</p>
    <button class="welcome-btn" id="welcome-connect-btn">Connect to Agent</button>
    <p class="help-links">
      <a href="https://github.com/sst/opencode" target="_blank" rel="noopener">Install OpenCode</a>
      <span aria-hidden="true">·</span>
      <a href="https://claude.ai/code" target="_blank" rel="noopener">Install Claude Code</a>
    </p>
  </div>
  
  <div id="agent-plan-container"></div>
  
  <div id="messages" role="log" aria-label="Chat messages" aria-live="polite" tabindex="0"></div>
  
  <div id="input-container">
    <div id="command-autocomplete" role="listbox" aria-label="Slash commands"></div>
    <div id="attachments-bar" role="list" aria-label="Attached files"></div>
    <div id="input-row">
      <textarea
        id="input"
        rows="1"
        placeholder="Ask your agent... (/ for commands)"
        aria-label="Message input"
        aria-describedby="input-hint"
        aria-autocomplete="list"
        aria-controls="command-autocomplete"
      ></textarea>
      <button id="attach-btn" aria-label="Attach files" title="Attach files">📎</button>
      <button id="send" aria-label="Send message" title="Send (Enter)">Send</button>
    </div>
  </div>
  <span id="input-hint" class="sr-only" role="status" aria-live="polite">Press Enter to send, Shift+Enter for new line, Escape to clear. Type / for ACP commands advertised by the agent.</span>
  
  <div id="options-bar" role="toolbar" aria-label="Session options">
    <div id="config-options" class="config-options" role="group" aria-label="Session configuration"></div>
    <select id="mode-selector" class="inline-select" style="display: none;" aria-label="Select mode"></select>
    <select id="model-selector" class="inline-select" style="display: none;" aria-label="Select model"></select>
  </div>
  <div id="session-picker" class="session-picker" role="dialog" aria-modal="true" aria-labelledby="session-picker-title" tabindex="-1"></div>

  <div id="permission-modal" class="permission-modal" role="dialog" aria-modal="true" aria-labelledby="permission-title" aria-describedby="permission-content" tabindex="-1">
    <div class="permission-modal-content">
      <h3 class="permission-title" id="permission-title">Permission Required</h3>
      <p class="permission-warning" id="permission-warning" role="alert" hidden></p>
      <pre class="permission-content" id="permission-content"></pre>
      <div class="permission-options" role="group" aria-label="Permission options"></div>
      <button class="permission-cancel-btn" type="button">Cancel</button>
    </div>
  </div>
  
<script src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}
