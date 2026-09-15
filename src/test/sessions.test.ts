import * as assert from "assert";
import * as vscode from "vscode";
import { RequestError, type AuthMethod } from "@agentclientprotocol/sdk";
import type { AgentDiscoveryOptions } from "../acp/agents";
import type {
  ACPConnectionState,
  ACPSessionCapabilities,
} from "../acp/client";
import {
  AgentSessionTreeProvider,
  type AgentSessionOpenRequest,
  type AgentSessionTreeNode,
  type SessionNode,
  type SessionProbe,
} from "../views/sessions";
import {
  SESSION_HISTORY_KEY,
  readStoredSessions,
  type StoredSession,
} from "../sessions";

class TestMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key)
      ? (this.values.get(key) as T)
      : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class TestProbe implements SessionProbe {
  private state: ACPConnectionState = "disconnected";
  private listeners = new Set<(state: ACPConnectionState) => void>();
  readonly requests: Array<{ cursor?: string | null }> = [];
  authenticationMethods: readonly AuthMethod[] = [];
  connectionGeneration = 1;

  constructor(
    readonly capabilities: ACPSessionCapabilities,
    private readonly pages: Array<unknown | Error>
  ) {}

  async connect(): Promise<void> {
    this.state = "connecting";
    this.emitState();
    this.state = "connected";
    this.emitState();
  }

  dispose(): void {
    this.state = "disconnected";
    this.emitState();
  }

  getState(): ACPConnectionState {
    return this.state;
  }

  getSessionCapabilities(): ACPSessionCapabilities {
    return { ...this.capabilities };
  }

  getAuthenticationMethods(): readonly AuthMethod[] {
    return this.authenticationMethods;
  }

  getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  async authenticate(
    _methodId: string,
    _selectedGeneration: number
  ): Promise<void> {}

  async listSessions(params: {
    cursor?: string | null;
  }): Promise<unknown> {
    this.requests.push(params);
    const page = this.pages.shift();
    if (page instanceof Error) {
      throw page;
    }
    return page ?? { sessions: [] };
  }

  setFileSystemCapabilities(): void {}

  setOnStateChange(
    callback: (state: ACPConnectionState) => void
  ): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emitState(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

const LISTING_CAPABILITIES: ACPSessionCapabilities = {
  load: true,
  list: true,
  resume: true,
  additionalDirectories: true,
};

const FALLBACK_CAPABILITIES: ACPSessionCapabilities = {
  load: false,
  list: false,
  resume: true,
  additionalDirectories: false,
};

function discoveryOptions(): AgentDiscoveryOptions {
  return {
    agentPaths: { opencode: "/test/bin/opencode" },
    platform: "linux",
    env: { PATH: "" },
    fileSystem: {
      isFile: (path) => path === "/test/bin/opencode",
      isExecutable: (path) => path === "/test/bin/opencode",
      readText: () => undefined,
      realpath: (path) => path,
    },
  };
}

async function expandOpenCode(
  provider: AgentSessionTreeProvider
): Promise<AgentSessionTreeNode> {
  const agent = provider
    .getChildren()
    .find(
      (node) => node.kind === "agent" && node.agent.id === "opencode"
    );
  assert.ok(agent);
  assert.strictEqual(provider.getChildren(agent)[0]?.kind, "state");
  await new Promise<void>((resolve) => setImmediate(resolve));
  return agent;
}

function storedSession(
  sessionId: string,
  agentId = "opencode"
): StoredSession {
  return {
    sessionId,
    agentId,
    cwd: "/workspace",
    createdAt: 1,
    lastUsedAt: 1,
    preview: `${sessionId} preview`,
    messageCount: 1,
  };
}

suite("Agent session tree", () => {
  test("paginates agent-owned sessions before authoritative reconciliation", async () => {
    const workspaceState = new TestMemento();
    await workspaceState.update(SESSION_HISTORY_KEY, [
      storedSession("recoverable-local"),
      storedSession("other-agent-session", "other-agent"),
    ]);
    const probe = new TestProbe(LISTING_CAPABILITIES, [
      {
        sessions: [
          {
            sessionId: "listed-1",
            cwd: "/workspace",
            title: "Listed one",
            updatedAt: "2026-09-15T10:00:00.000Z",
          },
        ],
        nextCursor: "next-page",
      },
      {
        sessions: [
          {
            sessionId: "listed-2",
            cwd: "/workspace",
            additionalDirectories: ["/shared"],
            title: "Listed two",
            updatedAt: "2026-09-15T11:00:00.000Z",
          },
        ],
      },
    ]);
    const opened: AgentSessionOpenRequest[] = [];
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async (request) => {
        opened.push(request);
      },
      () => probe
    );

    try {
      const agent = await expandOpenCode(provider);
      assert.strictEqual(
        provider.getTreeItem(agent).description,
        "Connected"
      );
      const firstPage = provider.getChildren(agent);
      assert.deepStrictEqual(
        firstPage.map((node) => node.kind),
        ["session", "state"]
      );
      assert.deepStrictEqual(
        readStoredSessions(workspaceState).map((session) => session.sessionId),
        ["recoverable-local", "other-agent-session"]
      );
      assert.deepStrictEqual(opened, []);

      await provider.loadMore("opencode");
      assert.deepStrictEqual(probe.requests, [{}, { cursor: "next-page" }]);
      const completed = provider.getChildren(agent);
      assert.deepStrictEqual(
        completed.map((node) =>
          node.kind === "session"
            ? node.session.sessionId
            : node.kind === "state"
              ? node.state
              : node.agent.id
        ),
        ["listed-1", "listed-2"]
      );
      assert.deepStrictEqual(
        readStoredSessions(workspaceState).map((session) => session.sessionId),
        ["listed-2", "listed-1", "other-agent-session"]
      );
    } finally {
      provider.dispose();
    }
  });

  test("keeps recoverable history and loaded pages after a later page fails", async () => {
    const workspaceState = new TestMemento();
    await workspaceState.update(SESSION_HISTORY_KEY, [
      storedSession("recoverable-local"),
    ]);
    const probe = new TestProbe(LISTING_CAPABILITIES, [
      {
        sessions: [
          {
            sessionId: "listed-1",
            cwd: "/workspace",
            title: "Listed one",
          },
        ],
        nextCursor: "next-page",
      },
      new Error("temporary listing failure"),
    ]);
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async () => {},
      () => probe
    );

    try {
      const agent = await expandOpenCode(provider);
      await provider.loadMore("opencode");

      assert.deepStrictEqual(
        provider.getChildren(agent).map((node) =>
          node.kind === "session"
            ? node.session.sessionId
            : node.kind === "state"
              ? node.state
              : node.agent.id
        ),
        ["listed-1", "error", "load-more"]
      );
      assert.deepStrictEqual(
        readStoredSessions(workspaceState).map((session) => session.sessionId),
        ["recoverable-local"]
      );
    } finally {
      provider.dispose();
    }
  });

  test("uses workspace history when listing is not advertised", async () => {
    const workspaceState = new TestMemento();
    await workspaceState.update(SESSION_HISTORY_KEY, [
      storedSession("local-session"),
    ]);
    const probe = new TestProbe(FALLBACK_CAPABILITIES, []);
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async () => {},
      () => probe
    );

    try {
      const agent = await expandOpenCode(provider);
      const children = provider.getChildren(agent);
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0].kind, "session");
      assert.strictEqual(
        provider.getTreeItem(children[0]).contextValue,
        "vscode-acp.session.resume"
      );
      assert.deepStrictEqual(probe.requests, []);
    } finally {
      provider.dispose();
    }
  });

  test("renders empty, unsupported, authentication, and error states", async () => {
    const cases: Array<{
      capabilities: ACPSessionCapabilities;
      page?: unknown | Error;
      expected: string;
    }> = [
      {
        capabilities: LISTING_CAPABILITIES,
        page: { sessions: [] },
        expected: "empty",
      },
      {
        capabilities: {
          load: false,
          list: false,
          resume: false,
          additionalDirectories: false,
        },
        expected: "unsupported",
      },
      {
        capabilities: LISTING_CAPABILITIES,
        page: RequestError.authRequired(),
        expected: "authentication",
      },
      {
        capabilities: LISTING_CAPABILITIES,
        page: new Error("agent unavailable"),
        expected: "error",
      },
    ];
    for (const entry of cases) {
      const provider = new AgentSessionTreeProvider(
        new TestMemento(),
        discoveryOptions,
        async () => {},
        () =>
          new TestProbe(
            entry.capabilities,
            entry.page === undefined ? [] : [entry.page]
          )
      );
      try {
        const agent = await expandOpenCode(provider);
        const children = provider.getChildren(agent);
        assert.strictEqual(children.length, 1);
        assert.strictEqual(children[0].kind, "state");
        if (children[0].kind === "state") {
          assert.strictEqual(children[0].state, entry.expected);
        }
      } finally {
        provider.dispose();
      }
    }
  });

  test("opens with the selected strategy and marks missing sessions stale", async () => {
    const workspaceState = new TestMemento();
    const requests: AgentSessionOpenRequest[] = [];
    let fail = false;
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async (request) => {
        requests.push(request);
        if (fail) {
          throw RequestError.resourceNotFound(request.sessionId);
        }
      },
      () =>
        new TestProbe(LISTING_CAPABILITIES, [
          {
            sessions: [
              {
                sessionId: "listed-session",
                cwd: "/workspace",
                title: "Listed session",
              },
            ],
          },
        ])
    );

    try {
      const agent = await expandOpenCode(provider);
      const node = provider
        .getChildren(agent)
        .find((candidate): candidate is SessionNode =>
          candidate.kind === "session"
        );
      assert.ok(node);
      await provider.openSession(node, "resume");
      assert.strictEqual(requests[0].mode, "resume");
      assert.strictEqual(requests[0].preview, "Listed session");
      fail = true;
      await provider.openSession(node, "load");
      assert.strictEqual(
        provider.getTreeItem(node).description,
        "Stale session"
      );
    } finally {
      provider.dispose();
    }
  });
});
