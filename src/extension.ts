import * as vscode from "vscode";
import { ACPClient, formatACPError } from "./acp/client";
import { ACPDiagnostics } from "./acp/diagnostics";
import { ChatViewProvider } from "./views/chat";
import type { AgentCommandResolutionOptions } from "./acp/agentCommand";
import { selectAgentPaths } from "./acp/agentPaths";
import {
  AgentSessionTreeProvider,
  type AgentSessionTreeNode,
  type SessionOpenMode,
} from "./views/sessions";

let acpClient: ACPClient | undefined;
let chatProvider: ChatViewProvider | undefined;
let sessionTreeProvider: AgentSessionTreeProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
const CHAT_VIEW_LOCATION_INITIALIZED = "vscode-acp.chatViewSecondarySidebarV1";

type LifecycleCommandProvider = Pick<
  ChatViewProvider,
  "restartAgent" | "disconnectAgent"
>;
type CommandMessage = (message: string) => unknown;

export function createRestartAgentCommand(
  provider: LifecycleCommandProvider | undefined,
  focusChat: () => PromiseLike<unknown>,
  showInformation: CommandMessage,
  showError: CommandMessage
): () => Promise<void> {
  return async () => {
    const restarting = (provider?.restartAgent() ?? Promise.resolve()).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    try {
      await focusChat();
      const result = await restarting;
      if (result.status === "rejected") {
        throw result.error;
      }
      showInformation("ACP agent restarted");
    } catch (error) {
      showError(`Failed to restart agent: ${formatACPError(error)}`);
    }
  };
}

