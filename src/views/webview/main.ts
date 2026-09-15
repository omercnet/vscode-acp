import createDOMPurify, { type DOMPurify, type WindowLike } from "dompurify";
import { Marked } from "marked";
import {
  MAX_ATTACHMENTS,
  MAX_EMBEDDED_RESOURCE_BYTES,
  MAX_IMAGE_BYTES,
  formatByteSize,
  isFileAttachmentValid,
  isSupportedImageAttachment,
  type FileAttachment,
} from "../../shared/attachments";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

const markdown = new Marked({ breaks: true, gfm: true });

/**
 * Agent Markdown may embed raw HTML. On top of DOMPurify's defaults, drop the
 * elements and attributes a Markdown reply never needs but a hostile agent
 * does: credential-prompt forms, in-panel CSS, and navigation overrides.
 */
const SANITIZE_CONFIG = {
  FORBID_TAGS: [
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "style",
  ],
  FORBID_ATTR: ["action", "formaction", "target", "ping", "style"],
};

export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): T;
}

declare function acquireVsCodeApi(): VsCodeApi;

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface ToolLocation {
  path: string;
  label: string;
  line?: number;
}

export interface AgentInfo {
  name: string;
  title?: string | null;
  version: string;
}

export interface Tool {
  name: string;
  input: string | null;
  output: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  kind?: ToolKind;
  locations?: ToolLocation[];
}

export interface WebviewState {
  isConnected: boolean;
  inputValue: string;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export type ToolCallContentItem =
  | { type: "content"; content?: { type: "text"; text?: string } }
  | { type: "diff"; path?: string; oldText?: string; newText?: string }
  | { type: "terminal"; terminalId?: string };

export type PermissionOptionKind =
  "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  id: string;
  kind?: PermissionOptionKind;
  /** Ignored: agent-provided labels cannot define a security decision. */
  label?: string;
}

interface QueuedPermissionRequest {
  requestId: string;
  title: string | undefined;
  content: unknown;
  options: PermissionOption[];
  executable: boolean;
}

export interface ReplayMessage {
  role: "user" | "assistant";
  text: string;
  attachments?: FileAttachment[];
}

export interface SessionHistoryEntry {
  sessionId: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  preview: string;
  messageCount: number;
}

export interface ExtensionMessage {
  type: string;
  text?: string;
  state?: string;
  agents?: Array<{ id: string; name: string; available: boolean }>;
  selected?: string;
  agentId?: string;
  modeId?: string;
  modelId?: string;
  modes?: {
    availableModes: Array<{ id: string; name: string }>;
    currentModeId: string;
  } | null;
  models?: {
    availableModels: Array<{ modelId: string; name: string }>;
    currentModelId: string;
  } | null;
  configOptions?: SessionConfigOption[] | null;
  commands?: AvailableCommand[] | null;
  attachments?: FileAttachment[];
  skippedCount?: number;
  max?: number;
  plan?: { entries: PlanEntry[] };
  mode?: "load" | "delete";
  messages?: ReplayMessage[];
  sessions?: SessionHistoryEntry[];
  sessionId?: string;
  promptCapabilities?: {
    image?: boolean;
    embeddedContext?: boolean;
  };
  toolCallId?: string;
  name?: string;
  title?: string;
  kind?: ToolKind;
  content?: ToolCallContentItem[] | null;
  locations?: ToolLocation[] | null;
  stopReason?:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled"
    | "error";
  suppressStopReason?: boolean;
  agentInfo?: AgentInfo | null;
  // ACP treats raw tool payloads as opaque. The UI only reads validated string
  // values from the conventional command, description, and output fields.
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: string;
  terminalOutput?: string;
  requestId?: string;
  options?: PermissionOption[];
  active?: boolean;
  restoreFocus?: boolean;
  /** Set when approving this payload can start a process on the machine. */
  executable?: boolean;
}

const METADATA_CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;
const MAX_METADATA_DISPLAY_LENGTH = 256;
const MAX_TOOL_LOCATIONS = 20;

function truncateMetadata(value: string, maxLength: number): string {
  let end = 0;
  let length = 0;
  for (const character of value) {
    if (length === maxLength) {
      break;
    }
    end += character.length;
    length++;
  }
  return value.slice(0, end);
}

export function formatAgentIdentity(agentInfo: unknown): string | null {
  if (typeof agentInfo !== "object" || agentInfo === null) {
    return null;
  }
  const candidate = agentInfo as Record<string, unknown>;
  const displayName =
    typeof candidate.title === "string" && candidate.title.trim().length > 0
      ? candidate.title
      : typeof candidate.name === "string"
        ? candidate.name
        : "";
  if (typeof candidate.version !== "string") {
    return null;
  }
  const name = truncateMetadata(
    displayName.replace(METADATA_CONTROL_CHARACTERS, " ").trim(),
    MAX_METADATA_DISPLAY_LENGTH
  );
  const version = truncateMetadata(
    candidate.version.replace(METADATA_CONTROL_CHARACTERS, " ").trim(),
    MAX_METADATA_DISPLAY_LENGTH
  );
  return name && version ? `${name} ${version}` : null;
}

function normalizeToolLocations(value: unknown): ToolLocation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_TOOL_LOCATIONS).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.path !== "string" ||
      candidate.path.length === 0 ||
      candidate.path.length > 4096 ||
      typeof candidate.label !== "string"
    ) {
      return [];
    }
    const line =
      Number.isSafeInteger(candidate.line) && (candidate.line as number) > 0
        ? (candidate.line as number)
        : undefined;
    const label = truncateMetadata(
      candidate.label.replace(METADATA_CONTROL_CHARACTERS, " "),
      160
    );
    return [
      {
        path: candidate.path,
        label,
        ...(line && { line }),
      },
    ];
  });
}

function getToolInput(rawInput: unknown): string {
  if (typeof rawInput !== "object" || rawInput === null) {
    return "";
  }
  const candidate = rawInput as Record<string, unknown>;
  if (typeof candidate.command === "string" && candidate.command.length > 0) {
    return candidate.command;
  }
  return typeof candidate.description === "string" ? candidate.description : "";
}

function getToolOutput(msg: ExtensionMessage): string {
  let output = "";
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const firstContent = msg.content[0];
    if (
      firstContent?.type === "content" &&
      typeof firstContent.content?.text === "string"
    ) {
      output = firstContent.content.text;
    } else if (firstContent?.type === "terminal") {
      output = typeof msg.terminalOutput === "string" ? msg.terminalOutput : "";
    } else if (firstContent?.type === "diff") {
      output = renderDiff(
        firstContent.path,
        firstContent.oldText,
        firstContent.newText
      );
    }
  }
  if (output) {
    return output;
  }
  if (typeof msg.rawOutput !== "object" || msg.rawOutput === null) {
    return "";
  }
  const rawOutput = msg.rawOutput as Record<string, unknown>;
  return typeof rawOutput.output === "string" ? rawOutput.output : "";
}

/**
 * How long a freshly shown permission prompt keeps its agent-supplied options
 * inert, so held keys or double clicks aimed at the previous screen cannot
 * decide a request the user has not read yet.
 */
const PERMISSION_GUARD_MS = 500;

const DEFAULT_INPUT_HINT =
  "Press Enter to send, Shift+Enter for new line, Escape to clear. Type / for ACP commands advertised by the agent.";
/**
 * Shown when a typed slash word matches nothing the connected agent advertised
 * over ACP. It is also announced through the input hint live region, because a
 * listbox option that never becomes active is never read out.
 */
const NO_MATCHING_COMMANDS_MESSAGE =
  "No matching ACP commands. This list only includes commands advertised by the active agent; its own app may offer others.";
/**
 * Decision labels are extension-defined, never agent-supplied, and must state
 * exactly what the extension guarantees. Grants are cleared whenever the
 * session, agent, chat, or view changes, so "always" is session-scoped.
 */
const PERMISSION_OPTION_LABELS: Record<PermissionOptionKind, string> = {
  allow_once: "Allow once",
  allow_always: "Always allow in this session",
  reject_once: "Deny",
  reject_always: "Always deny",
};

const SENSITIVE_PERMISSION_KEYS =
  /authorization|credential|key|password|secret|token/i;

