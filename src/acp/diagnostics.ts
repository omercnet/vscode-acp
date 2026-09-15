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

function isRequest(
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
          typeof updateType === "string" && SESSION_UPDATE_KINDS[updateType]
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
  private readonly clientRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly agentRequests = new Map<JsonRpcId, PendingRequest>();
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
    if (!this.isEnabled()) {
      this.clientRequests.clear();
      this.agentRequests.clear();
      return;
    }

    if (isCall(message)) {
      this.recordCall(direction, message);
      return;
    }
    this.recordResponse(direction, message);
  }

  wrap(stream: Stream): Stream {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    return {
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          this.record("client->agent", message);
          await writer.write(message);
        },
        close: async () => {
          try {
            await writer.close();
          } finally {
            writer.releaseLock();
          }
        },
        abort: async (reason) => {
          try {
            await writer.abort(reason);
          } finally {
            writer.releaseLock();
          }
        },
      }),
      readable: new ReadableStream<AnyMessage>({
        pull: async (controller) => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            this.record("agent->client", value);
            controller.enqueue(value);
          } catch (error) {
            controller.error(error);
            reader.releaseLock();
          }
        },
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
      }),
    };
  }

  private recordCall(
    direction: ACPDiagnosticsDirection,
    message: Extract<AnyMessage, { method: string }>
  ): void {
    const method =
      typeof message.method === "string" && KNOWN_METHODS[message.method]
        ? message.method
        : "unknown";
    if (isRequest(message)) {
      const pending = {
        correlation: `rpc-${++this.nextCorrelation}`,
        method,
        startedAt: this.now(),
      };
      const requests =
        direction === "client->agent"
          ? this.clientRequests
          : this.agentRequests;
      if (requests.size >= MAX_PENDING_REQUESTS) {
        requests.delete(requests.keys().next().value as JsonRpcId);
      }
      requests.set(message.id, pending);
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
    direction: ACPDiagnosticsDirection,
    message: Exclude<AnyMessage, { method: string }>
  ): void {
    const requests =
      direction === "agent->client" ? this.clientRequests : this.agentRequests;
    const pending = requests.get(message.id);
    if (!pending) {
      this.write(direction, "unknown", null, 0, "unmatched", {});
      return;
    }
    requests.delete(message.id);
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