export function createDisconnectAgentCommand(
  provider: LifecycleCommandProvider | undefined,
  showInformation: CommandMessage,
  showError: CommandMessage
): () => Promise<void> {
  return async () => {
    try {
      await provider?.disconnectAgent();
      showInformation("ACP agent disconnected");
    } catch (error) {
      showError(`Failed to disconnect agent: ${formatACPError(error)}`);
    }
  };
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  console.log("VSCode ACP extension is now active");

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.openDevTools", () => {
      vscode.commands.executeCommand(
        "workbench.action.webview.openDeveloperTools"
      );
    })
  );

  const getAgentResolutionOptions = (): AgentCommandResolutionOptions => ({
    excludedDirectories: vscode.workspace.isTrusted
      ? []
      : (vscode.workspace.workspaceFolders ?? [])
          .map((folder) => folder.uri.fsPath)
          .filter((path) => path !== ""),
  });
  const getAgentDiscoveryOptions = () => {
    const configuration = vscode.workspace.getConfiguration("vscode-acp");
    return {
      ...getAgentResolutionOptions(),
      agentPaths: selectAgentPaths(
        configuration.inspect<Record<string, string>>("agentPaths"),
        vscode.workspace.isTrusted
      ),
    };
  };
  const diagnosticsOutput =
    vscode.window.createOutputChannel("ACP Diagnostics");
  context.subscriptions.push(diagnosticsOutput);
  const diagnostics = new ACPDiagnostics(diagnosticsOutput, () =>
    vscode.workspace
      .getConfiguration("vscode-acp")
      .get<boolean>("diagnostics.enabled", false)
  );
  acpClient = new ACPClient({
    resolutionOptions: getAgentResolutionOptions,
    diagnostics,
  });
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    acpClient,
    context.globalState,
    context.workspaceState,
    getAgentResolutionOptions
  );
  sessionTreeProvider = new AgentSessionTreeProvider(
    context.workspaceState,
    getAgentDiscoveryOptions,
    async (request) => {
      await vscode.commands.executeCommand("vscode-acp.chatView.focus");
      return (await chatProvider?.openAgentSession(request)) ?? false;
    }
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = "vscode-acp.startChat";
  statusBarItem.tooltip = "VSCode ACP - Click to open chat";
  updateStatusBar("disconnected");
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  acpClient.setOnStateChange((state) => {
    updateStatusBar(state);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );
  context.subscriptions.push(
    sessionTreeProvider,
    vscode.window.createTreeView(AgentSessionTreeProvider.viewType, {
      treeDataProvider: sessionTreeProvider,
      showCollapseAll: true,
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("vscode-acp.agentPaths")) {
        sessionTreeProvider?.refresh();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      sessionTreeProvider?.refresh();
    })
  );
  if (!context.globalState.get<boolean>(CHAT_VIEW_LOCATION_INITIALIZED)) {
    await vscode.commands.executeCommand("vscode.moveViews", {
      viewIds: [ChatViewProvider.viewType],
      destinationId: "workbench.panel.chat",
    });
    await context.globalState.update(CHAT_VIEW_LOCATION_INITIALIZED, true);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.startChat", async () => {
      await vscode.commands.executeCommand("vscode-acp.chatView.focus");
      try {
        await chatProvider?.connect();
        vscode.window.showInformationMessage("VSCode ACP connected");
      } catch (error) {
        console.error("[ACP] Failed to connect:", error);
        vscode.window.showErrorMessage(
          `Failed to connect: ${formatACPError(error)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "vscode-acp.addSelectionToChat",
      async (editor) => {
        const selection = editor.selection;
        if (selection.isEmpty) {
          return;
        }
        const text = editor.document.getText(selection);
        const endLine =
          selection.end.character === 0 &&
          selection.end.line > selection.start.line
            ? selection.end.line
            : selection.end.line + 1;
        const selectionContext = {
          uri: editor.document.uri,
          text,
          startLine: selection.start.line + 1,
          endLine,
        };

        await vscode.commands.executeCommand("vscode-acp.chatView.focus");
        await chatProvider?.addEditorSelection(selectionContext);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.newChat", () => {
      chatProvider?.newChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.loadSession", async () => {
      await vscode.commands.executeCommand("vscode-acp.chatView.focus");
      await chatProvider?.loadSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.deleteSession", async () => {
      await vscode.commands.executeCommand("vscode-acp.chatView.focus");
      await chatProvider?.deleteSession();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.sessions.refresh", () => {
      sessionTreeProvider?.refresh();
    }),
    vscode.commands.registerCommand(
      "vscode-acp.sessions.refreshAgent",
      async (agentId: string) => {
        sessionTreeProvider?.refresh(agentId);
      }
    ),
    vscode.commands.registerCommand(
      "vscode-acp.sessions.loadMore",
      async (agentId: string) => {
        await sessionTreeProvider?.loadMore(agentId);
      }
    ),
    vscode.commands.registerCommand(
      "vscode-acp.sessions.authenticate",
      async (agentId: string) => {
        await sessionTreeProvider?.authenticate(agentId);
      }
    )
  );

  const openTreeSession = async (
    node: AgentSessionTreeNode,
    mode?: SessionOpenMode
  ): Promise<void> => {
    if (node?.kind === "session") {
      await sessionTreeProvider?.openSession(node, mode);
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode-acp.sessions.open",
      (node: AgentSessionTreeNode) => openTreeSession(node)
    ),
    vscode.commands.registerCommand(
      "vscode-acp.sessions.load",
      (node: AgentSessionTreeNode) => openTreeSession(node, "load")
    ),
    vscode.commands.registerCommand(
      "vscode-acp.sessions.resume",
      (node: AgentSessionTreeNode) => openTreeSession(node, "resume")
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.clearChat", () => {
      chatProvider?.clearChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.showDiagnostics", () => {
      diagnostics.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode-acp.restartAgent",
      createRestartAgentCommand(
        chatProvider,
        () => vscode.commands.executeCommand("vscode-acp.chatView.focus"),
        (message) => vscode.window.showInformationMessage(message),
        (message) => vscode.window.showErrorMessage(message)
      )
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vscode-acp.disconnectAgent",
      createDisconnectAgentCommand(
        chatProvider,
        (message) => vscode.window.showInformationMessage(message),
        (message) => vscode.window.showErrorMessage(message)
      )
    )
  );


  context.subscriptions.push({
    dispose: () => {
      chatProvider?.dispose();
      acpClient?.dispose();
      sessionTreeProvider?.dispose();
    },
  });
}

function updateStatusBar(
  state: "disconnected" | "connecting" | "connected" | "error"
): void {
  if (!statusBarItem) return;

  const icons: Record<string, string> = {
    disconnected: "$(debug-disconnect)",
    connecting: "$(sync~spin)",
    connected: "$(check)",
    error: "$(error)",
  };

  const labels: Record<string, string> = {
    disconnected: "ACP: Disconnected",
    connecting: "ACP: Connecting...",
    connected: "ACP: Connected",
    error: "ACP: Error",
  };

  statusBarItem.text = `${icons[state] || icons.disconnected} ACP`;
  statusBarItem.tooltip = labels[state] || labels.disconnected;

  if (state === "error") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  } else if (state === "connecting") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.backgroundColor = undefined;
  }
}

export function deactivate() {
  console.log("VSCode ACP extension deactivating");
  chatProvider?.dispose();
  acpClient?.dispose();
  sessionTreeProvider?.dispose();
}