/** Formats agent-provided values as bounded, inert text for the approval UI. */
export function formatPermissionContent(content: unknown): string {
  if (content === null || typeof content !== "object") {
    return "[Agent-provided details omitted]";
  }
  const seen = new WeakSet<object>();
  const sanitize = (value: unknown, key = "", depth = 0): unknown => {
    if (SENSITIVE_PERMISSION_KEYS.test(key) || key === "value") {
      return "[redacted]";
    }
    if (typeof value === "string") {
      const escaped = value.replace(
        /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu,
        (character) =>
          `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`
      );
      return escaped.length > 4096
        ? `${escaped.slice(0, 4096)}… [truncated]`
        : escaped;
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (depth >= 5 || seen.has(value)) {
      return "[truncated]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const entries = value
        .slice(0, 50)
        .map((entry) => sanitize(entry, "", depth + 1));
      if (value.length > entries.length) {
        entries.push(`[${value.length - entries.length} entries omitted]`);
      }
      return entries;
    }
    const sourceEntries = Object.entries(value as Record<string, unknown>);
    const entries = sourceEntries
      .slice(0, 50)
      .map(([entryKey, entryValue]) => [
        entryKey,
        sanitize(entryValue, entryKey, depth + 1),
      ]);
    if (sourceEntries.length > entries.length) {
      entries.push([
        "[truncated]",
        `${sourceEntries.length - entries.length} entries omitted`,
      ]);
    }
    return Object.fromEntries(entries);
  };

  try {
    const formatted = JSON.stringify(sanitize(content), null, 2);
    if (typeof formatted !== "string") {
      return "[Agent-provided details unavailable]";
    }
    return formatted.length > 65_536
      ? `${formatted.slice(0, 65_536)}\n[truncated]`
      : formatted;
  } catch {
    return "[Agent-provided details unavailable]";
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TOOL_KIND_ICONS: Record<ToolKind, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑️",
  move: "📦",
  search: "🔍",
  execute: "▶️",
  think: "🧠",
  fetch: "🌐",
  switch_mode: "🔄",
  other: "⚙️",
};

export function getToolKindIcon(kind?: ToolKind): string {
  return kind ? TOOL_KIND_ICONS[kind] || TOOL_KIND_ICONS.other : "";
}

const ANSI_FOREGROUND: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

const ANSI_BACKGROUND: Record<number, string> = {
  40: "ansi-bg-black",
  41: "ansi-bg-red",
  42: "ansi-bg-green",
  43: "ansi-bg-yellow",
  44: "ansi-bg-blue",
  45: "ansi-bg-magenta",
  46: "ansi-bg-cyan",
  47: "ansi-bg-white",
  100: "ansi-bg-bright-black",
  101: "ansi-bg-bright-red",
  102: "ansi-bg-bright-green",
  103: "ansi-bg-bright-yellow",
  104: "ansi-bg-bright-blue",
  105: "ansi-bg-bright-magenta",
  106: "ansi-bg-bright-cyan",
  107: "ansi-bg-bright-white",
};

const ANSI_STYLES: Record<number, string> = {
  1: "ansi-bold",
  2: "ansi-dim",
  3: "ansi-italic",
  4: "ansi-underline",
};

const ANSI_ESCAPE_REGEX = /\x1b\[([0-9;]*)m/g;

function isForegroundClass(cls: string): boolean {
  return (
    cls.startsWith("ansi-") &&
    !cls.startsWith("ansi-bg-") &&
    !cls.startsWith("ansi-bold") &&
    !cls.startsWith("ansi-dim") &&
    !cls.startsWith("ansi-italic") &&
    !cls.startsWith("ansi-underline")
  );
}

function isBackgroundClass(cls: string): boolean {
  return cls.startsWith("ansi-bg-");
}

export function ansiToHtml(text: string): string {
  let result = "";
  let lastIndex = 0;
  let currentClasses: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = ANSI_ESCAPE_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const textContent = escapeHtml(text.slice(lastIndex, match.index));
      if (currentClasses.length > 0) {
        result += `<span class="${currentClasses.join(" ")}">${textContent}</span>`;
      } else {
        result += textContent;
      }
    }

    const codes = match[1].split(";").map((c) => parseInt(c, 10) || 0);

    for (const code of codes) {
      if (code === 0) {
        currentClasses = [];
      } else if (ANSI_STYLES[code]) {
        const styleClass = ANSI_STYLES[code];
        if (!currentClasses.includes(styleClass)) {
          currentClasses.push(styleClass);
        }
      } else if (ANSI_FOREGROUND[code]) {
        currentClasses = currentClasses.filter((c) => !isForegroundClass(c));
        currentClasses.push(ANSI_FOREGROUND[code]);
      } else if (ANSI_BACKGROUND[code]) {
        currentClasses = currentClasses.filter((c) => !isBackgroundClass(c));
        currentClasses.push(ANSI_BACKGROUND[code]);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  ANSI_ESCAPE_REGEX.lastIndex = 0;

  if (lastIndex < text.length) {
    const textContent = escapeHtml(text.slice(lastIndex));
    if (currentClasses.length > 0) {
      result += `<span class="${currentClasses.join(" ")}">${textContent}</span>`;
    } else {
      result += textContent;
    }
  }

  return result;
}

export function hasAnsiCodes(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  line: string;
}

/**
 * Compute a simple line-by-line diff between old and new text.
 * Returns an array of diff lines marked as add/remove/context.
 */
export function computeLineDiff(
  oldText: string | null | undefined,
  newText: string | null | undefined
): DiffLine[] {
  // Handle edge cases
  if (!oldText && !newText) {
    return [];
  }
  if (!oldText) {
    // New file - all lines are additions
    return newText!.split("\n").map((line) => ({ type: "add", line }));
  }
  if (!newText) {
    // Deleted file - all lines are deletions
    return oldText!.split("\n").map((line) => ({ type: "remove", line }));
  }

  // Simple line-by-line diff
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Simple algorithm: mark old lines as removed, new lines as added
  // Future optimization: detect common lines and mark as context
  for (const line of oldLines) {
    result.push({ type: "remove", line });
  }
  for (const line of newLines) {
    result.push({ type: "add", line });
  }

  return result;
}

export function renderDiff(
  path: string | undefined,
  oldText: string | null | undefined,
  newText: string | null | undefined
): string {
  const diffLines = computeLineDiff(oldText, newText);

  if (diffLines.length === 0) {
    return '<div class="diff-container"><div class="diff-empty">No changes</div></div>';
  }

  const truncated = diffLines.length > 500;
  const linesToShow = truncated ? diffLines.slice(0, 500) : diffLines;

  let html = '<div class="diff-container">';

  if (path) {
    html += '<div class="diff-header">' + escapeHtml(path) + "</div>";
  }

  html += '<pre class="diff-content">';

  for (const diffLine of linesToShow) {
    const prefix =
      diffLine.type === "add" ? "+ " : diffLine.type === "remove" ? "- " : "  ";
    const className = "diff-line diff-" + diffLine.type;
    html +=
      '<div class="' +
      className +
      '">' +
      escapeHtml(prefix + diffLine.line) +
      "</div>";
  }

  html += "</pre>";

  if (truncated) {
    html +=
      '<div class="diff-truncated">... (truncated, showing first 500 of ' +
      diffLines.length +
      " lines)</div>";
  }

  html += "</div>";

  return html;
}

export function getToolsHtml(
  tools: Record<string, Tool>,
  expandedToolId?: string | null
): string {
  const toolIds = Object.keys(tools);
  if (toolIds.length === 0) return "";
  const toolItems = toolIds
    .map((id) => {
      const tool = tools[id];
      const statusIcon =
        tool.status === "completed"
          ? "✓"
          : tool.status === "failed"
            ? "✗"
            : tool.status === "cancelled"
              ? "×"
              : "⋯";
      const statusClass = tool.status === "running" ? "running" : "";
      const isExpanded = id === expandedToolId;
      const kindIcon = getToolKindIcon(tool.kind);
      const kindSpan = kindIcon
        ? '<span class="tool-kind-icon" title="' +
          escapeHtml(tool.kind || "other") +
          '">' +
          kindIcon +
          "</span> "
        : "";
      let detailsContent = "";
      if ((tool.locations?.length ?? 0) > 0) {
        const links = tool
          .locations!.map((location) => {
            const line = location.line ? `:${location.line}` : "";
            return (
              '<button type="button" class="tool-location-link" data-tool-location-path="' +
              escapeHtml(location.path) +
              '"' +
              (location.line
                ? ' data-tool-location-line="' + location.line + '"'
                : "") +
              ">" +
              escapeHtml(location.label + line) +
              "</button>"
            );
          })
          .join("");
        detailsContent +=
          '<div class="tool-locations" aria-label="Tool locations">' +
          links +
          "</div>";
      }
      if (tool.input) {
        detailsContent +=
          '<div class="tool-input"><strong>$</strong> ' +
          escapeHtml(tool.input) +
          "</div>";
      }
      if (tool.output) {
        const truncated =
          tool.output.length > 500
            ? tool.output.slice(0, 500) + "..."
            : tool.output;
        const hasAnsi = hasAnsiCodes(truncated);
        const outputHtml = hasAnsi
          ? ansiToHtml(truncated)
          : escapeHtml(truncated);
        const terminalClass = hasAnsi ? " terminal" : "";
        detailsContent +=
          '<pre class="tool-output' +
          terminalClass +
          '">' +
          outputHtml +
          "</pre>";
      }
      const escapedStatus = escapeHtml(tool.status);
      const inputPreview = tool.input
        ? '<span class="tool-input-preview">' +
          escapeHtml(tool.input) +
          "</span>"
        : "";
      if (detailsContent) {
        const openAttr = isExpanded ? " open" : "";
        return (
          '<li><details class="tool-item"' +
          openAttr +
          '><summary><span class="tool-status ' +
          statusClass +
          '" aria-label="' +
          escapedStatus +
          '">' +
          statusIcon +
          "</span> " +
          kindSpan +
          escapeHtml(tool.name) +
          inputPreview +
          "</summary>" +
          detailsContent +
          "</details></li>"
        );
      }
      return (
        '<li><span class="tool-status ' +
        statusClass +
        '" aria-label="' +
        escapedStatus +
        '">' +
        statusIcon +
        "</span> " +
        kindSpan +
        escapeHtml(tool.name) +
        inputPreview +
        "</li>"
      );
    })
    .join("");
  return (
    '<details class="tool-details" open><summary aria-label="' +
    toolIds.length +
    ' tools used">' +
    toolIds.length +
    " tool" +
    (toolIds.length > 1 ? "s" : "") +
    '</summary><ul class="tool-list" role="list">' +
    toolItems +
    "</ul></details>"
  );
}

export function updateSelectLabel(
  select: HTMLSelectElement,
  prefix: string
): void {
  Array.from(select.options).forEach((opt) => {
    opt.textContent = opt.dataset.label || opt.textContent;
  });
  const selected = select.options[select.selectedIndex];
  if (selected && selected.dataset.label) {
    selected.textContent = prefix + ": " + selected.dataset.label;
  }
}

export interface WebviewElements {
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
  inputContainer: HTMLElement;
  inputHint: HTMLElement;
  attachBtn: HTMLButtonElement;
  attachmentsBar: HTMLElement;
  statusDot: HTMLElement;
  statusText: HTMLElement;
  agentSelector: HTMLSelectElement;
  connectBtn: HTMLButtonElement;
  welcomeConnectBtn: HTMLButtonElement;
  configOptionsContainer: HTMLElement;
  modeSelector: HTMLSelectElement;
  modelSelector: HTMLSelectElement;
  welcomeView: HTMLElement;
  commandAutocomplete: HTMLElement;
  planContainer: HTMLElement;
  permissionModal: HTMLElement;
  sessionPicker: HTMLElement;
}

export function getElements(doc: Document): WebviewElements {
  return {
    messagesEl: doc.getElementById("messages")!,
    inputEl: doc.getElementById("input") as HTMLTextAreaElement,
    sendBtn: doc.getElementById("send") as HTMLButtonElement,
    attachBtn: doc.getElementById("attach-btn") as HTMLButtonElement,
    attachmentsBar: doc.getElementById("attachments-bar")!,
    statusDot: doc.getElementById("status-dot")!,
    statusText: doc.getElementById("status-text")!,
    inputContainer: doc.getElementById("input-container")!,
    inputHint: doc.getElementById("input-hint")!,
    agentSelector: doc.getElementById("agent-selector") as HTMLSelectElement,
    connectBtn: doc.getElementById("connect-btn") as HTMLButtonElement,
    welcomeConnectBtn: doc.getElementById(
      "welcome-connect-btn"
    ) as HTMLButtonElement,
    configOptionsContainer: doc.getElementById("config-options")!,
    modeSelector: doc.getElementById("mode-selector") as HTMLSelectElement,
    modelSelector: doc.getElementById("model-selector") as HTMLSelectElement,
    welcomeView: doc.getElementById("welcome-view")!,
    commandAutocomplete: doc.getElementById("command-autocomplete")!,
    planContainer: doc.getElementById("agent-plan-container")!,
    permissionModal: doc.getElementById("permission-modal")!,
    sessionPicker: doc.getElementById("session-picker")!,
  };
}

export class WebviewController {
  private vscode: VsCodeApi;
  private elements: WebviewElements;
  private doc: Document;
  private win: Window;
  private readonly sanitizer: DOMPurify;

  private currentAssistantMessage: HTMLElement | null = null;
  private currentAssistantText = "";
  private thinkingEl: HTMLElement | null = null;
  private planEl: HTMLElement | null = null;
  private thoughtEl: HTMLElement | null = null;
  private thoughtText = "";
  private tools: Record<string, Tool> = {};
  private isConnected = false;
  private messageTexts = new Map<HTMLElement, string>();
  private availableCommands: AvailableCommand[] = [];
  private hasCommandCatalog = false;
  private selectedCommandIndex = -1;
  private commandHint: string | null = null;
  private hasActiveTool = false;
  private expandedToolId: string | null = null;
  private pendingPermissionRequestId: string | null = null;
  private previouslyFocusedElement: HTMLElement | null = null;
  private permissionKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private permissionQueue: QueuedPermissionRequest[] = [];
  private permissionGuardElapsed = false;
  private permissionDetailsReviewed = false;
  private permissionScrollHandler: (() => void) | null = null;
  private permissionUnlockTimer: number | null = null;
  private replayStatusEl: HTMLElement | null = null;
  private sessionPickerPreviousFocus: HTMLElement | null = null;
  private inputLocks = new Map<string, string>();
  private restoreInputFocus = false;
  private promptPending = false;
  private hasSessionConfigOptions = false;
  private attachments: FileAttachment[] = [];
  private attachmentReadGeneration = 0;
  private attachmentPickerPending = false;
  private pendingAttachmentRequestIds = new Set<string>();
  private attachmentRequestCounter = 0;
  private promptCapabilities = { image: false, embeddedContext: false };

  constructor(
    vscode: VsCodeApi,
    elements: WebviewElements,
    doc: Document,
    win: Window
  ) {
    this.vscode = vscode;
    this.elements = elements;
    this.doc = doc;
    this.win = win;
    this.sanitizer = createDOMPurify(win as unknown as WindowLike);

    this.restoreState();
    this.setupEventListeners();
    this.updateViewState();
    this.vscode.postMessage({ type: "ready" });
  }

  private restoreState(): void {
    const previousState = this.vscode.getState<WebviewState>();
    if (previousState) {
      this.isConnected = previousState.isConnected;
      this.elements.inputEl.value = previousState.inputValue || "";
    }
  }

  private saveState(): void {
    this.vscode.setState<WebviewState>({
      isConnected: this.isConnected,
      inputValue: this.elements.inputEl.value,
    });
  }

  private setupEventListeners(): void {
    const {
      sendBtn,
      attachBtn,
      attachmentsBar,
      inputEl,
      messagesEl,
      connectBtn,
      welcomeConnectBtn,
    } = this.elements;
    const {
      agentSelector,
      configOptionsContainer,
      modeSelector,
      modelSelector,
      commandAutocomplete,
    } = this.elements;

    sendBtn.addEventListener("click", () => this.send());

    attachBtn.addEventListener("click", () => {
      if (this.isAttachmentPreparationPending()) {
        return;
      }
      this.attachmentPickerPending = true;
      this.updateInputControls();
      this.vscode.postMessage({
        type: "requestAttachFiles",
        attachmentCount: this.attachments.length,
      });
    });

    attachmentsBar.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest(
        ".attachment-chip-remove"
      );
      const attachmentId = button?.getAttribute("data-attachment-id");
      if (attachmentId) {
        this.removeAttachment(attachmentId);
      }
    });

    messagesEl.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        ".tool-location-link"
      );
      if (!button || !messagesEl.contains(button)) {
        return;
      }
      const locationPath = button.getAttribute("data-tool-location-path");
      const rawLine = button.getAttribute("data-tool-location-line");
      if (locationPath) {
        this.vscode.postMessage({
          type: "openToolLocation",
          locationPath,
          ...(rawLine && { locationLine: Number(rawLine) }),
        });
      }
    });
    inputEl.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      void this.attachBrowserFiles(files);
    });

    this.elements.inputContainer.addEventListener("dragover", (event) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
        event.preventDefault();
        this.elements.inputContainer.classList.add("attachment-drag-active");
      }
    });
    this.elements.inputContainer.addEventListener("dragleave", () => {
      this.elements.inputContainer.classList.remove("attachment-drag-active");
    });
    this.elements.inputContainer.addEventListener("drop", (event) => {
      this.elements.inputContainer.classList.remove("attachment-drag-active");
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      void this.attachBrowserFiles(files);
    });

    inputEl.addEventListener("keydown", (e) => {
      const isAutocompleteVisible =
        commandAutocomplete.classList.contains("visible");
      const commands = this.getFilteredCommands(inputEl.value.split(/\s/)[0]);

      if (isAutocompleteVisible) {
        if (e.key === "Escape") {
          e.preventDefault();
          this.hideCommandAutocomplete();
          return;
        }
        if (commands.length > 0) {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            this.selectedCommandIndex = Math.min(
              this.selectedCommandIndex + 1,
              commands.length - 1
            );
            this.showCommandAutocomplete(commands);
            return;
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            this.selectedCommandIndex = Math.max(
              this.selectedCommandIndex - 1,
              0
            );
            this.showCommandAutocomplete(commands);
            return;
          } else if (
            e.key === "Tab" ||
            (e.key === "Enter" && this.selectedCommandIndex >= 0)
          ) {
            e.preventDefault();
            this.selectCommand(this.selectedCommandIndex);
            return;
          }
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.clearInput();
      }
    });

    inputEl.addEventListener("input", () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
      this.updateAutocomplete();
      this.saveState();
    });

    commandAutocomplete.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        const index = parseInt(item.getAttribute("data-index") || "0", 10);
        this.selectCommand(index);
      }
    });

    commandAutocomplete.addEventListener("mouseover", (e) => {
      const item = (e.target as HTMLElement).closest(".command-item");
      if (item) {
        this.selectedCommandIndex = parseInt(
          item.getAttribute("data-index") || "0",
          10
        );
        const commands = this.getFilteredCommands(inputEl.value.split(/\s/)[0]);
        this.showCommandAutocomplete(commands);
      }
    });

    messagesEl.addEventListener("keydown", (e) => {
      const messages = Array.from(messagesEl.querySelectorAll(".message"));
      const currentIndex = messages.indexOf(this.doc.activeElement as Element);

      if (e.key === "ArrowDown" && currentIndex < messages.length - 1) {
        e.preventDefault();
        (messages[currentIndex + 1] as HTMLElement).focus();
      } else if (e.key === "ArrowUp" && currentIndex > 0) {
        e.preventDefault();
        (messages[currentIndex - 1] as HTMLElement).focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        (messages[0] as HTMLElement)?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        (messages[messages.length - 1] as HTMLElement)?.focus();
      }
    });

    connectBtn.addEventListener("click", () => {
      this.setInputLock("session", true, "Connecting to agent…");
      this.vscode.postMessage({ type: "connect" });
    });

    welcomeConnectBtn.addEventListener("click", () => {
      this.setInputLock("session", true, "Connecting to agent…");
      this.vscode.postMessage({ type: "connect" });
    });

    agentSelector.addEventListener("change", () => {
      this.vscode.postMessage({
        type: "selectAgent",
        agentId: agentSelector.value,
      });
    });

    modeSelector.addEventListener("change", () => {
      updateSelectLabel(modeSelector, "Mode");
      this.vscode.postMessage({
        type: "selectMode",
        modeId: modeSelector.value,
      });
    });

    modelSelector.addEventListener("change", () => {
      updateSelectLabel(modelSelector, "Model");
      this.vscode.postMessage({
        type: "selectModel",
        modelId: modelSelector.value,
      });
    });
    configOptionsContainer.addEventListener("change", (event) => {
      const select = (event.target as HTMLElement).closest<HTMLSelectElement>(
        ".session-config-select"
      );
      const configId = select?.dataset.configId;
      if (select && configId !== undefined) {
        updateSelectLabel(select, select.dataset.label || configId);
        this.vscode.postMessage({
          type: "selectConfigOption",
          configId,
          value: select.value,
        });
      }
    });

    this.win.addEventListener("message", (e: MessageEvent<ExtensionMessage>) =>
      this.handleMessage(e.data)
    );

    this.elements.permissionModal.addEventListener("click", (e: MouseEvent) => {
      if (e.target === this.elements.permissionModal) {
        this.cancelPermission();
      }
    });

    const cancelBtn = this.elements.permissionModal.querySelector(
      ".permission-cancel-btn"
    );
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => this.cancelPermission());
    }

    this.elements.sessionPicker.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hideSessionHistory();
      } else if (event.key === "Tab") {
        this.trapSessionPickerFocus(event);
      }
    });
  }

  private createAttachmentChip(
    attachment: FileAttachment,
    removable: boolean
  ): HTMLElement {
    const chip = this.doc.createElement("span");
    chip.className = "attachment-chip";
    chip.setAttribute("role", "listitem");
    const transport = attachment.transport ?? "resource_link";
    const transportLabel =
      attachment.kind === "selection"
        ? "Selection"
        : transport === "image"
          ? "Image"
          : transport === "resource"
            ? "Embedded"
            : "Link";

    const details = [
      transportLabel,
      attachment.mimeType,
      formatByteSize(attachment.size),
    ]
      .filter(Boolean)
      .join(" · ");
    chip.title =
      attachment.source === "memory"
        ? `${attachment.name} · ${details}`
        : `${attachment.name} · ${details}\n${attachment.uri}`;
    chip.setAttribute(
      "aria-label",
      `${transportLabel} attachment ${attachment.name}${details ? `, ${details}` : ""}`
    );

    if (attachment.previewDataUrl) {
      const preview = this.doc.createElement("img");
      preview.className = "attachment-chip-preview";
      preview.src = attachment.previewDataUrl;
      preview.alt = "";
      preview.setAttribute("aria-hidden", "true");
      chip.appendChild(preview);
    } else {
      const icon = this.doc.createElement("span");
      icon.className = "attachment-chip-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = attachment.kind === "selection" ? "⌗" : "📄";
      chip.appendChild(icon);
    }

    const name = this.doc.createElement("span");
    name.className = "attachment-chip-name";
    name.textContent = attachment.name;

    const type = this.doc.createElement("span");
    type.className = "attachment-chip-type";
    type.textContent = transportLabel;
    chip.append(name, type);

    if (removable) {
      const remove = this.doc.createElement("button");
      remove.type = "button";
      remove.className = "attachment-chip-remove";
      remove.setAttribute("data-attachment-id", attachment.id);
      remove.setAttribute("aria-label", `Remove ${attachment.name}`);
      remove.title = `Remove ${attachment.name}`;
      remove.disabled = this.inputLocks.size > 0 || this.promptPending;
      remove.textContent = "×";
      chip.appendChild(remove);
    }

    return chip;
  }

  private renderAttachments(): void {
    const bar = this.elements.attachmentsBar;
    bar.textContent = "";
    for (const attachment of this.attachments) {
      bar.appendChild(this.createAttachmentChip(attachment, true));
    }
    bar.classList.toggle("visible", this.attachments.length > 0);
    this.updateInputControls();

    const atLimit = this.attachments.length >= MAX_ATTACHMENTS;
    const supportedKinds = [
      this.promptCapabilities.embeddedContext ? "embedded text" : "file links",
      this.promptCapabilities.image ? "image prompts" : "image links",
    ].join(" and ");
    this.elements.attachBtn.title = atLimit
      ? `Attachment limit reached (${MAX_ATTACHMENTS} files)`
      : `Attach files (${supportedKinds})`;
    this.elements.attachBtn.setAttribute(
      "aria-label",
      this.elements.attachBtn.title
    );
  }

  private removeAttachment(attachmentId: string): void {
    const index = this.attachments.findIndex(
      (attachment) => attachment.id === attachmentId
    );
    if (index < 0) {
      return;
    }
    const [removed] = this.attachments.splice(index, 1);
    this.vscode.postMessage({ type: "removeAttachment", attachmentId });
    this.renderAttachments();
    const remainingButtons =
      this.elements.attachmentsBar.querySelectorAll<HTMLButtonElement>(
        ".attachment-chip-remove"
      );
    const nextButton =
      remainingButtons[Math.min(index, remainingButtons.length - 1)];
    (nextButton ?? this.elements.attachBtn).focus();
    this.announceToScreenReader(`${removed.name} removed.`);
    this.saveState();
  }

  private isAttachmentPreparationPending(): boolean {
    return (
      this.attachmentPickerPending || this.pendingAttachmentRequestIds.size > 0
    );
  }

  private completeAttachmentRequest(requestId: string | undefined): boolean {
    if (requestId === undefined) {
      return true;
    }
    if (!this.pendingAttachmentRequestIds.delete(requestId)) {
      return false;
    }
    this.updateInputControls();
    return true;
  }

  private cancelAttachmentPreparation(): void {
    this.attachmentReadGeneration += 1;
    this.attachmentPickerPending = false;
    this.pendingAttachmentRequestIds.clear();
  }

  private clearAttachments(): void {
    this.cancelAttachmentPreparation();
    this.attachments = [];
    this.renderAttachments();
  }

  private async attachBrowserFiles(files: File[]): Promise<void> {
    if (
      this.inputLocks.size > 0 ||
      this.promptPending ||
      this.isAttachmentPreparationPending()
    ) {
      return;
    }
    const generation = this.attachmentReadGeneration;
    const remaining = MAX_ATTACHMENTS - this.attachments.length;
    if (remaining <= 0) {
      this.showSystemMessageOnce(
        `You can attach up to ${MAX_ATTACHMENTS} files per prompt.`
      );
      return;
    }

    for (const file of files.slice(0, remaining)) {
      const image = isSupportedImageAttachment(
        file.name,
        file.type || undefined
      );
      if (image && !this.promptCapabilities.image) {
        this.showSystemMessageOnce(
          "The current agent does not advertise image prompt support."
        );
        continue;
      }
      if (!image && !this.promptCapabilities.embeddedContext) {
        this.showSystemMessageOnce(
          "The current agent does not advertise embedded context support."
        );
        continue;
      }
      const limit = image ? MAX_IMAGE_BYTES : MAX_EMBEDDED_RESOURCE_BYTES;
      if (file.size > limit) {
        this.showSystemMessageOnce(
          `${file.name || "Attachment"} exceeds the ${limit / 1024 / 1024} MB limit.`
        );
        continue;
      }

      const requestId = `attachment-${++this.attachmentRequestCounter}`;
      this.pendingAttachmentRequestIds.add(requestId);
      this.updateInputControls();
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const view = this.doc.defaultView;
          if (!view) {
            reject(new Error("Webview is unavailable"));
            return;
          }
          const reader = new view.FileReader();
          reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
              resolve(reader.result);
            } else {
              reject(new Error("FileReader returned non-string data"));
            }
          });
          reader.addEventListener("error", () => reject(reader.error));
          reader.readAsDataURL(file);
        });
        if (generation !== this.attachmentReadGeneration) {
          return;
        }
        const comma = dataUrl.indexOf(",");
        if (comma < 0) {
          throw new Error("FileReader returned malformed data");
        }
        this.vscode.postMessage({
          type: "attachContent",
          requestId,
          name: file.name || (image ? "Pasted image" : "Dropped file"),
          mimeType: file.type || undefined,
          data: dataUrl.slice(comma + 1),
        });
      } catch {
        if (generation !== this.attachmentReadGeneration) {
          return;
        }
        this.pendingAttachmentRequestIds.delete(requestId);
        this.updateInputControls();
        this.showSystemMessageOnce(
          `${file.name || "Attachment"} could not be read.`
        );
      }
    }

    if (files.length > remaining) {
      this.showSystemMessageOnce(
        `You can attach up to ${MAX_ATTACHMENTS} files per prompt.`
      );
    }
  }
  private showSystemMessageOnce(text: string): void {
    const lastMessage = this.elements.messagesEl.lastElementChild;
    if (
      lastMessage?.classList.contains("system") &&
      lastMessage.textContent === text
    ) {
      return;
    }
    this.addMessage(text, "system");
    this.updateViewState();
  }

  addMessage(
    text: string,
    type: "user" | "assistant" | "error" | "warning" | "system",
    attachments: readonly FileAttachment[] = []
  ): HTMLElement {
    const div = this.doc.createElement("div");
    div.className = "message " + type;
    div.setAttribute("role", "article");
    div.setAttribute("tabindex", "0");

    const label =
      type === "user"
        ? "Your message"
        : type === "assistant"
          ? "Agent response"
          : type === "error"
            ? "Error message"
            : type === "warning"
              ? "Warning message"
              : "System message";
    div.setAttribute("aria-label", label);

    const attachmentNames = attachments.map((attachment) => attachment.name);
    const copyText = [
      text,
      attachmentNames.length > 0
        ? `[Attached: ${attachmentNames.join(", ")}]`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (type === "assistant" || type === "user") {
      div.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const msgText = this.messageTexts.get(div) || div.textContent || "";
        this.vscode.postMessage({ type: "copyMessage", text: msgText });
      });
    }

    if (text) {
      const textEl = this.doc.createElement("div");
      textEl.className = "message-text";
      textEl.textContent = text;
      div.appendChild(textEl);
    }

    if (attachments.length > 0) {
      const list = this.doc.createElement("div");
      list.className = "message-attachments";
      list.setAttribute("role", "list");
      list.setAttribute("aria-label", "Attached files");
      for (const attachment of attachments) {
        list.appendChild(this.createAttachmentChip(attachment, false));
      }
      div.appendChild(list);
    }

    this.messageTexts.set(div, copyText);
    this.elements.messagesEl.appendChild(div);
    this.elements.messagesEl.scrollTop = this.elements.messagesEl.scrollHeight;

    this.announceToScreenReader(`${label}: ${copyText.substring(0, 100)}`);
    return div;
  }

  private announceToScreenReader(message: string): void {
    const announcement = this.doc.createElement("div");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-live", "polite");
    announcement.className = "sr-only";
    announcement.textContent = message;
    this.doc.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 1000);
  }

  showThinking(): void {
    if (!this.thinkingEl) {
      this.thinkingEl = this.doc.createElement("div");
      this.thinkingEl.className = "message assistant";
      this.thinkingEl.setAttribute("role", "status");
      this.thinkingEl.setAttribute("aria-label", "Agent is thinking");
      this.elements.messagesEl.appendChild(this.thinkingEl);
    }
    let html = '<span class="thinking" aria-label="Processing">Thinking</span>';
    html += getToolsHtml(this.tools, this.expandedToolId);
    this.thinkingEl.innerHTML = html;
    this.elements.messagesEl.scrollTop = this.elements.messagesEl.scrollHeight;
  }

  hideThinking(): void {
    if (this.thinkingEl) {
      this.thinkingEl.remove();
      this.thinkingEl = null;
    }
  }

  updateStatus(state: string, agentInfo?: AgentInfo | null): void {
    this.elements.statusDot.className = "status-dot " + state;
    const labels: Record<string, string> = {
      disconnected: "Disconnected",
      connecting: "Connecting...",
      connected: "Connected",
      error: "Error",
    };
    const identity =
      state === "connected" ? formatAgentIdentity(agentInfo) : null;
    this.elements.statusText.textContent = identity
      ? `Connected · ${identity}`
      : labels[state] || state;
    this.isConnected = state === "connected";
    this.setInputLock(
      "connection",
      state === "connecting",
      "Connecting to agent…"
    );
    this.updateViewState();
    this.saveState();
  }

  private setInputLock(
    reason: string,
    locked: boolean,
    message = "",
    restoreFocus = true
  ): void {
    if (locked) {
      const activeElement = this.doc.activeElement;
      this.restoreInputFocus ||=
        reason === "session" ||
        reason === "replay" ||
        activeElement === this.elements.inputEl ||
        activeElement === this.elements.sendBtn;
      this.inputLocks.set(reason, message || "Preparing session…");
      this.hideCommandAutocomplete();
    } else {
      this.inputLocks.delete(reason);
    }

    this.updateInputControls(restoreFocus);
  }

  private updateInputControls(restoreFocus = true): void {
    const inputLocked = this.inputLocks.size > 0;
    const attachmentPreparing = this.isAttachmentPreparationPending();
    const composerBusy = inputLocked || attachmentPreparing;
    const sendDisabled = composerBusy || this.promptPending;
    const atAttachmentLimit = this.attachments.length >= MAX_ATTACHMENTS;
    let hint = this.commandHint ?? DEFAULT_INPUT_HINT;
    for (const lockMessage of this.inputLocks.values()) {
      hint = lockMessage;
    }
    if (!inputLocked && attachmentPreparing) {
      hint = "Attaching files…";
    }

    this.elements.inputEl.disabled = inputLocked;
    this.elements.inputEl.setAttribute("aria-disabled", String(inputLocked));
    this.elements.sendBtn.disabled = sendDisabled;
    this.elements.sendBtn.setAttribute("aria-disabled", String(sendDisabled));
    this.elements.attachBtn.disabled =
      composerBusy || this.promptPending || atAttachmentLimit;
    for (const button of this.elements.attachmentsBar.querySelectorAll(
      ".attachment-chip-remove"
    )) {
      (button as HTMLButtonElement).disabled =
        inputLocked || this.promptPending;
    }
    this.elements.connectBtn.disabled = inputLocked;
    this.elements.sendBtn.textContent = composerBusy ? "Wait…" : "Send";
    this.elements.sendBtn.setAttribute(
      "aria-label",
      composerBusy ? hint : "Send message"
    );
    this.elements.sendBtn.title = composerBusy ? hint : "Send (Enter)";
    this.elements.welcomeConnectBtn.disabled = inputLocked;
    this.elements.agentSelector.disabled = inputLocked;
    this.elements.modeSelector.disabled = inputLocked;
    this.elements.modelSelector.disabled = inputLocked;
    for (const select of this.elements.configOptionsContainer.querySelectorAll(
      ".session-config-select"
    )) {
      (select as HTMLSelectElement).disabled = inputLocked;
    }
    this.elements.inputContainer.setAttribute(
      "aria-busy",
      String(composerBusy)
    );
    this.elements.inputHint.textContent = hint;

    if (
      !inputLocked &&
      this.restoreInputFocus &&
      restoreFocus &&
      !this.elements.permissionModal.classList.contains("visible") &&
      !this.elements.sessionPicker.classList.contains("visible")
    ) {
      this.restoreInputFocus = false;
      this.elements.inputEl.focus();
    }
  }

  updateViewState(): void {
    const hasMessages = this.elements.messagesEl.children.length > 0;
    this.elements.welcomeView.style.display =
      !this.isConnected && !hasMessages ? "flex" : "none";
    this.elements.messagesEl.style.display =
      this.isConnected || hasMessages ? "flex" : "none";
  }

  private send(): void {
    if (
      this.inputLocks.size > 0 ||
      this.promptPending ||
      this.isAttachmentPreparationPending()
    ) {
      return;
    }
    const text = this.elements.inputEl.value.trim();
    if (!text && this.attachments.length === 0) return;
    const attachmentIds = this.attachments.map((attachment) => attachment.id);
    this.vscode.postMessage({ type: "sendMessage", text, attachmentIds });
    this.elements.inputEl.value = "";
    this.hideCommandAutocomplete();
    this.elements.inputEl.style.height = "auto";
    this.clearAttachments();
    this.promptPending = true;
    this.updateInputControls();
    this.saveState();
  }

  private clearInput(): void {
    this.elements.inputEl.value = "";
    this.elements.inputEl.style.height = "auto";
    this.elements.inputEl.focus();
    this.hideCommandAutocomplete();
    this.saveState();
  }

  getFilteredCommands(query: string): AvailableCommand[] {
    if (!query.startsWith("/")) return [];
    const search = query.slice(1).toLowerCase();
    return this.availableCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().startsWith(search) ||
        cmd.description?.toLowerCase().includes(search)
    );
  }

  showCommandAutocomplete(commands: AvailableCommand[]): void {
    const { commandAutocomplete, inputEl } = this.elements;
    if (commands.length === 0) {
      if (!this.hasCommandCatalog) {
        this.hideCommandAutocomplete();
        return;
      }
      commandAutocomplete.innerHTML =
        '<div class="no-commands" role="option" aria-disabled="true" aria-selected="false">' +
        NO_MATCHING_COMMANDS_MESSAGE +
        "</div>";
      commandAutocomplete.classList.add("visible");
      inputEl.setAttribute("aria-expanded", "true");
      this.setCommandHint(NO_MATCHING_COMMANDS_MESSAGE);
      return;
    }

    commandAutocomplete.innerHTML = commands
      .map((cmd, i) => {
        const hint = cmd.input?.hint
          ? '<div class="command-hint">' + escapeHtml(cmd.input.hint) + "</div>"
          : "";
        return (
          '<div class="command-item' +
          (i === this.selectedCommandIndex ? " selected" : "") +
          '" data-index="' +
          i +
          '" role="option" aria-selected="' +
          (i === this.selectedCommandIndex) +
          '">' +
          '<div class="command-name">' +
          escapeHtml(cmd.name) +
          "</div>" +
          '<div class="command-description">' +
          escapeHtml(cmd.description || "") +
          "</div>" +
          hint +
          "</div>"
        );
      })
      .join("");

    commandAutocomplete.classList.add("visible");
    inputEl.setAttribute("aria-expanded", "true");
    this.setCommandHint(null);
  }

  hideCommandAutocomplete(): void {
    const { commandAutocomplete, inputEl } = this.elements;
    commandAutocomplete.classList.remove("visible");
    commandAutocomplete.innerHTML = "";
    this.selectedCommandIndex = -1;
    inputEl.setAttribute("aria-expanded", "false");
    this.setCommandHint(null);
  }

  /**
   * Mirrors autocomplete state into the input hint live region so screen reader
   * users hear why a slash word produced no commands.
   */
  private setCommandHint(hint: string | null): void {
    if (this.commandHint === hint) return;
    this.commandHint = hint;
    this.updateInputControls(false);
  }

  /**
   * Applies an agent command snapshot, refreshing an already open list so it
   * never renders a stale catalog while keeping the user's highlighted command
   * highlighted when the update still advertises it.
   */
  private applyAvailableCommands(commands: AvailableCommand[]): void {
    const wasVisible =
      this.elements.commandAutocomplete.classList.contains("visible");
    const selectedName =
      wasVisible && this.selectedCommandIndex >= 0
        ? this.getFilteredCommands(this.elements.inputEl.value.split(/\s/)[0])[
            this.selectedCommandIndex
          ]?.name
        : undefined;

    this.availableCommands = commands;
    this.hasCommandCatalog = true;
    if (!wasVisible) return;

    this.updateAutocomplete();
    if (selectedName === undefined) return;

    const filtered = this.getFilteredCommands(
      this.elements.inputEl.value.split(/\s/)[0]
    );
    const index = filtered.findIndex((cmd) => cmd.name === selectedName);
    if (index > 0) {
      this.selectedCommandIndex = index;
      this.showCommandAutocomplete(filtered);
    }
  }

  selectCommand(index: number): void {
    const firstWord = this.elements.inputEl.value.split(/\s/)[0];
    const commands = this.getFilteredCommands(firstWord);
    if (index >= 0 && index < commands.length) {
      const cmd = commands[index];
      this.elements.inputEl.value = "/" + cmd.name + " ";
      this.elements.inputEl.focus();
      this.hideCommandAutocomplete();
    }
  }

  showPlan(entries: PlanEntry[]): void {
    if (entries.length === 0) {
      this.hidePlan();
      return;
    }

    if (!this.planEl) {
      this.planEl = this.doc.createElement("div");
      this.planEl.className = "agent-plan-sticky";
      this.planEl.setAttribute("role", "status");
      this.planEl.setAttribute("aria-live", "polite");
      this.planEl.setAttribute("aria-label", "Agent execution plan");
      this.elements.planContainer.appendChild(this.planEl);
    }

    const completedCount = entries.filter(
      (e) => e.status === "completed"
    ).length;
    const totalCount = entries.length;

    this.planEl.innerHTML = `
      <div class="plan-header">
        <span class="plan-icon">📋</span>
        <span class="plan-title">Agent Plan</span>
        <span class="plan-progress">${completedCount}/${totalCount}</span>
      </div>
      <div class="plan-entries">
        ${entries
          .map(
            (entry) => `
          <div class="plan-entry plan-entry-${entry.status} plan-priority-${entry.priority}">
            <span class="plan-status-icon">${this.getPlanStatusIcon(entry.status)}</span>
            <span class="plan-content">${escapeHtml(entry.content)}</span>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  private getPlanStatusIcon(status: string): string {
    switch (status) {
      case "completed":
        return "✓";
      case "in_progress":
        return "⋯";
      case "pending":
      default:
        return "○";
    }
  }

  hidePlan(): void {
    if (this.planEl) {
      this.planEl.remove();
      this.planEl = null;
    }
  }

  private updateAutocomplete(): void {
    const text = this.elements.inputEl.value;
    const firstWord = text.split(/\s/)[0];

    if (firstWord.startsWith("/") && !text.includes(" ")) {
      const filtered = this.getFilteredCommands(firstWord);
      this.selectedCommandIndex = filtered.length > 0 ? 0 : -1;
      this.showCommandAutocomplete(filtered);
    } else {
      this.hideCommandAutocomplete();
    }
  }

  private clearChatState(): void {
    this.hideThinking();
    this.elements.messagesEl.innerHTML = "";
    this.currentAssistantMessage = null;
    this.currentAssistantText = "";
    this.tools = {};
    this.hasActiveTool = false;
    this.expandedToolId = null;
    this.messageTexts.clear();
    this.availableCommands = [];
    this.hasCommandCatalog = false;
    this.hideCommandAutocomplete();
    this.hidePlan();
    this.hideThought();
    this.hideReplayStatus();
    this.updateViewState();
    this.updateInputControls();
  }

  private showReplayStatus(message = "Restoring conversation…"): void {
    if (!this.replayStatusEl) {
      this.replayStatusEl = this.doc.createElement("div");
      this.replayStatusEl.className = "message system";
      this.replayStatusEl.setAttribute("role", "status");
      this.replayStatusEl.setAttribute("aria-live", "polite");
      this.elements.messagesEl.appendChild(this.replayStatusEl);
    }
    this.replayStatusEl.textContent = message;
  }

  private hideReplayStatus(): void {
    this.replayStatusEl?.remove();
    this.replayStatusEl = null;
  }

  private showSessionHistory(
    mode: "load" | "delete",
    sessions: SessionHistoryEntry[]
  ): void {
    const picker = this.elements.sessionPicker;
    const view = this.doc.defaultView;
    this.sessionPickerPreviousFocus =
      view && this.doc.activeElement instanceof view.HTMLElement
        ? this.doc.activeElement
        : null;
    picker.replaceChildren();

    const panel = this.doc.createElement("div");
    panel.className = "session-picker-content";
    const title = this.doc.createElement("h3");
    title.id = "session-picker-title";
    title.textContent = mode === "load" ? "Load session" : "Delete session";
    panel.appendChild(title);

    const description = this.doc.createElement("p");
    description.textContent =
      mode === "load"
        ? "Choose a saved conversation to restore."
        : "Choose a saved conversation to remove from this workspace history.";
    panel.appendChild(description);

    const list = this.doc.createElement("div");
    list.className = "session-history-list";
    list.setAttribute("role", "list");
    sessions.forEach((session) => {
      const listItem = this.doc.createElement("div");
      listItem.setAttribute("role", "listitem");
      const item = this.doc.createElement("button");
      item.type = "button";
      item.className = "session-history-item";
      item.setAttribute(
        "aria-label",
        `${mode === "load" ? "Load" : "Delete"} ${session.preview || "untitled session"}`
      );

      const preview = this.doc.createElement("span");
      preview.className = "session-history-preview";
      preview.textContent = session.preview || "Untitled session";
      item.appendChild(preview);

      const details = this.doc.createElement("span");
      details.className = "session-history-details";
      details.textContent = `${session.cwd} · ${new Date(session.lastUsedAt).toLocaleString()} · ${session.messageCount} messages`;
      item.appendChild(details);

      item.addEventListener("click", () => {
        item.disabled = true;
        if (mode === "load") {
          this.setInputLock("session-picker", true, "Restoring conversation…");
        }
        this.vscode.postMessage({
          type: mode === "load" ? "selectSession" : "deleteSession",
          sessionId: session.sessionId,
        });
      });
      listItem.appendChild(item);
      list.appendChild(listItem);
    });
    panel.appendChild(list);

    const close = this.doc.createElement("button");
    close.type = "button";
    close.className = "session-picker-close";
    close.textContent = "Cancel";
    close.addEventListener("click", () => this.hideSessionHistory());
    panel.appendChild(close);

    picker.appendChild(panel);
    picker.classList.add("visible");
    const firstSession = list.querySelector("button");
    if (view && firstSession instanceof view.HTMLButtonElement) {
      firstSession.focus();
    } else {
      picker.focus();
    }
  }

  private trapSessionPickerFocus(event: KeyboardEvent): void {
    const focusable = Array.from(
      this.elements.sessionPicker.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)"
      )
    );
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.doc.activeElement;
    if (!focusable.includes(active as HTMLButtonElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private hideSessionHistory(): void {
    this.elements.sessionPicker.classList.remove("visible");
    this.elements.sessionPicker.replaceChildren();
    this.setInputLock("session-picker", false);
    this.sessionPickerPreviousFocus?.focus();
    this.sessionPickerPreviousFocus = null;
    this.updateInputControls();
  }

  private clearSessionOptions(): void {
    this.hasSessionConfigOptions = false;
    this.elements.configOptionsContainer.replaceChildren();
    this.elements.modeSelector.replaceChildren();
    this.elements.modeSelector.style.display = "none";
    this.elements.modelSelector.replaceChildren();
    this.elements.modelSelector.style.display = "none";
  }

  private renderSessionConfigOptions(
    configOptions: readonly SessionConfigOption[]
  ): void {
    this.clearSessionOptions();
    this.hasSessionConfigOptions = true;

    for (const configOption of configOptions) {
      if (configOption.type !== "select") {
        continue;
      }
      const label = configOption.name || configOption.id;
      const select = this.doc.createElement("select");
      select.className = "inline-select session-config-select";
      select.dataset.configId = configOption.id;
      select.dataset.label = label;
      select.setAttribute("aria-label", `Select ${label}`);
      if (configOption.description) {
        select.title = configOption.description;
      }

      for (const entry of configOption.options) {
        if ("value" in entry) {
          const element = this.doc.createElement("option");
          element.value = entry.value;
          element.textContent = entry.name || entry.value;
          element.dataset.label = entry.name || entry.value;
          if (entry.description) {
            element.title = entry.description;
          }
          select.appendChild(element);
          continue;
        }

        const group = this.doc.createElement("optgroup");
        group.label = entry.name || entry.group;
        group.dataset.group = entry.group;
        for (const value of entry.options) {
          const element = this.doc.createElement("option");
          element.value = value.value;
          element.textContent = value.name || value.value;
          element.dataset.label = value.name || value.value;
          if (value.description) {
            element.title = value.description;
          }
          group.appendChild(element);
        }
        select.appendChild(group);
      }

      if (select.options.length === 0) {
        continue;
      }
      select.value = configOption.currentValue;
      select.style.display = "inline-block";
      updateSelectLabel(select, label);
      this.elements.configOptionsContainer.appendChild(select);
    }
    this.updateInputControls(false);
  }

  handleMessage(msg: ExtensionMessage): void {
    const { modeSelector, modelSelector, agentSelector, connectBtn } =
      this.elements;

    switch (msg.type) {
      // The composer stays editable while session setup runs, so a draft typed
      // in the meantime wins over the prompt that never started.
      case "restoreInput":
        if (msg.text && !this.elements.inputEl.value) {
          this.elements.inputEl.value = msg.text;
          this.elements.inputEl.style.height = "auto";
          this.elements.inputEl.focus();
          this.saveState();
        }
        break;

      case "focusComposer":
        if (
          this.elements.inputEl.disabled ||
          this.elements.permissionModal.classList.contains("visible") ||
          this.elements.sessionPicker.classList.contains("visible")
        ) {
          this.restoreInputFocus = true;
        } else {
          this.elements.inputEl.focus();
        }
        break;

      case "userMessage":
        if (msg.text || (msg.attachments?.length ?? 0) > 0) {
          this.addMessage(msg.text ?? "", "user", msg.attachments ?? []);
          this.showThinking();
          this.updateViewState();
          this.promptPending = true;
          this.updateInputControls();
        }
        break;
      case "filesAttached": {
        const incoming = Array.isArray(msg.attachments) ? msg.attachments : [];
        if (!this.completeAttachmentRequest(msg.requestId)) {
          for (const attachment of incoming) {
            if (!this.attachments.some(({ id }) => id === attachment.id)) {
              this.vscode.postMessage({
                type: "removeAttachment",
                attachmentId: attachment.id,
              });
            }
          }
          break;
        }
        const beforeCount = this.attachments.length;
        const existingUris = new Set(
          this.attachments.map((attachment) => attachment.uri)
        );
        for (const attachment of incoming) {
          if (
            this.attachments.length >= MAX_ATTACHMENTS ||
            existingUris.has(attachment.uri) ||
            !isFileAttachmentValid(attachment)
          ) {
            continue;
          }
          this.attachments.push(attachment);
          existingUris.add(attachment.uri);
        }
        const addedCount = this.attachments.length - beforeCount;
        this.renderAttachments();
        this.saveState();
        if (addedCount > 0) {
          this.announceToScreenReader(
            `${addedCount} file${addedCount === 1 ? "" : "s"} attached.`
          );
        }
        if ((msg.skippedCount ?? 0) > 0) {
          const skippedCount = msg.skippedCount ?? 0;
          this.showSystemMessageOnce(
            `${skippedCount} file${skippedCount === 1 ? " was" : "s were"} not attached.`
          );
        }
        break;
      }
      case "attachmentPreparation":
        this.attachmentPickerPending = msg.active === true;
        this.updateInputControls();
        break;
      case "attachmentLimitReached":
        if (!this.completeAttachmentRequest(msg.requestId)) {
          break;
        }
        this.showSystemMessageOnce(
          `You can attach up to ${msg.max ?? MAX_ATTACHMENTS} files per prompt.`
        );
        break;
      case "attachmentError":
        if (!this.completeAttachmentRequest(msg.requestId)) {
          break;
        }
        if (msg.text) this.addMessage(msg.text, "error");
        break;
      case "attachmentWarning":
        if (msg.text) this.showSystemMessageOnce(msg.text);
        break;
      case "streamStart":
        this.currentAssistantText = "";
        this.hasActiveTool = false;
        this.hideThought();
        break;
      case "streamChunk":
        if (this.hasActiveTool && msg.text) {
          this.hideThinking();
          if (Object.keys(this.tools).length > 0) {
            const toolMessage = this.addMessage("", "assistant");
            toolMessage.innerHTML = getToolsHtml(
              this.tools,
              this.expandedToolId
            );
          }
          this.currentAssistantMessage = null;
          this.currentAssistantText = "";
          this.tools = {};
          this.expandedToolId = null;
          this.hasActiveTool = false;
        }

        if (!this.currentAssistantMessage) {
          this.hideThinking();
          this.currentAssistantMessage = this.addMessage("", "assistant");
        }
        if (msg.text) {
          this.currentAssistantText += msg.text;
          this.currentAssistantMessage.textContent = this.currentAssistantText;
          this.elements.messagesEl.scrollTop =
            this.elements.messagesEl.scrollHeight;
        }
        break;
      case "streamEnd": {
        this.hideThinking();
        if (msg.stopReason === "cancelled") {
          for (const tool of Object.values(this.tools)) {
            if (tool.status === "running") {
              tool.status = "cancelled";
            }
          }
        }

        if (
          !this.currentAssistantMessage &&
          Object.keys(this.tools).length > 0
        ) {
          this.currentAssistantMessage = this.addMessage("", "assistant");
        }
        this.finalizeCurrentMessage();

        this.currentAssistantMessage = null;
        this.currentAssistantText = "";
        this.tools = {};
        this.hasActiveTool = false;
        this.expandedToolId = null;
        this.hideThought();
        if (!msg.suppressStopReason) {
          this.renderStopReason(msg.stopReason);
        }
        this.updateViewState();
        this.promptPending = false;
        this.updateInputControls();
        if (
          this.inputLocks.size === 0 &&
          !this.elements.permissionModal.classList.contains("visible") &&
          !this.elements.sessionPicker.classList.contains("visible")
        ) {
          this.elements.inputEl.focus();
        }
        break;
      }
      case "toolCallStart": {
        const toolName =
          typeof msg.title === "string" && msg.title.length > 0
            ? msg.title
            : typeof msg.name === "string" && msg.name.length > 0
              ? msg.name
              : null;
        if (msg.toolCallId && toolName) {
          // Keep a whitespace-only bubble alive until stream end so its tool
          // card renders through the same finalized Markdown path.
          if (this.currentAssistantText.trim()) {
            this.finalizeCurrentMessage();
            this.currentAssistantMessage = null;
            this.currentAssistantText = "";
          }

          this.tools[msg.toolCallId] = {
            name: toolName,
            input: null,
            output: null,
            status: "running",
          };
          this.applyToolMetadata(msg.toolCallId, msg);
          this.hasActiveTool = true;
          this.showThinking();
        }
        break;
      }
      case "toolCallUpdate":
        if (msg.toolCallId && this.tools[msg.toolCallId]) {
          this.applyToolMetadata(msg.toolCallId, msg);
          this.showThinking();
        }
        break;
      case "agentError":
      case "error":
        this.hideThinking();
        if (msg.text) this.addMessage(msg.text, "error");
        if (
          !this.promptPending &&
          this.inputLocks.size === 0 &&
          !this.elements.permissionModal.classList.contains("visible") &&
          !this.elements.sessionPicker.classList.contains("visible")
        ) {
          this.elements.inputEl.focus();
        }
        this.updateViewState();
        break;
      case "toolLocationError":
        if (msg.text) this.addMessage(msg.text, "error");
        this.updateViewState();
        break;
      case "sessionTransition":
        if (msg.active === true) {
          this.cancelAttachmentPreparation();
          this.clearSessionOptions();
        }
        this.setInputLock(
          "session",
          msg.active === true,
          msg.text || "Preparing session…",
          msg.restoreFocus !== false
        );
        break;
      case "connectionState":
        if (msg.state) {
          this.updateStatus(msg.state, msg.agentInfo);
          if (msg.state === "disconnected" || msg.state === "error") {
            this.promptCapabilities = {
              image: false,
              embeddedContext: false,
            };
            this.clearAttachments();
          } else if (msg.state === "connecting") {
            this.promptCapabilities = {
              image: false,
              embeddedContext: false,
            };
            this.renderAttachments();
          }
          if (msg.state !== "connected") {
            this.clearSessionOptions();
          }
          connectBtn.style.display =
            msg.state === "connected" ? "none" : "inline-block";
        }
        break;
      case "agents":
        if (!msg.agents) break;
        agentSelector.innerHTML = "";
        msg.agents.forEach((a) => {
          const opt = this.doc.createElement("option");
          opt.value = a.id;
          opt.textContent = a.available ? a.name : a.name + " (not installed)";
          if (!a.available) {
            opt.style.color = "var(--vscode-disabledForeground)";
          }
          if (a.id === msg.selected) opt.selected = true;
          agentSelector.appendChild(opt);
        });
        break;
      case "agentChanged":
        this.updateStatus("disconnected");
        this.clearChatState();
        this.clearAttachments();
        this.clearSessionOptions();
        this.clearPermissionModal();
        this.saveState();
        break;
      case "chatCleared":
        this.hideSessionHistory();
        this.clearChatState();
        this.clearAttachments();
        this.clearSessionOptions();
        this.clearPermissionModal();
        this.saveState();
        break;
      case "triggerNewChat":
        this.setInputLock("session", true, "Starting a new session…");
        this.vscode.postMessage({ type: "newChat" });
        break;
      case "triggerClearChat":
        this.vscode.postMessage({ type: "clearChat" });
        break;
      case "sessionHistory":
        if (msg.mode && msg.sessions) {
          this.showSessionHistory(msg.mode, msg.sessions);
        }
        break;
      case "sessionDeleted":
        this.hideSessionHistory();
        break;
      case "replayStart":
        this.cancelAttachmentPreparation();
        this.promptPending = false;
        this.clearSessionOptions();
        this.setInputLock("replay", true, "Restoring conversation…");
        this.hideSessionHistory();
        this.showReplayStatus();
        break;
      case "replayComplete":
        this.clearChatState();
        this.clearAttachments();
        msg.messages?.forEach((message) => {
          if (message.role === "user") {
            this.addMessage(message.text, "user", message.attachments ?? []);
            return;
          }

          this.currentAssistantMessage = this.addMessage("", "assistant");
          this.currentAssistantText = message.text;
          this.finalizeCurrentMessage();
          this.currentAssistantMessage = null;
          this.currentAssistantText = "";
        });
        this.showReplayStatus("Conversation restored.");
        this.setInputLock("replay", false);
        this.saveState();
        this.updateViewState();
        break;
      case "replayFailed":
        this.hideSessionHistory();
        this.hideReplayStatus();
        if (msg.text) {
          this.addMessage(
            `Could not restore session: ${msg.text}. Try another saved session or start a new chat.`,
            "error"
          );
        }
        this.setInputLock("replay", false);
        break;
      case "sessionMetadata": {
        this.promptCapabilities = {
          image: msg.promptCapabilities?.image === true,
          embeddedContext: msg.promptCapabilities?.embeddedContext === true,
        };
        this.renderAttachments();
        if (Array.isArray(msg.configOptions)) {
          this.renderSessionConfigOptions(msg.configOptions);
        } else {
          this.clearSessionOptions();
          const hasModes =
            msg.modes &&
            msg.modes.availableModes &&
            msg.modes.availableModes.length > 0;
          const hasModels =
            msg.models &&
            msg.models.availableModels &&
            msg.models.availableModels.length > 0;

          if (hasModes && msg.modes) {
            modeSelector.style.display = "inline-block";
            msg.modes.availableModes.forEach((mode) => {
              const option = this.doc.createElement("option");
              option.value = mode.id;
              option.textContent = mode.name || mode.id;
              option.dataset.label = mode.name || mode.id;
              if (mode.id === msg.modes?.currentModeId) option.selected = true;
              modeSelector.appendChild(option);
            });
            updateSelectLabel(modeSelector, "Mode");
          }

          if (hasModels && msg.models) {
            modelSelector.style.display = "inline-block";
            msg.models.availableModels.forEach((model) => {
              const option = this.doc.createElement("option");
              option.value = model.modelId;
              option.textContent = model.name || model.modelId;
              option.dataset.label = model.name || model.modelId;
              if (model.modelId === msg.models?.currentModelId) {
                option.selected = true;
              }
              modelSelector.appendChild(option);
            });
            updateSelectLabel(modelSelector, "Model");
          }
        }

        if (msg.commands && Array.isArray(msg.commands)) {
          this.applyAvailableCommands(msg.commands);
        }
        break;
      }
      case "modeUpdate":
        if (!this.hasSessionConfigOptions && msg.modeId) {
          modeSelector.value = msg.modeId;
          updateSelectLabel(modeSelector, "Mode");
        }
        break;
      case "availableCommands":
        if (msg.commands && Array.isArray(msg.commands)) {
          this.applyAvailableCommands(msg.commands);
        }
        break;
      case "plan":
        if (msg.plan && msg.plan.entries) {
          this.showPlan(msg.plan.entries);
        }
        break;
      case "planComplete":
        this.hidePlan();
        break;
      case "thoughtChunk":
        if (msg.text) {
          this.appendThought(msg.text);
        }
        break;
      case "permissionRequest":
        if (msg.requestId && msg.options) {
          this.showPermissionModal(
            msg.requestId,
            msg.title,
            msg.rawInput,
            msg.options,
            msg.executable === true
          );
        }
        break;
      case "permissionRequestExpired":
        if (msg.requestId) {
          this.handlePermissionExpired(msg.requestId);
        }
        break;
    }
  }

  private applyToolMetadata(toolCallId: string, msg: ExtensionMessage): void {
    const tool = this.tools[toolCallId];
    if (msg.content !== undefined || msg.rawOutput !== undefined) {
      tool.output = getToolOutput(msg);
    }
    if (msg.rawInput !== undefined) {
      tool.input = getToolInput(msg.rawInput);
    }
    const updatedName =
      typeof msg.title === "string" && msg.title.length > 0
        ? msg.title
        : typeof msg.name === "string" && msg.name.length > 0
          ? msg.name
          : null;
    if (updatedName) {
      tool.name = updatedName;
    }
    if (msg.kind) {
      tool.kind = msg.kind;
    }
    if (msg.locations !== undefined) {
      tool.locations = normalizeToolLocations(msg.locations);
    }
    if (msg.status === "completed" || msg.status === "failed") {
      tool.status = msg.status;
      this.expandedToolId = toolCallId;
    } else if (msg.status === "pending" || msg.status === "in_progress") {
      tool.status = "running";
    }
  }

  appendThought(text: string): void {
    this.thoughtText += text;

    if (!this.thoughtEl) {
      this.thoughtEl = this.doc.createElement("details");
      this.thoughtEl.className = "agent-thought";
      this.thoughtEl.setAttribute("open", "");
      this.thoughtEl.setAttribute("role", "status");
      this.thoughtEl.setAttribute("aria-live", "polite");
      this.thoughtEl.setAttribute("aria-label", "Assistant is thinking");
      this.thoughtEl.innerHTML = `
        <summary class="thought-header">
          <span class="thought-icon">💭</span>
          <span class="thought-title">Thinking...</span>
        </summary>
        <div class="thought-content"></div>
      `;
      this.elements.messagesEl.appendChild(this.thoughtEl);
    }

    const contentEl = this.thoughtEl.querySelector(".thought-content");
    if (contentEl) {
      contentEl.textContent = this.thoughtText;
    }
    this.elements.messagesEl.scrollTop = this.elements.messagesEl.scrollHeight;
  }

  hideThought(): void {
    if (this.thoughtEl) {
      this.thoughtEl.remove();
      this.thoughtEl = null;
      this.thoughtText = "";
    }
  }

  private renderStopReason(stopReason: ExtensionMessage["stopReason"]): void {
    switch (stopReason) {
      case "max_tokens":
        this.addMessage(
          "Response stopped because the agent reached its token limit.",
          "warning"
        );
        break;
      case "max_turn_requests":
        this.addMessage(
          "Response stopped because the agent reached its turn request limit.",
          "warning"
        );
        break;
      case "refusal":
        this.addMessage(
          "The agent refused this turn. This prompt and everything after it will not be included in the next prompt.",
          "error"
        );
        break;
      case "cancelled":
        this.addMessage("Response cancelled.", "system");
        break;
    }
  }

  private finalizeCurrentMessage(): void {
    if (!this.currentAssistantMessage) {
      return;
    }

    const hasText = this.currentAssistantText.trim().length > 0;
    // Tools are rendered into the same bubble, so a turn whose only text was
    // whitespace must still keep its completed tool card.
    const toolsHtml = getToolsHtml(this.tools, this.expandedToolId);
    if (!hasText && !toolsHtml) {
      this.messageTexts.delete(this.currentAssistantMessage);
      this.currentAssistantMessage.remove();
      return;
    }

    const sanitizedMarkdown = hasText
      ? this.sanitizer.sanitize(
          markdown.parse(this.currentAssistantText) as string,
          SANITIZE_CONFIG
        )
      : "";
    this.currentAssistantMessage.innerHTML = sanitizedMarkdown + toolsHtml;
    this.messageTexts.set(
      this.currentAssistantMessage,
      this.currentAssistantText
    );
    this.elements.messagesEl.scrollTop = this.elements.messagesEl.scrollHeight;
  }

  getTools(): Record<string, Tool> {
    return this.tools;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  showPermissionModal(
    requestId: string,
    title: string | undefined,
    content: unknown,
    options: PermissionOption[],
    executable = false
  ): void {
    if (this.pendingPermissionRequestId) {
      this.permissionQueue.push({
        requestId,
        title,
        content,
        options,
        executable,
      });
      return;
    }
    this.presentPermissionModal(requestId, title, content, options, executable);
  }

  private presentPermissionModal(
    requestId: string,
    _title: string | undefined,
    content: unknown,
    options: PermissionOption[],
    executable: boolean
  ): void {
    this.pendingPermissionRequestId = requestId;
    this.previouslyFocusedElement = this.doc.activeElement as HTMLElement;

    if (this.permissionKeydownHandler) {
      this.doc.removeEventListener("keydown", this.permissionKeydownHandler);
      this.permissionKeydownHandler = null;
    }

    if (this.permissionUnlockTimer !== null) {
      this.win.clearTimeout(this.permissionUnlockTimer);
      this.permissionUnlockTimer = null;
    }
    if (this.permissionScrollHandler) {
      this.elements.permissionModal
        .querySelector(".permission-content")
        ?.removeEventListener("scroll", this.permissionScrollHandler);
      this.permissionScrollHandler = null;
    }
    // Every prompt starts locked. Approval unlocks only after the click guard
    // and, when details overflow, after the user reaches the end.
    this.permissionGuardElapsed = false;
    this.permissionDetailsReviewed = false;

    const modal = this.elements.permissionModal;

    const titleEl = modal.querySelector(".permission-title") as HTMLElement;
    const contentEl = modal.querySelector(".permission-content") as HTMLElement;
    const optionsEl = modal.querySelector(".permission-options") as HTMLElement;

    titleEl.textContent = "Agent requests permission";
    contentEl.textContent = formatPermissionContent(content);
    // Approving a structured terminal payload starts a process; the JSON alone
    // does not tell the user that, so the extension says it outright.
    const warningEl = modal.querySelector(".permission-warning") as HTMLElement;
    const executionWarning = executable
      ? "Approving runs this program on your machine with your permissions."
      : "";
    warningEl.textContent = executionWarning;
    warningEl.hidden = !executable;

    optionsEl.replaceChildren();
    options.forEach((option) => {
      const btn = this.doc.createElement("button");
      btn.className = "permission-option-btn";
      btn.dataset.optionId = option.id;
      btn.dataset.optionKind = option.kind ?? "";
      btn.disabled = true;
      const label = this.doc.createElement("span");
      label.className = "option-label";
      label.textContent = option.kind
        ? PERMISSION_OPTION_LABELS[option.kind]
        : "Permission option";
      btn.appendChild(label);
      btn.addEventListener("click", () =>
        this.handlePermissionOption(option.id)
      );
      optionsEl.appendChild(btn);
    });

    modal.classList.add("visible");
    this.permissionScrollHandler = () => {
      if (
        contentEl.scrollTop + contentEl.clientHeight >=
        contentEl.scrollHeight - 1
      ) {
        this.permissionDetailsReviewed = true;
        warningEl.textContent = executionWarning;
        warningEl.hidden = !executable;
        this.updatePermissionApprovalState();
      }
    };
    contentEl.addEventListener("scroll", this.permissionScrollHandler);

    this.permissionKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancelPermission();
        return;
      }
      if (e.key === "Tab") {
        this.trapPermissionFocus(e);
      }
    };
    this.doc.addEventListener("keydown", this.permissionKeydownHandler);

    this.permissionUnlockTimer = this.win.setTimeout(() => {
      if (this.pendingPermissionRequestId === requestId) {
        this.permissionUnlockTimer = null;
        if (contentEl.scrollHeight <= contentEl.clientHeight + 1) {
          this.permissionDetailsReviewed = true;
        } else {
          warningEl.textContent = `${executionWarning}${
            executionWarning ? " " : ""
          }Scroll to the end of the details to enable approval.`;
          warningEl.hidden = false;
        }
        this.permissionGuardElapsed = true;
        this.updatePermissionApprovalState();
      }
    }, PERMISSION_GUARD_MS);

    modal.focus();
  }

  private updatePermissionApprovalState(): void {
    this.elements.permissionModal
      .querySelectorAll<HTMLButtonElement>(".permission-option-btn")
      .forEach((button) => {
        const approval = button.dataset.optionKind?.startsWith("allow_");
        button.disabled =
          !this.permissionGuardElapsed ||
          (approval === true && !this.permissionDetailsReviewed);
      });
  }

  private trapPermissionFocus(e: KeyboardEvent): void {
    const modal = this.elements.permissionModal;
    const focusable = Array.from(
      modal.querySelectorAll<HTMLButtonElement>(
        ".permission-option-btn:not(:disabled), .permission-cancel-btn:not(:disabled)"
      )
    );

    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.doc.activeElement;
    const activeIndex = focusable.findIndex((element) => element === active);

    if (activeIndex === -1) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  hidePermissionModal(): void {
    this.closePermissionModal(true);
  }

  private clearPermissionModal(): void {
    this.permissionQueue = [];
    this.closePermissionModal(false);
  }

  private closePermissionModal(showNext: boolean): void {
    this.elements.permissionModal.classList.remove("visible");
    this.pendingPermissionRequestId = null;

    if (this.permissionKeydownHandler) {
      this.doc.removeEventListener("keydown", this.permissionKeydownHandler);
      this.permissionKeydownHandler = null;
    }

    if (this.permissionUnlockTimer !== null) {
      this.win.clearTimeout(this.permissionUnlockTimer);
      this.permissionUnlockTimer = null;
    }
    if (this.permissionScrollHandler) {
      this.elements.permissionModal
        .querySelector(".permission-content")
        ?.removeEventListener("scroll", this.permissionScrollHandler);
      this.permissionScrollHandler = null;
    }
    this.permissionGuardElapsed = false;
    this.permissionDetailsReviewed = false;

    if (this.previouslyFocusedElement) {
      if (this.doc.contains(this.previouslyFocusedElement)) {
        try {
          this.previouslyFocusedElement.focus();
        } catch {
          // Element may be unfocusable; ignore.
        }
      }
      this.previouslyFocusedElement = null;
    }

    const next = showNext ? this.permissionQueue.shift() : undefined;
    if (next) {
      this.presentPermissionModal(
        next.requestId,
        next.title,
        next.content,
        next.options,
        next.executable
      );
    } else {
      this.updateInputControls();
    }
  }

  private handlePermissionExpired(requestId: string): void {
    if (this.pendingPermissionRequestId === requestId) {
      this.addMessage("Permission request expired and was denied.", "system");
      // The backend already resolved this request; close without responding.
      this.hidePermissionModal();
      return;
    }

    const previousQueueLength = this.permissionQueue.length;
    this.permissionQueue = this.permissionQueue.filter(
      (req) => req.requestId !== requestId
    );
    if (this.permissionQueue.length !== previousQueueLength) {
      this.addMessage("Permission request expired and was denied.", "system");
    }
  }

  private handlePermissionOption(optionId: string): void {
    const option = Array.from(
      this.elements.permissionModal.querySelectorAll<HTMLButtonElement>(
        ".permission-option-btn"
      )
    ).find((button) => button.dataset.optionId === optionId);
    if (!option || option.disabled || !this.pendingPermissionRequestId) {
      return;
    }
    this.vscode.postMessage({
      type: "permissionResponse",
      requestId: this.pendingPermissionRequestId,
      optionId,
    });
    this.hidePermissionModal();
  }

  cancelPermission(): void {
    if (this.pendingPermissionRequestId) {
      this.vscode.postMessage({
        type: "permissionResponse",
        requestId: this.pendingPermissionRequestId,
        cancelled: true,
      });
      this.hidePermissionModal();
    }
  }
}

export function initWebview(
  vscode: VsCodeApi,
  doc: Document,
  win: Window
): WebviewController {
  const elements = getElements(doc);
  return new WebviewController(vscode, elements, doc, win);
}

declare global {
  interface Window {
    webviewController?: WebviewController;
  }
}

if (typeof acquireVsCodeApi !== "undefined") {
  const vscode = acquireVsCodeApi();
  window.webviewController = initWebview(vscode, document, window);
}
