import type { AnyMessage, JsonRpcId, Stream } from "@agentclientprotocol/sdk";

export type ACPDiagnosticsDirection = "client->agent" | "agent->client";

type DiagnosticOutcome =
  "pending" | "sent" | "received" | "ok" | "error" | "cancelled" | "unmatched";

type StructuralMetadata = Record<string, boolean | number | string>;

interface PendingRequest {
  correlation: string;
  method: string;
  startedAt: number;
}

type BoundedRequestId = string | number;

interface TraceState {
  clientRequests: Map<BoundedRequestId, PendingRequest>;
  agentRequests: Map<BoundedRequestId, PendingRequest>;
}

export interface ACPDiagnosticsSink {
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

const KNOWN_METHODS: Readonly<Record<string, true>> = {
  initialize: true,
  authenticate: true,
  logout: true,
  "providers/list": true,
  "providers/set": true,
  "providers/disable": true,
  "session/new": true,
  "session/load": true,
  "session/list": true,
  "session/delete": true,
  "session/fork": true,
  "session/resume": true,
  "session/close": true,
  "session/set_mode": true,
  "session/set_config_option": true,
  "session/prompt": true,
  "session/cancel": true,
  "session/request_permission": true,
  "session/update": true,
  "mcp/connect": true,
  "mcp/message": true,
  "mcp/disconnect": true,
  "fs/write_text_file": true,
  "fs/read_text_file": true,
  "terminal/create": true,
  "terminal/output": true,
  "terminal/release": true,
  "terminal/wait_for_exit": true,
  "terminal/kill": true,
  "elicitation/create": true,
  "elicitation/complete": true,
  "nes/start": true,
  "nes/suggest": true,
  "nes/accept": true,
  "nes/reject": true,
  "nes/close": true,
  "document/didOpen": true,
  "document/didChange": true,
  "document/didClose": true,
  "document/didSave": true,
  "document/didFocus": true,
  "$/cancel_request": true,
};

const SESSION_UPDATE_KINDS: Readonly<Record<string, true>> = {
  user_message_chunk: true,
  agent_message_chunk: true,
  agent_thought_chunk: true,
  tool_call: true,
  tool_call_update: true,
  plan: true,
  plan_update: true,
  plan_removed: true,
  available_commands_update: true,
  current_mode_update: true,
  config_option_update: true,
  session_info_update: true,
  usage_update: true,
  compaction_update: true,
  compaction_summary_chunk: true,
};

const CONTENT_KINDS = [
  "text",
  "image",
  "audio",
  "resource_link",
  "resource",
] as const;

const MAX_PENDING_REQUESTS = 256;
const MAX_COUNT = 10_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_REQUEST_ID_BYTES = 256;

function createTraceState(): TraceState {
  return {
    clientRequests: new Map(),
    agentRequests: new Map(),
  };
}

function clearTraceState(state: TraceState): void {
  state.clientRequests.clear();
  state.agentRequests.clear();
}

function boundedRequestId(value: unknown): BoundedRequestId | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return Buffer.byteLength(value, "utf8") <= MAX_REQUEST_ID_BYTES
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedCount(value: unknown): number {
  return Array.isArray(value) ? Math.min(value.length, MAX_COUNT) : 0;
}

function boundedBytes(value: unknown): number {
  return typeof value === "string"
    ? Math.min(Buffer.byteLength(value, "utf8"), MAX_COUNT)
    : 0;
}

function isCall(
  message: AnyMessage
): message is Extract<AnyMessage, { method: string }> {
  return "method" in message;
}

function hasRequestId(
  message: AnyMessage
): message is Extract<AnyMessage, { method: string; id: JsonRpcId }> {
  return isCall(message) && "id" in message;
}

function isErrorResponse(
  message: AnyMessage
): message is AnyMessage & { error: unknown } {
  return !isCall(message) && "error" in message;
}

function requestMetadata(method: string, params: unknown): StructuralMetadata {
  const record = asRecord(params);
  if (!record) {
    return {};
  }

  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof record.protocolVersion === "number"
            ? record.protocolVersion
            : 0,
      };
    case "session/new":
    case "session/load":
      return {
        additionalDirectoryCount: boundedCount(record.additionalDirectories),
        mcpServerCount: boundedCount(record.mcpServers),
      };
    case "session/prompt": {
      const prompt = Array.isArray(record.prompt) ? record.prompt : [];
      const metadata: StructuralMetadata = {
        contentCount: Math.min(prompt.length, MAX_COUNT),
      };
      for (const kind of CONTENT_KINDS) {
        const count = prompt.reduce((total, item) => {
          const content = asRecord(item);
          return total + (content?.type === kind ? 1 : 0);
        }, 0);
        if (count > 0) {
          metadata[`${kind}Count`] = Math.min(count, MAX_COUNT);
        }
      }
      return metadata;
    }
    case "session/update": {
      const update = asRecord(record.update);
      const updateType = update?.sessionUpdate;
      return {
        updateType:
          typeof updateType === "string" &&
          Object.prototype.hasOwnProperty.call(
            SESSION_UPDATE_KINDS,
            updateType
          )
            ? updateType
            : "unknown",
      };
    }
    case "fs/read_text_file":
      return {
        hasLine: typeof record.line === "number",
        hasLimit: typeof record.limit === "number",
      };
    case "fs/write_text_file":
      return { contentBytes: boundedBytes(record.content) };
    case "terminal/create":
      return {
        argumentCount: boundedCount(record.args),
        environmentEntryCount: boundedCount(record.env),
        hasOutputByteLimit: typeof record.outputByteLimit === "number",
      };
    default:
      return {};
  }
}

