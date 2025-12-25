import * as vscode from "vscode";
import { ACPClient } from "./acp/client";
import { ChatViewProvider } from "./views/chat";

let acpClient: ACPClient | undefined;
let chatProvider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("VSCode ACP extension is now active");

  acpClient = new ACPClient();
  chatProvider = new ChatViewProvider(
    context.extensionUri,
    acpClient,
    context.globalState,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "vscode-acp.chatView",
      chatProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
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
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      acpClient?.dispose();
    },
  });
}

export function deactivate() {
  console.log("VSCode ACP extension deactivating");
  acpClient?.dispose();
}
