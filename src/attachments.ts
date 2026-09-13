import * as vscode from "vscode";
import {
  isAttachmentMetadataValid,
  sanitizeAttachmentLabel,
  type FileAttachment,
} from "./shared/attachments";

/**
 * Extension-of-file to MIME type lookup for the common source and document
 * types agents deal with. Deliberately small and hand-maintained instead of
 * pulling in a `mime` dependency: we only ever guess a label from a file
 * name, we never sniff or read content. Unknown extensions omit `mimeType`
 * entirely rather than guessing "text/plain" for what may be binary data.
 */
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/rust",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".cc": "text/x-c++",
  ".cxx": "text/x-c++",
  ".hpp": "text/x-c++",
  ".cs": "text/x-csharp",
  ".rb": "text/x-ruby",
  ".php": "application/x-httpd-php",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".less": "text/x-less",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".sh": "application/x-sh",
  ".bash": "application/x-sh",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".sql": "application/sql",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

/** Guesses a MIME type from a file name's extension. Returns `undefined` for unknown extensions. */
export function guessMimeType(fileName: string): string | undefined {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return undefined;
  }
  return MIME_TYPES_BY_EXTENSION[fileName.slice(dotIndex).toLowerCase()];
}

/**
 * Returns the canonical, cross-platform `file://` URI string for a VS Code
 * URI. `Uri#toString()` percent-encodes and normalizes the authority/path
 * (drive letters, UNC shares, non-ASCII segments) consistently across
 * Windows, macOS, and Linux, so callers should never hand-roll URIs from
 * `fsPath`.
 */
export function canonicalFileUri(uri: vscode.Uri): string {
  return uri.toString();
}

/**
 * Derives the basename of a URI's path without going through `fsPath`
 * (which is platform-dependent and unnecessary for a display label), with
 * control and bidi characters stripped: POSIX file names may contain them,
 * and they would otherwise reach both the chip tooltip and the
 * `resource_link.name` the agent feeds to its model.
 */
function basenameFromUriPath(uri: vscode.Uri): string {
  const segments = uri.path.split("/").filter((segment) => segment.length > 0);
  return sanitizeAttachmentLabel(
    segments.length > 0 ? segments[segments.length - 1] : uri.path
  );
}

/**
 * Neutralizes VS Code's `$(icon)` markup in untrusted text so a file named
 * `app$(check).ts` cannot render a synthetic codicon in the picker and
 * disguise which row the user is selecting. VS Code renders `\$(` as a
 * literal `$(`.
 */
export function escapeQuickPickLabel(text: string): string {
  return sanitizeAttachmentLabel(text).replace(/\$\(/g, "\\$(");
}

/**
 * Builds attachment metadata for a single selected file: stats it for size,
 * infers a MIME type from the extension, and canonicalizes its URI. Returns
 * `null` when the target isn't a regular file or its metadata violates the
 * reasonable count/size boundaries in `shared/attachments`, so the caller
 * can skip it without guessing at a corrected value.
 */
export async function createFileAttachment(
  uri: vscode.Uri,
  id: string
): Promise<FileAttachment | null> {
  if (uri.scheme !== "file") {
    return null;
  }

  const name = basenameFromUriPath(uri);
  const canonicalUri = canonicalFileUri(uri);

  if (!isAttachmentMetadataValid(name, canonicalUri)) {
    return null;
  }

  let size: number | undefined;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      return null;
    }
    size = Number.isSafeInteger(stat.size) ? stat.size : undefined;
  } catch (error) {
    console.warn("[Attachments] Failed to stat file:", canonicalUri, error);
    return null;
  }

  return {
    id,
    uri: canonicalUri,
    name,
    mimeType: guessMimeType(name),
    size,
  };
}

/**
 * Opens a picker that lets the user attach files through trusted VS Code
 * APIs only: currently open editor tabs are listed directly, and a title
 * bar button opens the native `showOpenDialog` for any other workspace or
 * filesystem file. No `@`-mention parsing or custom fuzzy search is
 * implemented; this is deliberately the full selection surface.
 *
 * Resolves to all selected URIs (empty when the user cancels); the caller
 * enforces `remaining` while producing user-visible skip feedback.
 */
export function pickAttachmentUris(remaining: number): Promise<vscode.Uri[]> {
  // QuickPick completes through one of several event callbacks, so the
  // executor form keeps a single resolver shared across those callbacks and
  // remains compatible with the extension's declared VS Code 1.74 baseline.
  return new Promise((resolve) => {
    type FileQuickPickItem = vscode.QuickPickItem & { uri: vscode.Uri };

    const seen = new Set<string>();
    const items: FileQuickPickItem[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText)) {
          continue;
        }
        const uri = input.uri;
        if (uri.scheme !== "file" || seen.has(uri.toString())) {
          continue;
        }
        seen.add(uri.toString());
        items.push({
          label: `$(file) ${escapeQuickPickLabel(
            vscode.workspace.asRelativePath(uri, false)
          )}`,
          description: escapeQuickPickLabel(uri.fsPath),
          uri,
        });
      }
    }

    const quickPick = vscode.window.createQuickPick<FileQuickPickItem>();
    quickPick.items = items;
    quickPick.canSelectMany = true;
    quickPick.matchOnDescription = true;
    quickPick.placeholder =
      items.length > 0
        ? `Select up to ${remaining} open file${remaining === 1 ? "" : "s"}, or browse for more`
        : "No open files - use the browse button to attach files";
    quickPick.buttons = [
      {
        iconPath: new vscode.ThemeIcon("folder-opened"),
        tooltip: "Browse for files...",
      },
    ];

    let settled = false;
    let browsing = false;
    const finish = (uris: vscode.Uri[]) => {
      if (settled) return;
      settled = true;
      quickPick.dispose();
      resolve(uris);
    };

    quickPick.onDidTriggerButton(async () => {
      browsing = true;
      try {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
          openLabel: "Attach",
        });
        finish(picked ?? []);
      } catch (error) {
        console.error("[Attachments] Failed to open file dialog:", error);
        finish([]);
      } finally {
        browsing = false;
      }
    });

    quickPick.onDidAccept(() => {
      finish(quickPick.selectedItems.map((item) => item.uri));
    });

    quickPick.onDidHide(() => {
      if (!browsing) finish([]);
    });

    quickPick.show();
  });
}
