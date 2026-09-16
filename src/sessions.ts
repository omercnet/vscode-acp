import { isAbsolute } from "path";
import type { Memento } from "vscode";

export const SESSION_HISTORY_KEY = "vscode-acp.sessionHistory";
export const DEFAULT_SESSION_HISTORY_LIMIT = 50;
export const MAX_AGENT_SESSION_PAGE_ENTRIES = 200;
export const MAX_AGENT_SESSION_TOTAL_ENTRIES = 1000;
export const MAX_AGENT_SESSION_PAGE_METADATA_BYTES = 1_048_576;
export const MAX_AGENT_SESSION_TOTAL_METADATA_BYTES = 4_194_304;
export const MAX_AGENT_SESSION_TOTAL_PAGES = 100;
const MAX_SESSION_ID_LENGTH = 4096;
const MAX_SESSION_PATH_LENGTH = 32_768;
const MAX_SESSION_TITLE_LENGTH = 200;
const MAX_SESSION_TITLE_INPUT_LENGTH = 4096;
const MAX_SESSION_TIMESTAMP_LENGTH = 128;
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
  additionalDirectories: string[];
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
    const additionalDirectories = session.additionalDirectories ?? [];
    if (
      !Array.isArray(additionalDirectories) ||
      additionalDirectories.length > MAX_ADDITIONAL_DIRECTORIES ||
      !additionalDirectories.every(isSafeSessionPath)
    ) {
      throw new Error("Agent returned invalid session directories");
    }
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
    for (const directory of additionalDirectories) {
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
      additionalDirectories: [...additionalDirectories],
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
  const now = Date.now();
  const authoritative = listed.map((session) => {
    const saved = existing.get(session.sessionId);
    const listedTime = session.updatedAt
      ? Date.parse(session.updatedAt)
      : saved?.lastUsedAt ?? now;
    return {
      sessionId: session.sessionId,
      agentId,
      cwd: session.cwd,
      ...(saved?.configurationResource && saved.cwd === session.cwd
        ? { configurationResource: saved.configurationResource }
        : {}),
      ...(session.additionalDirectories.length > 0
        ? { additionalDirectories: [...session.additionalDirectories] }
        : {}),
      createdAt: saved?.createdAt ?? listedTime,
      lastUsedAt: listedTime,
      preview: session.title || saved?.preview || "",
      messageCount: saved?.messageCount ?? 0,
    } satisfies StoredSession;
  });

  return [
    ...history.filter((session) => session.agentId !== agentId),
    ...authoritative,
  ]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, Math.max(1, Math.floor(limit)));
}
