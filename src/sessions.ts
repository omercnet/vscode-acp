import { isAbsolute } from "path";
import type { Memento } from "vscode";

export const SESSION_HISTORY_KEY = "vscode-acp.sessionHistory";
export const DEFAULT_SESSION_HISTORY_LIMIT = 50;
export const MAX_AGENT_SESSION_PAGE_ENTRIES = 200;
export const MAX_AGENT_SESSION_TOTAL_ENTRIES = 1000;
export const MAX_AGENT_SESSION_PAGE_METADATA_BYTES = 1_048_576;
export const MAX_AGENT_SESSION_PAGE_WIRE_BYTES = 1_048_576;
export const MAX_AGENT_SESSION_TOTAL_METADATA_BYTES = 4_194_304;
export const MAX_AGENT_SESSION_TOTAL_PAGES = 100;
const MAX_SESSION_ID_LENGTH = 4096;
const MAX_SESSION_PATH_LENGTH = 32_768;
const MAX_SESSION_TITLE_LENGTH = 200;
const MAX_SESSION_TITLE_INPUT_LENGTH = 4096;
const MAX_SESSION_TIMESTAMP_LENGTH = 128;
const MAX_AGENT_SESSION_PAGE_JSON_NODES = 20_000;
const MAX_ADDITIONAL_DIRECTORIES = 32;
const UNSAFE_SESSION_TEXT =
  /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const UNSAFE_SESSION_TEXT_GLOBAL =
  /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;
export class SessionDiscoveryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionDiscoveryLimitError";
  }
}


export interface StoredSession {
  sessionId: string;
  agentId: string;
  cwd: string;
  configurationResource?: string;
  additionalDirectories?: string[];
  createdAt: number;
  lastUsedAt: number;
  preview: string;
  messageCount: number;
}

export interface AgentOwnedSession {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  title: string;
  updatedAt?: string;
}

export interface AgentSessionPage {
  sessions: AgentOwnedSession[];
  nextCursor: string | null;
  metadataBytes: number;
}

function isSafeSessionPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_PATH_LENGTH &&
    isAbsolute(value) &&
    !UNSAFE_SESSION_TEXT.test(value)
  );
}

function sanitizeTitle(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(UNSAFE_SESSION_TEXT_GLOBAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SESSION_TITLE_LENGTH);
}

/** Unknown future fields are ignored only after their complete JSON cost is bounded. */
function assertBoundedSessionPagePayload(value: unknown): void {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (
      nodes > MAX_AGENT_SESSION_PAGE_JSON_NODES ||
      depth > 16
    ) {
      throw new SessionDiscoveryLimitError(
        "Agent session listing exceeded the safe wire limit. Reduce the agent's stored sessions, then retry."
      );
    }
    if (entry === null) {
      bytes += 4;
    } else if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry, "utf8") + 2;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      bytes += String(entry).length;
    } else if (typeof entry === "object") {
      if (ancestors.has(entry)) {
        throw new Error("Agent returned an invalid session page");
      }
      ancestors.add(entry);
      if (Array.isArray(entry)) {
        for (const item of entry) {
          visit(item, depth + 1);
        }
      } else {
        for (const key in entry) {
          if (Object.prototype.hasOwnProperty.call(entry, key)) {
            bytes += Buffer.byteLength(key, "utf8") + 2;
            visit((entry as Record<string, unknown>)[key], depth + 1);
          }
        }
      }
      ancestors.delete(entry);
    } else {
      throw new Error("Agent returned an invalid session page");
    }
    if (bytes > MAX_AGENT_SESSION_PAGE_WIRE_BYTES) {
      throw new SessionDiscoveryLimitError(
        "Agent session listing exceeded the safe wire limit. Reduce the agent's stored sessions, then retry."
      );
    }
  };
  visit(value, 0);
}

