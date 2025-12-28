import * as vscode from "vscode";
import { ACPClient } from "./acp/client";
import { ChatViewProvider } from "./views/chat";

let acpClient: ACPClient | undefined;
let chatProvider: ChatViewProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("VSCode ACP extension is now active");

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.openDevTools", () => {
      vscode.commands.executeCommand(
        "workbench.action.webview.openDeveloperTools"
      );
    })
  );

  acpClient = new ACPClient();
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    acpClient,
    context.globalState
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
    vscode.commands.registerCommand("vscode-acp.startChat", async () => {
      await vscode.commands.executeCommand("vscode-acp.chatView.focus");

      if (!acpClient?.isConnected()) {
        try {
          await acpClient?.connect();
          vscode.window.showInformationMessage("VSCode ACP connected");
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to connect: ${error}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.newChat", () => {
      chatProvider?.newChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-acp.clearChat", () => {
      chatProvider?.clearChat();
    })
  );

  context.subscriptions.push({
    dispose: () => {
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
  acpClient?.dispose();
}
