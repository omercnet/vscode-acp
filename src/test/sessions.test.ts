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
  normalizeAgentSessionPage,
  reconcileAgentSessions,
  updateStoredSessions,
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

  failConnection(): void {
    this.state = "error";
    this.emitState();
  }

  disconnect(): void {
    this.state = "disconnected";
    this.emitState();
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
        return true;
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

  test("keeps Load More actionable after an empty intermediate page", async () => {
    const probe = new TestProbe(LISTING_CAPABILITIES, [
      { sessions: [], nextCursor: "next-page" },
      {
        sessions: [
          {
            sessionId: "listed-after-empty",
            cwd: "/workspace",
            title: "Listed after empty page",
          },
        ],
      },
    ]);
    const provider = new AgentSessionTreeProvider(
      new TestMemento(),
      discoveryOptions,
      async () => true,
      () => probe
    );

    try {
      const agent = await expandOpenCode(provider);
      const firstPage = provider.getChildren(agent);
      assert.deepStrictEqual(
        firstPage.map((node) => (node.kind === "state" ? node.state : node.kind)),
        ["load-more"]
      );

      await provider.loadMore("opencode");

      const completed = provider.getChildren(agent);
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0].kind, "session");
      if (completed[0].kind === "session") {
        assert.strictEqual(completed[0].session.sessionId, "listed-after-empty");
      }
    } finally {
      provider.dispose();
    }
  });

  test("does not reconcile discovered sessions while auto-save is disabled", async () => {
    const workspaceState = new TestMemento();
    const local = storedSession("recoverable-local");
    await workspaceState.update(SESSION_HISTORY_KEY, [local]);
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async () => true,
      () =>
        new TestProbe(LISTING_CAPABILITIES, [
          {
            sessions: [
              {
                sessionId: "agent-owned",
                cwd: "/workspace",
                title: "Agent owned",
              },
            ],
          },
        ]),
      () => false
    );

    try {
      const agent = await expandOpenCode(provider);
      assert.ok(
        provider
          .getChildren(agent)
          .some(
            (node) =>
              node.kind === "session" &&
              node.session.sessionId === "agent-owned"
          )
      );
      assert.deepStrictEqual(readStoredSessions(workspaceState), [local]);
    } finally {
      provider.dispose();
    }
  });

  test("fails closed on oversized pages and accumulated session metadata", async () => {
    const session = (sessionId: string) => ({
      sessionId,
      cwd: "/workspace",
      title: sessionId,
    });
    assert.throws(
      () =>
        normalizeAgentSessionPage({
          sessions: Array.from({ length: 201 }, (_, index) =>
            session(`oversized-page-${index}`)
          ),
        }),
      /safe page limit/
    );
    const longPath = `/${"a".repeat(32_760)}`;
    assert.throws(
      () =>
        normalizeAgentSessionPage({
          sessions: [
            {
              ...session("oversized-bytes"),
              cwd: longPath,
              additionalDirectories: Array(32).fill(longPath),
            },
          ],
        }),
      /safe wire limit/
    );
    assert.throws(
      () =>
        normalizeAgentSessionPage({
          sessions: [session("bounded-session")],
          futureField: "x".repeat(1_100_000),
        }),
      /safe wire limit/
    );

    const pages = Array.from({ length: 6 }, (_, pageIndex) => ({
      sessions: Array.from(
        { length: pageIndex < 5 ? 200 : 1 },
        (_, sessionIndex) =>
          session(`page-${pageIndex}-session-${sessionIndex}`)
      ),
      ...(pageIndex < 5 ? { nextCursor: `page-${pageIndex + 2}` } : {}),
    }));
    const provider = new AgentSessionTreeProvider(
      new TestMemento(),
      discoveryOptions,
      async () => true,
      () => new TestProbe(LISTING_CAPABILITIES, pages)
    );

    try {
      const agent = await expandOpenCode(provider);
      for (let page = 0; page < 5; page++) {
        await provider.loadMore("opencode");
      }
      const children = provider.getChildren(agent);
      assert.strictEqual(
        children.filter((node) => node.kind === "session").length,
        1000
      );
      const states = children.filter(
        (node): node is Extract<AgentSessionTreeNode, { kind: "state" }> =>
          node.kind === "state"
      );
      assert.deepStrictEqual(
        states.map((node) => node.state),
        ["error"]
      );
      assert.match(states[0].message ?? "", /safe accumulated limit/);
      assert.strictEqual(
        provider.getTreeItem(states[0]).command?.command,
        "vscode-acp.sessions.refreshAgent"
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
      async () => true,
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
      async () => true,
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


  test("keeps cached sessions visible when the probe later errors", async () => {
    const probe = new TestProbe(LISTING_CAPABILITIES, [
      {
        sessions: [
          {
            sessionId: "cached-session",
            cwd: "/workspace",
            title: "Cached session",
          },
        ],
        nextCursor: "next-page",
      },
    ]);
    const provider = new AgentSessionTreeProvider(
      new TestMemento(),
      discoveryOptions,
      async () => true,
      () => probe
    );

    try {
      const agent = await expandOpenCode(provider);
      probe.failConnection();
      assert.deepStrictEqual(
        provider.getChildren(agent).map((node) =>
          node.kind === "session"
            ? node.session.sessionId
            : node.kind === "state"
              ? node.state
              : node.agent.id
        ),
        ["cached-session", "error"]
      );
    } finally {
      provider.dispose();
    }
  });


  test("leaves authentication state when its probe disconnects", async () => {
    const probe = new TestProbe(LISTING_CAPABILITIES, [
      RequestError.authRequired(),
    ]);
    const provider = new AgentSessionTreeProvider(
      new TestMemento(),
      discoveryOptions,
      async () => true,
      () => probe
    );

    try {
      const agent = await expandOpenCode(provider);
      assert.strictEqual(
        provider.getTreeItem(agent).description,
        "Authentication required"
      );
      probe.disconnect();
      assert.strictEqual(provider.getTreeItem(agent).description, "Disconnected");
    } finally {
      provider.dispose();
    }
  });
  test("renders list-only sessions as inert tree items", async () => {
    const workspaceState = new TestMemento();
    await workspaceState.update(SESSION_HISTORY_KEY, [
      {
        ...storedSession("read-only-session"),
        additionalDirectories: ["/saved-extra"],
      },
    ]);
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async () => true,
      () =>
        new TestProbe(
          {
            load: false,
            list: true,
            resume: false,
            additionalDirectories: false,
          },
          [
            {
              sessions: [
                {
                  sessionId: "read-only-session",
                  cwd: "/workspace",
                  title: "[Open](command:malicious)",
                },
              ],
            },
          ]
        )
    );

    try {
      const agent = await expandOpenCode(provider);
      const children = provider.getChildren(agent);
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0].kind, "session");
      if (children[0].kind === "session") {
        assert.deepStrictEqual(children[0].session.additionalDirectories, [
          "/saved-extra",
        ]);
      }
      const item = provider.getTreeItem(children[0]);
      assert.strictEqual(item.command, undefined);
      assert.strictEqual(item.contextValue, "vscode-acp.session.unsupported");
      assert.strictEqual(typeof item.tooltip, "string");
      assert.match(String(item.tooltip), /\[Open\]\(command:malicious\)/);
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
        async () => true,
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
    let cancel = false;
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async (request) => {
        requests.push(request);
        if (fail) {
          throw RequestError.resourceNotFound(request.sessionId);
        }
        if (cancel) {
          return false;
        }
        return true;
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

      cancel = true;
      fail = false;
      await provider.openSession(node, "resume");
      let reopened = provider
        .getChildren(agent)
        .find(
          (candidate): candidate is SessionNode =>
            candidate.kind === "session" &&
            candidate.session.sessionId === "listed-session"
        );
      assert.ok(reopened);
      assert.strictEqual(reopened.stale, true);

      cancel = false;
      await provider.openSession(node, "resume");
      reopened = provider
        .getChildren(agent)
        .find(
          (candidate): candidate is SessionNode =>
            candidate.kind === "session" &&
            candidate.session.sessionId === "listed-session"
        );
      assert.ok(reopened);
      assert.strictEqual(reopened.stale, false);
    } finally {
      provider.dispose();
    }
  });

  test("serializes concurrent session history mutations", async () => {
    let releaseFirstWrite!: () => void;
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    class DelayedMemento extends TestMemento {
      private historyWrites = 0;

      async update(key: string, value: unknown): Promise<void> {
        if (key === SESSION_HISTORY_KEY && this.historyWrites++ === 0) {
          markFirstWriteStarted();
          await firstWriteGate;
        }
        await super.update(key, value);
      }
    }
    const workspaceState = new DelayedMemento();
    const first = storedSession("first");
    const second = storedSession("second");

    const firstUpdate = updateStoredSessions(workspaceState, (history) => [
      first,
      ...history,
    ]);
    await firstWriteStarted;
    const secondUpdate = updateStoredSessions(workspaceState, (history) => [
      second,
      ...history,
    ]);
    releaseFirstWrite();
    await Promise.all([firstUpdate, secondUpdate]);

    assert.deepStrictEqual(
      readStoredSessions(workspaceState).map((session) => session.sessionId),
      ["second", "first"]
    );
  });

  test("preserves newer workspace recency during agent reconciliation", () => {
    const saved = {
      ...storedSession("recent"),
      lastUsedAt: 200,
      additionalDirectories: ["/saved-extra"],
    };
    const reconciled = reconcileAgentSessions(
      [saved],
      "opencode",
      [
        {
          sessionId: "recent",
          cwd: "/workspace",
          title: "Agent title",
          updatedAt: new Date(100).toISOString(),
        },
      ],
      50
    );

    assert.strictEqual(reconciled[0].lastUsedAt, 200);
    assert.deepStrictEqual(reconciled[0].additionalDirectories, [
      "/saved-extra",
    ]);
    const limited = reconcileAgentSessions(
      [{ ...storedSession("known-recent", "other-agent"), lastUsedAt: 50 }],
      "opencode",
      [
        {
          sessionId: "unknown-recency",
          cwd: "/workspace",
          title: "Undated agent session",
        },
      ],
      1
    );
    assert.strictEqual(limited[0].sessionId, "known-recent");
    const explicitlyCleared = reconcileAgentSessions(
      [saved],
      "opencode",
      [
        {
          sessionId: "recent",
          cwd: "/workspace",
          additionalDirectories: [],
          title: "Agent title",
        },
      ],
      50
    );
    assert.strictEqual(explicitlyCleared[0].additionalDirectories, undefined);
  });

  test("does not publish an obsolete load after refresh replaces its state", async () => {
    let releaseList!: (value: unknown) => void;
    let markListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listResult = new Promise<unknown>((resolve) => {
      releaseList = resolve;
    });
    class DeferredProbe extends TestProbe {
      async listSessions(params: {
        cursor?: string | null;
      }): Promise<unknown> {
        this.requests.push(params);
        markListStarted();
        return listResult;
      }
    }
    const probe = new DeferredProbe(LISTING_CAPABILITIES, []);
    const provider = new AgentSessionTreeProvider(
      new TestMemento(),
      discoveryOptions,
      async () => true,
      () => probe
    );
    const agent = provider
      .getChildren()
      .find(
        (node) => node.kind === "agent" && node.agent.id === "opencode"
      );
    assert.ok(agent);
    const events: Array<AgentSessionTreeNode | undefined> = [];
    const subscription = provider.onDidChangeTreeData((event) =>
      events.push(event ?? undefined)
    );
    provider.getChildren(agent);
    await listStarted;
    provider.refresh("opencode");
    const eventsAfterRefresh = events.length;

    releaseList({
      sessions: [
        { sessionId: "obsolete", cwd: "/workspace", title: "Obsolete" },
      ],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(events.length, eventsAfterRefresh);
    subscription.dispose();
    provider.dispose();
  });

  test("cancels queued reconciliation after refresh replaces its state", async () => {
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    class BlockingMemento extends TestMemento {
      blockNextHistoryWrite = false;

      async update(key: string, value: unknown): Promise<void> {
        if (key === SESSION_HISTORY_KEY && this.blockNextHistoryWrite) {
          this.blockNextHistoryWrite = false;
          markWriteStarted();
          await writeGate;
        }
        await super.update(key, value);
      }
    }
    const workspaceState = new BlockingMemento();
    await workspaceState.update(SESSION_HISTORY_KEY, [
      storedSession("recoverable-local"),
    ]);
    workspaceState.blockNextHistoryWrite = true;
    const blocker = updateStoredSessions(workspaceState, (history) => [
      ...history,
    ]);
    await writeStarted;
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async () => true,
      () =>
        new TestProbe(LISTING_CAPABILITIES, [
          {
            sessions: [
              {
                sessionId: "obsolete-authoritative",
                cwd: "/workspace",
                title: "Obsolete",
              },
            ],
          },
        ])
    );
    const agent = provider
      .getChildren()
      .find(
        (node) => node.kind === "agent" && node.agent.id === "opencode"
      );
    assert.ok(agent);
    provider.getChildren(agent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    provider.refresh("opencode");

    releaseWrite();
    await blocker;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(
      readStoredSessions(workspaceState).map((session) => session.sessionId),
      ["recoverable-local"]
    );
    provider.dispose();
  });

  test("clones fallback sessions before updating transient tree recency", async () => {
    const workspaceState = new TestMemento();
    const local = storedSession("local-session");
    await workspaceState.update(SESSION_HISTORY_KEY, [local]);
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async () => true,
      () => new TestProbe(FALLBACK_CAPABILITIES, []),
      () => false
    );

    try {
      const agent = await expandOpenCode(provider);
      const node = provider
        .getChildren(agent)
        .find(
          (candidate): candidate is SessionNode => candidate.kind === "session"
        );
      assert.ok(node);
      await provider.openSession(node, "resume");

      assert.strictEqual(local.lastUsedAt, 1);
      assert.strictEqual(readStoredSessions(workspaceState)[0].lastUsedAt, 1);
      assert.ok(node.session.lastUsedAt > 1);
    } finally {
      provider.dispose();
    }
  });


  test("refreshes fallback children after shared history mutations", async () => {
    const workspaceState = new TestMemento();
    await workspaceState.update(SESSION_HISTORY_KEY, [
      storedSession("first-local"),
    ]);
    const provider = new AgentSessionTreeProvider(
      workspaceState,
      discoveryOptions,
      async () => true,
      () => new TestProbe(FALLBACK_CAPABILITIES, [])
    );
    const events: Array<AgentSessionTreeNode | undefined> = [];
    const subscription = provider.onDidChangeTreeData((event) =>
      events.push(event ?? undefined)
    );

    try {
      const agent = await expandOpenCode(provider);
      const eventCount = events.length;
      await updateStoredSessions(workspaceState, (history) => [
        storedSession("second-local"),
        ...history,
      ]);

      assert.ok(events.length > eventCount);
      assert.deepStrictEqual(
        provider.getChildren(agent).map((node) =>
          node.kind === "session" ? node.session.sessionId : node.kind
        ),
        ["second-local", "first-local"]
      );
    } finally {
      subscription.dispose();
      provider.dispose();
    }
  });
  test("keeps valid live sessions visible when reconciliation storage fails", async () => {
    class FailingMemento extends TestMemento {
      async update(key: string, value: unknown): Promise<void> {
        if (key === SESSION_HISTORY_KEY) {
          throw new Error("storage unavailable");
        }
        await super.update(key, value);
      }
    }
    const provider = new AgentSessionTreeProvider(
      new FailingMemento(),
      discoveryOptions,
      async () => true,
      () =>
        new TestProbe(LISTING_CAPABILITIES, [
          {
            sessions: [
              {
                sessionId: "live-session",
                cwd: "/workspace",
                title: "Live session",
              },
            ],
          },
        ])
    );

    try {
      const agent = await expandOpenCode(provider);
      const children = provider.getChildren(agent);
      assert.strictEqual(children.length, 1);
      assert.strictEqual(children[0].kind, "session");
      if (children[0].kind === "session") {
        assert.strictEqual(children[0].session.sessionId, "live-session");
      }
    } finally {
      provider.dispose();
    }
  });
});
