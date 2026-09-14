import * as vscode from "vscode";
import { realpath } from "fs/promises";
import { isAbsolute, relative, sep } from "path";
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
 * Checks that a local file resolves inside a trusted local workspace root.
 * Canonical paths prevent workspace symlinks from granting access outside
 * the workspace boundary.
 */
export async function isTrustedWorkspaceFile(
  uri: vscode.Uri,
  workspaceFolders = vscode.workspace.workspaceFolders,
  workspaceTrusted = vscode.workspace.isTrusted
): Promise<boolean> {
  if (!workspaceTrusted || uri.scheme !== "file" || !workspaceFolders) {
    return false;
  }

  try {
    const candidate = await realpath(uri.fsPath);
    for (const folder of workspaceFolders) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const root = await realpath(folder.uri.fsPath);
      const relativePath = relative(root, candidate);
      if (
        relativePath === "" ||
        (relativePath !== ".." &&
          !relativePath.startsWith(`..${sep}`) &&
          !isAbsolute(relativePath))
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
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
  id: string,
  workspaceFolders = vscode.workspace.workspaceFolders,
  workspaceTrusted = vscode.workspace.isTrusted
): Promise<FileAttachment | null> {
  if (
    !(await isTrustedWorkspaceFile(uri, workspaceFolders, workspaceTrusted))
  ) {
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
 * Opens a picker for files inside trusted local workspace roots. Open tabs
 * outside the workspace are omitted, and native-dialog selections are
 * canonicalized and rejected unless they resolve inside a workspace root.
 */
export async function pickAttachmentUris(
  remaining: number
): Promise<vscode.Uri[]> {
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
      const key = uri.toString();
      if (seen.has(key) || !(await isTrustedWorkspaceFile(uri))) {
        continue;
      }
      seen.add(key);
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
      ? `Select up to ${remaining} open workspace file${remaining === 1 ? "" : "s"}, or browse the workspace`
      : "No open workspace files - use browse to attach a workspace file";
  quickPick.buttons = [
    {
      iconPath: new vscode.ThemeIcon("folder-opened"),
      tooltip: "Browse workspace files...",
    },
  ];

  let resolvePromise!: (uris: vscode.Uri[]) => void;
  const promise = new Promise<vscode.Uri[]>((resolve) => {
    resolvePromise = resolve;
  });
  let settled = false;
  let browsing = false;
  const finish = (uris: vscode.Uri[]) => {
    if (settled) return;
    settled = true;
    quickPick.dispose();
    resolvePromise(uris);
  };

  quickPick.onDidTriggerButton(async () => {
    browsing = true;
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        openLabel: "Attach workspace files",
      });
      const allowed: vscode.Uri[] = [];
      for (const uri of picked ?? []) {
        if (await isTrustedWorkspaceFile(uri)) {
          allowed.push(uri);
        }
      }
      if ((picked?.length ?? 0) > allowed.length) {
        void vscode.window.showWarningMessage(
          "Only files inside a trusted local workspace can be attached."
        );
      }
      finish(allowed);
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
  return promise;
}
