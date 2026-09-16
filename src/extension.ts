import * as vscode from "vscode";
import { ACPClient, formatACPError } from "./acp/client";
import { ChatViewProvider } from "./views/chat";
import type { AgentCommandResolutionOptions } from "./acp/agentCommand";

let acpClient: ACPClient | undefined;
let chatProvider: ChatViewProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
const CHAT_VIEW_LOCATION_INITIALIZED = "vscode-acp.chatViewSecondarySidebarV1";

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
  acpClient = new ACPClient({ resolutionOptions: getAgentResolutionOptions });
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    acpClient,
    context.globalState,
    context.workspaceState,
    getAgentResolutionOptions
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
    vscode.commands.registerCommand("vscode-acp.clearChat", () => {
      chatProvider?.clearChat();
    })
  );

  context.subscriptions.push({
    dispose: () => {
      chatProvider?.dispose();
      acpClient?.dispose();
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
}