export function normalizeAgentSessionPage(value: unknown): AgentSessionPage {
  if (typeof value !== "object" || value === null) {
    throw new Error("Agent returned an invalid session page");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.sessions)) {
    throw new Error("Agent returned an invalid session page");
  }
  if (candidate.sessions.length > MAX_AGENT_SESSION_PAGE_ENTRIES) {
    throw new SessionDiscoveryLimitError(
      `Agent session listing exceeded the safe page limit of ${MAX_AGENT_SESSION_PAGE_ENTRIES} entries. Reduce the agent's stored sessions, then retry.`
    );
  }
  assertBoundedSessionPagePayload(value);
  const nextCursor = candidate.nextCursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    (typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      nextCursor.length > MAX_SESSION_ID_LENGTH ||
      UNSAFE_SESSION_TEXT.test(nextCursor))
  ) {
    throw new Error("Agent returned an invalid pagination cursor");
  }
  let metadataBytes =
    typeof nextCursor === "string" ? Buffer.byteLength(nextCursor, "utf8") : 0;

  const sessions = candidate.sessions.map((value): AgentOwnedSession => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Agent returned invalid session metadata");
    }
    const session = value as Record<string, unknown>;
    if (
      typeof session.sessionId !== "string" ||
      session.sessionId.length === 0 ||
      session.sessionId.length > MAX_SESSION_ID_LENGTH ||
      UNSAFE_SESSION_TEXT.test(session.sessionId) ||
      !isSafeSessionPath(session.cwd)
    ) {
      throw new Error("Agent returned invalid session metadata");
    }
    const rawAdditionalDirectories = session.additionalDirectories;
    if (
      rawAdditionalDirectories !== undefined &&
      rawAdditionalDirectories !== null &&
      (!Array.isArray(rawAdditionalDirectories) ||
        rawAdditionalDirectories.length > MAX_ADDITIONAL_DIRECTORIES ||
        !rawAdditionalDirectories.every(isSafeSessionPath))
    ) {
      throw new Error("Agent returned invalid session directories");
    }
    const additionalDirectories = Array.isArray(rawAdditionalDirectories)
      ? [...rawAdditionalDirectories]
      : undefined;
    const title = session.title;
    if (
      title !== undefined &&
      title !== null &&
      (typeof title !== "string" ||
        title.length > MAX_SESSION_TITLE_INPUT_LENGTH)
    ) {
      throw new Error("Agent returned invalid session metadata");
    }
    const updatedAt = session.updatedAt;
    if (
      updatedAt !== undefined &&
      updatedAt !== null &&
      (typeof updatedAt !== "string" ||
        updatedAt.length > MAX_SESSION_TIMESTAMP_LENGTH ||
        Number.isNaN(Date.parse(updatedAt)))
    ) {
      throw new Error("Agent returned an invalid session timestamp");
    }
    const normalizedTitle = sanitizeTitle(title);
    metadataBytes +=
      Buffer.byteLength(session.sessionId, "utf8") +
      Buffer.byteLength(session.cwd, "utf8") +
      Buffer.byteLength(normalizedTitle, "utf8") +
      (typeof updatedAt === "string"
        ? Buffer.byteLength(updatedAt, "utf8")
        : 0);
    for (const directory of additionalDirectories ?? []) {
      metadataBytes += Buffer.byteLength(directory, "utf8");
    }
    if (metadataBytes > MAX_AGENT_SESSION_PAGE_METADATA_BYTES) {
      throw new SessionDiscoveryLimitError(
        `Agent session listing exceeded the safe page limit of ${MAX_AGENT_SESSION_PAGE_METADATA_BYTES} metadata bytes. Reduce the agent's stored sessions, then retry.`
      );
    }
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      ...(additionalDirectories !== undefined
        ? { additionalDirectories }
        : {}),
      title: normalizedTitle,
      ...(typeof updatedAt === "string" ? { updatedAt } : {}),
    };
  });

  return {
    sessions,
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
    metadataBytes,
  };
}

