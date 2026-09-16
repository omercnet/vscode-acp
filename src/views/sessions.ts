import * as vscode from "vscode";
import type { AuthMethod, AuthMethodId } from "@agentclientprotocol/sdk";
import {
  ACPClient,
  describeACPError,
  formatACPError,
  isAgentAuthMethod,
  type ACPConnectionState,
  type ACPSessionCapabilities,
} from "../acp/client";
import {
  getAgent,
  getAgentsWithStatus,
  type AgentConfig,
  type AgentDiscoveryOptions,
} from "../acp/agents";
import type { AgentCommandResolutionOptions } from "../acp/agentCommand";
import {
  DEFAULT_SESSION_HISTORY_LIMIT,
  SESSION_HISTORY_KEY,
  MAX_AGENT_SESSION_TOTAL_ENTRIES,
  MAX_AGENT_SESSION_TOTAL_METADATA_BYTES,
  MAX_AGENT_SESSION_TOTAL_PAGES,
  SessionDiscoveryLimitError,
  normalizeAgentSessionPage,
  readStoredSessions,
  reconcileAgentSessions,
  type AgentOwnedSession,
  type StoredSession,
} from "../sessions";

export type SessionOpenMode = "load" | "resume";

export interface AgentSessionOpenRequest {
  agentId: string;
  sessionId: string;
  cwd: string;
  configurationResource?: string;
  additionalDirectories?: string[];
  preview?: string;
  mode: SessionOpenMode;
}

export interface SessionProbe {
  connect(): Promise<unknown>;
  dispose(): void;
  getState(): ACPConnectionState;
  getSessionCapabilities(): ACPSessionCapabilities;
  getAuthenticationMethods(): readonly AuthMethod[];
  getConnectionGeneration(): number;
  authenticate(
    methodId: AuthMethodId,
    selectedGeneration: number
  ): Promise<void>;
  listSessions(params: {
    cursor?: string | null;
  }): Promise<unknown>;
  setFileSystemCapabilities(
    callback: () => Promise<{
      readTextFile: boolean;
      writeTextFile: boolean;
    }>
  ): void;
  setOnStateChange(
    callback: (state: ACPConnectionState) => void
  ): () => void;
}

export type SessionProbeFactory = (
  agent: AgentConfig,
  resolutionOptions: () => AgentCommandResolutionOptions
) => SessionProbe;

type AgentLoadState =
  | "idle"
  | "loading"
  | "connected"
  | "authentication"
  | "error";

interface AgentNode {
  kind: "agent";
  agent: AgentConfig;
  available: boolean;
}

export interface SessionNode {
  kind: "session";
  agentId: string;
  session: StoredSession;
  capabilities: ACPSessionCapabilities;
  stale: boolean;
}

interface StateNode {
  kind: "state";
  agentId: string;
  state:
    | "loading"
    | "empty"
    | "unsupported"
    | "authentication"
    | "error"
    | "load-more";
  message?: string;
}

export type AgentSessionTreeNode = AgentNode | SessionNode | StateNode;

interface AgentState {
  status: AgentLoadState;
  probe: SessionProbe | null;
  disposeStateListener: (() => void) | null;
  capabilities: ACPSessionCapabilities | null;
  sessions: AgentOwnedSession[];
  nextCursor: string | null;
  requestedCursor: string | null;
  error: string | null;
  metadataBytes: number;
  pageCount: number;
  seenCursors: Set<string>;
  staleSessionIds: Set<string>;
}

const EMPTY_CAPABILITIES: ACPSessionCapabilities = {
  load: false,
  list: false,
  resume: false,
  additionalDirectories: false,
};