function responseMetadata(method: string, result: unknown): StructuralMetadata {
  const record = asRecord(result);
  if (!record) {
    return {};
  }

  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof record.protocolVersion === "number"
            ? record.protocolVersion
            : 0,
        authMethodCount: boundedCount(record.authMethods),
      };
    case "session/new":
    case "session/load":
      return {
        hasSessionId: typeof record.sessionId === "string",
        modeCount: boundedCount(asRecord(record.modes)?.availableModes),
        configOptionCount: boundedCount(record.configOptions),
      };
    case "session/list":
      return { sessionCount: boundedCount(record.sessions) };
    case "terminal/output":
      return {
        outputBytes: boundedBytes(record.output),
        truncated: record.truncated === true,
        hasExitStatus: record.exitStatus !== undefined,
      };
    case "terminal/wait_for_exit":
      return { hasExitStatus: record.exitStatus !== undefined };
    case "fs/read_text_file":
      return { contentBytes: boundedBytes(record.content) };
    default:
      return {};
  }
}

/**
 * Records a fixed, bounded description of ACP traffic. Protocol values are
 * inspected only by method-specific allowlists; unknown methods expose no
 * payload metadata.
 */
export class ACPDiagnostics {
  private readonly directState = createTraceState();
  private nextCorrelation = 0;

  constructor(
    private readonly sink: ACPDiagnosticsSink,
    private readonly isEnabled: () => boolean,
    private readonly now: () => number = Date.now
  ) {}

  show(): void {
    this.sink.show(true);
  }

  record(direction: ACPDiagnosticsDirection, message: AnyMessage): void {
    this.recordMessage(this.directState, direction, message);
  }