export function readStoredSessions(workspaceState: Memento): StoredSession[] {
  const value = workspaceState.get<unknown>(SESSION_HISTORY_KEY);
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((session): session is StoredSession => {
    if (typeof session !== "object" || session === null) {
      return false;
    }
    const candidate = session as Record<string, unknown>;
    return (
      typeof candidate.sessionId === "string" &&
      typeof candidate.agentId === "string" &&
      typeof candidate.cwd === "string" &&
      (candidate.configurationResource === undefined ||
        typeof candidate.configurationResource === "string") &&
      (candidate.additionalDirectories === undefined ||
        (Array.isArray(candidate.additionalDirectories) &&
          candidate.additionalDirectories.every(
            (directory) => typeof directory === "string"
          ))) &&
      typeof candidate.createdAt === "number" &&
      typeof candidate.lastUsedAt === "number" &&
      typeof candidate.preview === "string" &&
      typeof candidate.messageCount === "number"
    );
  });
}

export type StoredSessionMutation = (
  current: readonly StoredSession[]
) => StoredSession[] | null;

const sessionHistoryUpdates = new WeakMap<Memento, Promise<unknown>>();
const sessionHistoryListeners = new WeakMap<Memento, Set<() => void>>();

export function onStoredSessionsChanged(
  workspaceState: Memento,
  listener: () => void
): () => void {
  let listeners = sessionHistoryListeners.get(workspaceState);
  if (!listeners) {
    listeners = new Set();
    sessionHistoryListeners.set(workspaceState, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      sessionHistoryListeners.delete(workspaceState);
    }
  };
}

export async function updateStoredSessions(
  workspaceState: Memento,
  mutate: StoredSessionMutation
): Promise<boolean> {
  const previous = sessionHistoryUpdates.get(workspaceState) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(async () => {
    const updated = mutate(readStoredSessions(workspaceState));
    if (updated === null) {
      return false;
    }
    await workspaceState.update(SESSION_HISTORY_KEY, updated);
    for (const listener of sessionHistoryListeners.get(workspaceState) ?? []) {
      try {
        listener();
      } catch {
        console.error("[Sessions] History listener failed");
      }
    }
    return true;
  });
  sessionHistoryUpdates.set(workspaceState, queued);
  try {
    return await queued;
  } finally {
    if (sessionHistoryUpdates.get(workspaceState) === queued) {
      sessionHistoryUpdates.delete(workspaceState);
    }
  }
}

export function mergeAgentOwnedSession(
  agentId: string,
  listed: AgentOwnedSession,
  saved: StoredSession | undefined
): StoredSession {
  const listedTime = listed.updatedAt
    ? Date.parse(listed.updatedAt)
    : saved?.lastUsedAt ?? 0;
  const sameCwd = saved?.cwd === listed.cwd;
  const additionalDirectories =
    listed.additionalDirectories !== undefined
      ? listed.additionalDirectories
      : sameCwd
        ? saved?.additionalDirectories
        : undefined;
  return {
    sessionId: listed.sessionId,
    agentId,
    cwd: listed.cwd,
    ...(saved?.configurationResource && sameCwd
      ? { configurationResource: saved.configurationResource }
      : {}),
    ...(additionalDirectories?.length
      ? { additionalDirectories: [...additionalDirectories] }
      : {}),
    createdAt: saved?.createdAt ?? listedTime,
    lastUsedAt: Math.max(saved?.lastUsedAt ?? listedTime, listedTime),
    preview: listed.title || saved?.preview || "",
    messageCount: saved?.messageCount ?? 0,
  };
}

export function reconcileAgentSessions(
  history: readonly StoredSession[],
  agentId: string,
  listed: readonly AgentOwnedSession[],
  limit: number
): StoredSession[] {
  const existing = new Map(
    history
      .filter((session) => session.agentId === agentId)
      .map((session) => [session.sessionId, session] as const)
  );
  const authoritative = listed.map((session) =>
    mergeAgentOwnedSession(
      agentId,
      session,
      existing.get(session.sessionId)
    )
  );

  return [
    ...history.filter((session) => session.agentId !== agentId),
    ...authoritative,
  ]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, Math.max(1, Math.floor(limit)));
}