function escapeQuickPickIcons(value: string): string {
  return value.replace(/\$\(/g, "\\$(");
}

function sessionContextValue(
  capabilities: ACPSessionCapabilities,
  stale: boolean
): string {
  const suffix = stale ? ".stale" : "";
  if (capabilities.load && capabilities.resume) {
    return `vscode-acp.session.load-resume${suffix}`;
  }
  if (capabilities.load) {
    return `vscode-acp.session.load${suffix}`;
  }
  if (capabilities.resume) {
    return `vscode-acp.session.resume${suffix}`;
  }
  return `vscode-acp.session.unsupported${suffix}`;
}

export class AgentSessionTreeProvider
  implements vscode.TreeDataProvider<AgentSessionTreeNode>, vscode.Disposable
{
  public static readonly viewType = "vscode-acp.sessionsView";

  private readonly changes = new vscode.EventEmitter<
    AgentSessionTreeNode | undefined
  >();
  readonly onDidChangeTreeData = this.changes.event;
  private readonly states = new Map<string, AgentState>();
  private disposed = false;
  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly getAgentDiscoveryOptions: () => AgentDiscoveryOptions,
    private readonly openInChat: (
      request: AgentSessionOpenRequest
    ) => Promise<void>,
    private readonly createProbe: SessionProbeFactory = (
      agent,
      resolutionOptions
    ) => {
      const client = new ACPClient({ agentConfig: agent, resolutionOptions });
      client.setFileSystemCapabilities(async () => ({
        readTextFile: false,
        writeTextFile: false,
      }));
      return client;
    },
    private readonly shouldPersistSessions: () => boolean = () =>
      vscode.workspace
        .getConfiguration("vscode-acp")
        .get<boolean>("sessions.autoSave", true)
  ) {}


  getTreeItem(element: AgentSessionTreeNode): vscode.TreeItem {
    if (element.kind === "agent") {
      const state = this.states.get(element.agent.id);
      const status = element.available
        ? state?.status ?? "idle"
        : "unavailable";
      const item = new vscode.TreeItem(
        element.agent.name,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `agent:${element.agent.id}`;
      item.description =
        status === "connected"
          ? "Connected"
          : status === "loading"
            ? "Loading"
            : status === "authentication"
              ? "Authentication required"
              : status === "error"
                ? "Error"
                : status === "unavailable"
                  ? "Unavailable"
                  : "Disconnected";
      item.iconPath = new vscode.ThemeIcon(
        status === "connected"
          ? "plug"
          : status === "loading"
            ? "sync~spin"
            : status === "error" || status === "authentication"
              ? "warning"
              : status === "unavailable"
                ? "debug-disconnect"
                : "circle-outline"
      );
      item.contextValue = "vscode-acp.agent";
      return item;
    }

    if (element.kind === "session") {
      const title = element.session.preview || "Untitled session";
      const item = new vscode.TreeItem(
        title,
        vscode.TreeItemCollapsibleState.None
      );
      item.id = `session:${element.agentId}:${element.session.sessionId}`;
      item.description = element.stale
        ? "Stale session"
        : new Date(element.session.lastUsedAt).toLocaleString();
      item.tooltip = new vscode.MarkdownString(
        `**${title}**\n\n${element.session.cwd}\n\nSession: \`${element.session.sessionId}\``
      );
      item.iconPath = new vscode.ThemeIcon(
        element.stale ? "warning" : "history"
      );
      item.contextValue = sessionContextValue(
        element.capabilities,
        element.stale
      );
      if (element.capabilities.load || element.capabilities.resume) {
        item.command = {
          command: "vscode-acp.sessions.open",
          title: "Open Session",
          arguments: [element],
        };
      }
      return item;
    }

    const labels: Record<StateNode["state"], string> = {
      loading: "Loading sessions…",
      empty: "No sessions found",
      authentication: "Sign in to list sessions",
      error: element.message || "Could not load sessions",
      "load-more": "Load more…",
      unsupported: element.message || "Session browsing is unsupported",
    };
    const item = new vscode.TreeItem(
      labels[element.state],
      vscode.TreeItemCollapsibleState.None
    );
    item.id = `state:${element.agentId}:${element.state}`;
    item.iconPath = new vscode.ThemeIcon(
      element.state === "loading"
        ? "sync~spin"
        : element.state === "error"
          ? "error"
          : element.state === "authentication"
            ? "account"
            : element.state === "load-more"
              ? "ellipsis"
              : "info"
    );
    item.contextValue = `vscode-acp.sessions.${element.state}`;
    if (element.state === "authentication") {
      item.command = {
        command: "vscode-acp.sessions.authenticate",
        title: "Sign In",
        arguments: [element.agentId],
      };
    } else if (element.state === "error") {
      item.command = {
        command: "vscode-acp.sessions.refreshAgent",
        title: "Retry",
        arguments: [element.agentId],
      };
    } else if (element.state === "load-more") {
      item.command = {
        command: "vscode-acp.sessions.loadMore",
        title: "Load More",
        arguments: [element.agentId],
      };
    }
    return item;
  }

  getChildren(element?: AgentSessionTreeNode): AgentSessionTreeNode[] {
    if (!element) {
      return getAgentsWithStatus(this.getAgentDiscoveryOptions()).map(
        (agent) => ({
          kind: "agent",
          agent: {
            id: agent.id,
            name: agent.name,
            command: agent.command,
            args: agent.args,
          },
          available: agent.available,
        })
      );
    }
    if (element.kind !== "agent") {
      return [];
    }
    if (!element.available) {
      return [
        {
          kind: "state",
          agentId: element.agent.id,
          state: "unsupported",
          message: "Agent executable is unavailable",
        },
      ];
    }

    const state = this.getState(element.agent.id);
    if (state.status === "idle") {
      void this.loadPage(element.agent, true);
      return [
        { kind: "state", agentId: element.agent.id, state: "loading" },
      ];
    }
    if (state.status === "loading") {
      return [
        { kind: "state", agentId: element.agent.id, state: "loading" },
      ];
    }
    if (state.status === "authentication") {
      const action: StateNode = {
        kind: "state",
        agentId: element.agent.id,
        state: "authentication",
      };
      if (state.sessions.length === 0 || !state.capabilities) {
        return [action];
      }
      return [
        ...this.listedSessionNodes(
          element.agent.id,
          state.capabilities,
          state
        ),
        action,
      ];
    }
    if (state.status === "error") {
      return [
        {
          kind: "state",
          agentId: element.agent.id,
          state: "error",
          message: state.error ?? undefined,
        },
      ];
    }

    const capabilities = state.capabilities ?? EMPTY_CAPABILITIES;
    if (!capabilities.load && !capabilities.resume) {
      return [
        {
          kind: "state",
          agentId: element.agent.id,
          state: "unsupported",
        },
      ];
    }
    const sessions = capabilities.list
      ? this.listedSessionNodes(element.agent.id, capabilities, state)
      : this.fallbackSessionNodes(element.agent.id, capabilities, state);
    if (sessions.length === 0 && !state.nextCursor) {
      return [
        { kind: "state", agentId: element.agent.id, state: "empty" },
      ];
    }
    return [
      ...sessions,
      ...(state.error
        ? [
            {
              kind: "state" as const,
              agentId: element.agent.id,
              state: "error" as const,
              message: state.error,
            },
          ]
        : []),
      ...(capabilities.list && state.nextCursor
        ? [
            {
              kind: "state" as const,
              agentId: element.agent.id,
              state: "load-more" as const,
            },
          ]
        : []),
    ];
  }

  refresh(agentId?: string): void {
    if (agentId) {
      this.disposeProbe(agentId);
      this.states.delete(agentId);
    } else {
      for (const id of this.states.keys()) {
        this.disposeProbe(id);
      }
      this.states.clear();
    }
    this.changes.fire(undefined);
  }

  async loadMore(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    const agent = getAgent(
      agentId,
      this.getAgentDiscoveryOptions().agentPaths
    );
    if (!state?.nextCursor || !agent || state.status === "loading") {
      return;
    }
    await this.loadPage(agent, false);
  }

  async authenticate(agentId: string): Promise<void> {
    const state = this.states.get(agentId);
    const methods = state?.probe
      ?.getAuthenticationMethods()
      .filter(isAgentAuthMethod);
    if (!state?.probe || !methods || methods.length === 0) {
      vscode.window.showErrorMessage(
        "No supported authentication methods are available for this agent."
      );
      return;
    }
    const selectedGeneration = state.probe.getConnectionGeneration();
    const selection = await vscode.window.showQuickPick(
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
    if (!selection) {
      return;
    }
    try {
      await state.probe.authenticate(
        selection.methodId,
        selectedGeneration
      );
      const agent = getAgent(
        agentId,
        this.getAgentDiscoveryOptions().agentPaths
      );
      if (agent) {
        await this.loadPage(agent, true);
      }
    } catch (error) {
      state.status = "error";
      state.error = formatACPError(error);
      this.changes.fire(undefined);
    }
  }

  async openSession(
    node: SessionNode,
    requestedMode?: SessionOpenMode
  ): Promise<void> {
    const availableModes: SessionOpenMode[] = [];
    if (node.capabilities.load) {
      availableModes.push("load");
    }
    if (node.capabilities.resume) {
      availableModes.push("resume");
    }
    let mode = requestedMode;
    if (!mode && availableModes.length === 1) {
      mode = availableModes[0];
    } else if (!mode && availableModes.length === 2) {
      const selection = await vscode.window.showQuickPick(
        [
          {
            label: "Load conversation history",
            description: "Restore prior messages before continuing",
            mode: "load" as const,
          },
          {
            label: "Resume without history",
            description: "Continue without replaying prior messages",
            mode: "resume" as const,
          },
        ],
        {
          title: "Open agent session",
          placeHolder: "Choose how to open this session",
          ignoreFocusOut: true,
        }
      );
      mode = selection?.mode;
    }
    if (!mode || !availableModes.includes(mode)) {
      return;
    }

    try {
      await this.openInChat({
        agentId: node.agentId,
        sessionId: node.session.sessionId,
        cwd: node.session.cwd,
        configurationResource: node.session.configurationResource,
        additionalDirectories: node.session.additionalDirectories,
        preview: node.session.preview,
        mode,
      });
      node.stale = false;
      node.session.lastUsedAt = Date.now();
      this.changes.fire(node);
    } catch (error) {
      const presentation = describeACPError(error);
      if (
        presentation.kind === "resource-not-found" ||
        /session\s+(?:was\s+)?not\s+found/i.test(presentation.diagnostic)
      ) {
        node.stale = true;
        const state = this.states.get(node.agentId);
        state?.staleSessionIds.add(node.session.sessionId);
        this.changes.fire(node);
      }
      vscode.window.showErrorMessage(
        `Failed to open session: ${formatACPError(error)}`
      );
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const id of this.states.keys()) {
      this.disposeProbe(id);
    }
    this.states.clear();
    this.changes.dispose();
  }

  private getState(agentId: string): AgentState {
    let state = this.states.get(agentId);
    if (!state) {
      state = {
        status: "idle",
        probe: null,
        disposeStateListener: null,
        capabilities: null,
        sessions: [],
        nextCursor: null,
        requestedCursor: null,
        error: null,
        metadataBytes: 0,
        pageCount: 0,
        seenCursors: new Set(),
        staleSessionIds: new Set(),
      };
      this.states.set(agentId, state);
    }
    return state;
  }

  private listedSessionNodes(
    agentId: string,
    capabilities: ACPSessionCapabilities,
    state: AgentState
  ): SessionNode[] {
    const stored = new Map(
      readStoredSessions(this.workspaceState)
        .filter((session) => session.agentId === agentId)
        .map((session) => [session.sessionId, session] as const)
    );
    return state.sessions.map((listed) => {
      const saved = stored.get(listed.sessionId);
      const updatedAt = listed.updatedAt
        ? Date.parse(listed.updatedAt)
        : saved?.lastUsedAt ?? Date.now();
      return {
        kind: "session",
        agentId,
        capabilities,
        stale: state.staleSessionIds.has(listed.sessionId),
        session: {
          sessionId: listed.sessionId,
          agentId,
          cwd: listed.cwd,
          ...(saved?.configurationResource && saved.cwd === listed.cwd
            ? { configurationResource: saved.configurationResource }
            : {}),
          ...(listed.additionalDirectories.length > 0
            ? { additionalDirectories: [...listed.additionalDirectories] }
            : {}),
          createdAt: saved?.createdAt ?? updatedAt,
          lastUsedAt: updatedAt,
          preview: listed.title || saved?.preview || "",
          messageCount: saved?.messageCount ?? 0,
        },
      };
    });
  }

  private fallbackSessionNodes(
    agentId: string,
    capabilities: ACPSessionCapabilities,
    state: AgentState
  ): SessionNode[] {
    return readStoredSessions(this.workspaceState)
      .filter((session) => session.agentId === agentId)
      .map((session) => ({
        kind: "session",
        agentId,
        session,
        capabilities,
        stale: state.staleSessionIds.has(session.sessionId),
      }));
  }

  private async loadPage(agent: AgentConfig, reset: boolean): Promise<void> {
    const state = this.getState(agent.id);
    if (state.status === "loading") {
      return;
    }
    state.status = "loading";
    state.error = null;
    this.changes.fire(undefined);

    try {
      let probe = state.probe;
      if (!probe || probe.getState() !== "connected") {
        this.disposeProbe(agent.id);
        probe = this.createProbe(agent, () =>
          this.getAgentDiscoveryOptions()
        );
        state.probe = probe;
        state.disposeStateListener = probe.setOnStateChange((connectionState) => {
          if (this.disposed || this.states.get(agent.id)?.probe !== probe) {
            return;
          }
          if (connectionState === "error") {
            state.status = "error";
            state.error = "Agent connection failed";
          } else if (
            connectionState === "disconnected" &&
            state.status === "connected"
          ) {
            state.status = "idle";
          }
          this.changes.fire(undefined);
        });
        await probe.connect();
        state.capabilities = probe.getSessionCapabilities();
      }

      const capabilities = state.capabilities ?? EMPTY_CAPABILITIES;
      if (!capabilities.list) {
        state.status = "connected";
        state.sessions = [];
        state.nextCursor = null;
        state.requestedCursor = null;
        this.changes.fire(undefined);
        return;
      }

      const cursor = reset ? null : state.nextCursor;
      if (!reset && !cursor) {
        state.status = "connected";
        this.changes.fire(undefined);
        return;
      }
      state.requestedCursor = cursor;
      const page = normalizeAgentSessionPage(
        await probe.listSessions(cursor ? { cursor } : {})
      );
      const seenCursors = reset
        ? new Set<string>()
        : new Set(state.seenCursors);
      if (page.nextCursor && seenCursors.has(page.nextCursor)) {
        throw new SessionDiscoveryLimitError(
          "Agent session listing repeated a pagination cursor. Refresh the agent after its session listing is corrected."
        );
      }
      const projectedMetadataBytes =
        (reset ? 0 : state.metadataBytes) + page.metadataBytes;
      const projectedPageCount = (reset ? 0 : state.pageCount) + 1;
      if (
        projectedMetadataBytes > MAX_AGENT_SESSION_TOTAL_METADATA_BYTES ||
        projectedPageCount > MAX_AGENT_SESSION_TOTAL_PAGES
      ) {
        throw new SessionDiscoveryLimitError(
          "Agent session listing exceeded the safe accumulated limit. Reduce the agent's stored sessions, then retry."
        );
      }
      const merged = new Map<string, AgentOwnedSession>();
      if (!reset) {
        for (const session of state.sessions) {
          merged.set(session.sessionId, session);
        }
      }
      for (const session of page.sessions) {
        merged.set(session.sessionId, session);
      }
      if (merged.size > MAX_AGENT_SESSION_TOTAL_ENTRIES) {
        throw new SessionDiscoveryLimitError(
          "Agent session listing exceeded the safe accumulated limit. Reduce the agent's stored sessions, then retry."
        );
      }
      if (page.nextCursor) {
        seenCursors.add(page.nextCursor);
      }
      state.sessions = [...merged.values()];
      state.metadataBytes = projectedMetadataBytes;
      state.pageCount = projectedPageCount;
      state.seenCursors = seenCursors;
      state.nextCursor = page.nextCursor;
      state.requestedCursor = null;
      state.status = "connected";
      if (!page.nextCursor && this.shouldPersistSessions()) {
        const configuredLimit = vscode.workspace
          .getConfiguration("vscode-acp")
          .get<number>("sessions.maxHistory", DEFAULT_SESSION_HISTORY_LIMIT);
        const limit = Number.isFinite(configuredLimit)
          ? Math.max(1, Math.min(200, Math.floor(configuredLimit)))
          : DEFAULT_SESSION_HISTORY_LIMIT;
        await this.workspaceState.update(
          SESSION_HISTORY_KEY,
          reconcileAgentSessions(
            readStoredSessions(this.workspaceState),
            agent.id,
            state.sessions,
            limit
          )
        );
      }
      this.changes.fire(undefined);
    } catch (error) {
      const presentation = describeACPError(error);
      if (error instanceof SessionDiscoveryLimitError) {
        state.nextCursor = null;
      }
      const failedLaterPage =
        state.requestedCursor !== null && state.sessions.length > 0;
      state.status =
        presentation.kind === "authentication-required"
          ? "authentication"
          : failedLaterPage
            ? "connected"
            : "error";
      state.error = formatACPError(error);
      state.requestedCursor = null;
      this.changes.fire(undefined);
    }
  }

  private disposeProbe(agentId: string): void {
    const state = this.states.get(agentId);
    state?.disposeStateListener?.();
    state?.probe?.dispose();
    if (state) {
      state.disposeStateListener = null;
      state.probe = null;
    }
  }
}