  wrap(stream: Stream): Stream {
    const state = createTraceState();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    let writerReleased = false;
    let readerReleased = false;
    const releaseWriter = () => {
      if (!writerReleased) {
        writerReleased = true;
        writer.releaseLock();
      }
    };
    const releaseReader = () => {
      if (!readerReleased) {
        readerReleased = true;
        reader.releaseLock();
      }
    };
    return {
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          this.recordMessage(state, "client->agent", message);
          try {
            await writer.write(message);
          } catch (error) {
            clearTraceState(state);
            throw error;
          }
        },
        close: async () => {
          clearTraceState(state);
          try {
            await writer.close();
          } finally {
            releaseWriter();
          }
        },
        abort: async (reason) => {
          clearTraceState(state);
          try {
            await writer.abort(reason);
          } finally {
            releaseWriter();
          }
        },
      }),
      readable: new ReadableStream<AnyMessage>({
        pull: async (controller) => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTraceState(state);
              controller.close();
              releaseReader();
              return;
            }
            this.recordMessage(state, "agent->client", value);
            controller.enqueue(value);
          } catch (error) {
            clearTraceState(state);
            controller.error(error);
            releaseReader();
          }
        },
        cancel: async (reason) => {
          clearTraceState(state);
          try {
            await reader.cancel(reason);
          } finally {
            releaseReader();
          }
        },
      }),
    };
  }

  private recordMessage(
    state: TraceState,
    direction: ACPDiagnosticsDirection,
    message: AnyMessage
  ): void {
    if (!this.isEnabled()) {
      clearTraceState(state);
      return;
    }
    if (isCall(message)) {
      this.recordCall(state, direction, message);
      return;
    }
    this.recordResponse(state, direction, message);
  }

  private recordCall(
    state: TraceState,
    direction: ACPDiagnosticsDirection,
    message: Extract<AnyMessage, { method: string }>
  ): void {
    const method =
      typeof message.method === "string" &&
      Object.prototype.hasOwnProperty.call(KNOWN_METHODS, message.method)
        ? message.method
        : "unknown";
    if (hasRequestId(message)) {
      const requestId = boundedRequestId(message.id);
      if (requestId === undefined) {
        this.write(
          direction,
          method,
          null,
          0,
          "unmatched",
          requestMetadata(method, message.params)
        );
        return;
      }
      const pending = {
        correlation: `rpc-${++this.nextCorrelation}`,
        method,
        startedAt: this.now(),
      };
      const requests =
        direction === "client->agent"
          ? state.clientRequests
          : state.agentRequests;
      if (requests.size >= MAX_PENDING_REQUESTS) {
        requests.delete(requests.keys().next().value as BoundedRequestId);
      }
      requests.set(requestId, pending);
      this.write(
        direction,
        method,
        pending.correlation,
        0,
        "pending",
        requestMetadata(method, message.params)
      );
      return;
    }

    this.write(
      direction,
      method,
      null,
      0,
      direction === "client->agent" ? "sent" : "received",
      requestMetadata(method, message.params)
    );
  }

  private recordResponse(
    state: TraceState,
    direction: ACPDiagnosticsDirection,
    message: Exclude<AnyMessage, { method: string }>
  ): void {
    const requests =
      direction === "agent->client"
        ? state.clientRequests
        : state.agentRequests;
    const requestId = boundedRequestId(message.id);
    if (requestId === undefined) {
      this.write(direction, "unknown", null, 0, "unmatched", {});
      return;
    }
    const pending = requests.get(requestId);
    if (!pending) {
      this.write(direction, "unknown", null, 0, "unmatched", {});
      return;
    }
    requests.delete(requestId);
    let code: number | undefined;
    if (isErrorResponse(message)) {
      const error = asRecord(message.error);
      code = typeof error?.code === "number" ? error.code : 0;
    }
    const outcome: DiagnosticOutcome =
      code === -32800 ? "cancelled" : code === undefined ? "ok" : "error";
    const metadata =
      code === undefined && "result" in message
        ? responseMetadata(pending.method, message.result)
        : code === undefined
          ? {}
          : { errorCode: code };
    this.write(
      direction,
      pending.method,
      pending.correlation,
      Math.min(
        Math.max(0, Math.round(this.now() - pending.startedAt)),
        MAX_DURATION_MS
      ),
      outcome,
      metadata
    );
  }

  private write(
    direction: ACPDiagnosticsDirection,
    method: string,
    correlation: string | null,
    durationMs: number,
    outcome: DiagnosticOutcome,
    metadata: StructuralMetadata
  ): void {
    this.sink.appendLine(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        direction,
        method,
        correlation,
        durationMs,
        outcome,
        metadata,
      })
    );
  }
}
