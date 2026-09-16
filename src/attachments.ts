import * as vscode from "vscode";
import { realpath } from "fs/promises";
import { isAbsolute, relative, sep } from "path";
import type {
  ContentBlock,
  PromptCapabilities,
} from "@agentclientprotocol/sdk";
import {
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_EMBEDDED_RESOURCE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_INLINE_ATTACHMENT_BYTES,
  decodedBase64Size,
  detectedImageMimeType,
  isAttachmentMetadataValid,
  isEmbeddableTextMimeType,
  isFileAttachmentValid,
  isPromptAttachmentValid,
  isSupportedImageMimeType,
  sanitizeAttachmentLabel,
  toAttachmentMetadata,
  type FileAttachment,
  type PromptAttachment,
  type SupportedImageMimeType,
} from "./shared/attachments";
import {
  openTrustedWorkspaceFile,
  readOpenedWorkspaceFileBytes,
  trustedWorkspaceRootPath,
  WorkspaceFileTooLargeError,
  type OpenedWorkspaceFile,
} from "./acp/workspace-files";

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
  ".webp": "image/webp",
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
 * Resolves a local file to its canonical URI inside a trusted local workspace
 * root. Returning the resolved target prevents a selected symlink from later
 * being transported under a misleading workspace path.
 */
async function resolveTrustedWorkspaceFile(
  uri: vscode.Uri,
  workspaceFolders = vscode.workspace.workspaceFolders,
  workspaceTrusted = vscode.workspace.isTrusted
): Promise<vscode.Uri | null> {
  if (!workspaceTrusted || uri.scheme !== "file" || !workspaceFolders) {
    return null;
  }

  try {
    const candidate = await realpath(uri.fsPath);
    for (const folder of workspaceFolders) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const root = await trustedWorkspaceRootPath(folder.uri.fsPath);
      const relativePath = relative(root, candidate);
      if (
        relativePath === "" ||
        (relativePath !== ".." &&
          !relativePath.startsWith(`..${sep}`) &&
          !isAbsolute(relativePath))
      ) {
        return vscode.Uri.file(candidate);
      }
    }
  } catch {
    return null;
  }

  return null;
}

export async function isTrustedWorkspaceFile(
  uri: vscode.Uri,
  workspaceFolders = vscode.workspace.workspaceFolders,
  workspaceTrusted = vscode.workspace.isTrusted
): Promise<boolean> {
  return (
    (await resolveTrustedWorkspaceFile(
      uri,
      workspaceFolders,
      workspaceTrusted
    )) !== null
  );
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
  const resolvedUri = await resolveTrustedWorkspaceFile(
    uri,
    workspaceFolders,
    workspaceTrusted
  );
  if (!resolvedUri) {
    return null;
  }

  const name = basenameFromUriPath(resolvedUri);
  const canonicalUri = canonicalFileUri(resolvedUri);

  if (!isAttachmentMetadataValid(name, canonicalUri)) {
    return null;
  }

  let size: number | undefined;
  try {
    const stat = await vscode.workspace.fs.stat(resolvedUri);
    if (stat.type !== vscode.FileType.File) {
      return null;
    }
    size = Number.isSafeInteger(stat.size) ? stat.size : undefined;
  } catch (error) {
    console.warn("[Attachments] Failed to stat file:", canonicalUri, error);
    return null;
  }

  const mimeType = guessMimeType(name);
  return {
    id,
    uri: canonicalUri,
    name,
    mimeType,
    size,
    source: "file",
    kind: isSupportedImageMimeType(mimeType) ? "image" : "file",
    transport: "resource_link",
  };
}

export class AttachmentInputError extends Error {}

export interface InlineAttachmentInput {
  name: string;
  mimeType?: string;
  data: string;
}

export interface PreparedAttachment {
  attachment: PromptAttachment;
  inlineBytes: number;
  warning?: string;
}

function memoryAttachmentUri(id: string, name: string): string {
  return `vscode-acp-attachment:///memory/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

function selectionAttachmentUri(id: string, name: string): string {
  return `vscode-acp-attachment:///selection/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

function selectionAttachmentName(uri: string): string | null {
  if (!uri.startsWith("vscode-acp-attachment:///selection/")) {
    return null;
  }
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "vscode-acp-attachment:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length !== 3 || segments[0] !== "selection") {
      return null;
    }
    const name = sanitizeAttachmentLabel(decodeURIComponent(segments[2]));
    return name.length > 0 && name.length <= MAX_ATTACHMENT_NAME_LENGTH
      ? name
      : null;
  } catch {
    return null;
  }
}

/**
 * Validates bytes supplied by a browser File object and moves them into the
 * same host-owned draft used by picker attachments. The webview never chooses
 * a URI and unsupported optional ACP content is rejected before it enters the
 * draft.
 */
export function createInlineAttachment(
  input: InlineAttachmentInput,
  id: string,
  capabilities: Readonly<PromptCapabilities>,
  currentInlineBytes: number
): PromptAttachment {
  if (
    typeof input.name !== "string" ||
    (input.mimeType !== undefined && typeof input.mimeType !== "string")
  ) {
    throw new AttachmentInputError("The attachment metadata is invalid.");
  }
  const name = sanitizeAttachmentLabel(input.name);
  if (
    name !== input.name ||
    name.length === 0 ||
    name.length > MAX_ATTACHMENT_NAME_LENGTH
  ) {
    throw new AttachmentInputError("The attachment has an invalid file name.");
  }
  if (typeof input.data !== "string") {
    throw new AttachmentInputError("The attachment data is invalid.");
  }
  if (
    !Number.isSafeInteger(currentInlineBytes) ||
    currentInlineBytes < 0 ||
    currentInlineBytes > MAX_INLINE_ATTACHMENT_BYTES
  ) {
    throw new AttachmentInputError("The attachment byte total is invalid.");
  }

  const declaredMime = input.mimeType?.toLowerCase();
  const inferredMime = guessMimeType(name);
  const mimeType = declaredMime || inferredMime;
  const maximumBytes = isSupportedImageMimeType(mimeType)
    ? MAX_IMAGE_BYTES
    : MAX_EMBEDDED_RESOURCE_BYTES;
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (input.data.length > maximumEncodedLength) {
    throw new AttachmentInputError(
      `Attachments of this type must be ${maximumBytes / 1024 / 1024} MB or smaller.`
    );
  }
  const size = decodedBase64Size(input.data);
  if (size === null) {
    throw new AttachmentInputError(
      "The attachment data is not valid canonical base64."
    );
  }
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.byteLength !== size) {
    throw new AttachmentInputError("The attachment data is invalid.");
  }
  const detectedImageMime = detectedImageMimeType(bytes);
  if (detectedImageMime !== null && detectedImageMime !== mimeType) {
    throw new AttachmentInputError(
      "The image bytes do not match the declared MIME type."
    );
  }

  const uri = memoryAttachmentUri(id, name);
  if (isSupportedImageMimeType(mimeType)) {
    if (capabilities.image !== true) {
      throw new AttachmentInputError(
        "The current agent does not advertise image prompt support."
      );
    }
    if (size > MAX_IMAGE_BYTES) {
      throw new AttachmentInputError(
        `Images must be ${MAX_IMAGE_BYTES / 1024 / 1024} MB or smaller.`
      );
    }
    if (currentInlineBytes + size > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new AttachmentInputError(
        `Attachments may embed at most ${MAX_INLINE_ATTACHMENT_BYTES / 1024 / 1024} MB per prompt.`
      );
    }
    if (detectedImageMime !== mimeType) {
      throw new AttachmentInputError(
        "The image bytes do not match the declared MIME type."
      );
    }
    const attachment: PromptAttachment = {
      id,
      uri,
      name,
      mimeType,
      size,
      source: "memory",
      kind: "image",
      transport: "image",
      previewDataUrl: `data:${mimeType};base64,${input.data}`,
      payload: { type: "image", data: input.data },
    };
    if (!isPromptAttachmentValid(attachment)) {
      throw new AttachmentInputError("The image metadata is invalid.");
    }
    return attachment;
  }

  if (capabilities.embeddedContext !== true) {
    throw new AttachmentInputError(
      "The current agent does not advertise embedded context support."
    );
  }
  if (mimeType !== undefined && !isEmbeddableTextMimeType(mimeType)) {
    throw new AttachmentInputError("Only text files can be embedded.");
  }
  if (size > MAX_EMBEDDED_RESOURCE_BYTES) {
    throw new AttachmentInputError(
      `Embedded files must be ${MAX_EMBEDDED_RESOURCE_BYTES / 1024 / 1024} MB or smaller.`
    );
  }
  if (currentInlineBytes + size > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new AttachmentInputError(
      `Attachments may embed at most ${MAX_INLINE_ATTACHMENT_BYTES / 1024 / 1024} MB per prompt.`
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentInputError(
      "Only valid UTF-8 text files can be embedded."
    );
  }
  const attachment: PromptAttachment = {
    id,
    uri,
    name,
    mimeType: isEmbeddableTextMimeType(mimeType) ? mimeType : "text/plain",
    size,
    source: "memory",
    kind: "file",
    transport: "resource",
    payload: { type: "text", text },
  };
  if (!isPromptAttachmentValid(attachment)) {
    throw new AttachmentInputError("The embedded file metadata is invalid.");
  }
  return attachment;
}

/**
 * Captures an editor selection as host-owned prompt context. ACP agents that
 * advertise embedded context receive a resource block; other agents receive
 * the same bounded context as a text block.
 */
export function createSelectionAttachment(
  name: string,
  selectedText: string,
  id: string,
  currentInlineBytes: number
): PromptAttachment {
  const safeName = sanitizeAttachmentLabel(name);
  if (
    safeName !== name ||
    safeName.length === 0 ||
    safeName.length > MAX_ATTACHMENT_NAME_LENGTH
  ) {
    throw new AttachmentInputError("The selection has an invalid location.");
  }
  if (
    !Number.isSafeInteger(currentInlineBytes) ||
    currentInlineBytes < 0 ||
    currentInlineBytes > MAX_INLINE_ATTACHMENT_BYTES
  ) {
    throw new AttachmentInputError("The attachment byte total is invalid.");
  }

  const text = `Selected code from ${safeName}:\n\n${selectedText}`;
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_EMBEDDED_RESOURCE_BYTES) {
    throw new AttachmentInputError(
      `Selections must be ${MAX_EMBEDDED_RESOURCE_BYTES / 1024 / 1024} MB or smaller.`
    );
  }
  if (currentInlineBytes + size > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new AttachmentInputError(
      `Attachments may embed at most ${MAX_INLINE_ATTACHMENT_BYTES / 1024 / 1024} MB per prompt.`
    );
  }

  const attachment: PromptAttachment = {
    id,
    uri: selectionAttachmentUri(id, safeName),
    name: safeName,
    mimeType: "text/plain",
    size,
    source: "memory",
    kind: "selection",
    transport: "resource",
    payload: { type: "text", text },
  };
  if (!isPromptAttachmentValid(attachment)) {
    throw new AttachmentInputError("The selection metadata is invalid.");
  }
  return attachment;
}

/**
 * Revalidates a selected file immediately before sending, then materializes
 * only the content type the connected agent explicitly advertised. Text uses
 * VS Code's document buffer, so unsaved edits are embedded.
 */
export async function prepareFileAttachment(
  attachment: PromptAttachment,
  capabilities: Readonly<PromptCapabilities>,
  currentInlineBytes: number,
  includePreview = false
): Promise<PreparedAttachment | null> {
  if (
    !Number.isSafeInteger(currentInlineBytes) ||
    currentInlineBytes < 0 ||
    currentInlineBytes > MAX_INLINE_ATTACHMENT_BYTES
  ) {
    throw new AttachmentInputError("The attachment byte total is invalid.");
  }
  if ((attachment.source ?? "file") === "memory") {
    const promptAttachment = attachment;
    if (
      !promptAttachment.payload ||
      !isPromptAttachmentValid(promptAttachment)
    ) {
      throw new AttachmentInputError(
        "The in-memory attachment is no longer available."
      );
    }
    const inlineBytes =
      promptAttachment.payload.type === "image"
        ? (decodedBase64Size(promptAttachment.payload.data) ??
          MAX_INLINE_ATTACHMENT_BYTES + 1)
        : Buffer.byteLength(promptAttachment.payload.text, "utf8");
    if (
      currentInlineBytes + inlineBytes > MAX_INLINE_ATTACHMENT_BYTES ||
      (promptAttachment.payload.type === "image" &&
        capabilities.image !== true) ||
      (promptAttachment.payload.type === "text" &&
        promptAttachment.kind !== "selection" &&
        capabilities.embeddedContext !== true)
    ) {
      throw new AttachmentInputError(
        "The current agent cannot safely receive this in-memory attachment."
      );
    }
    return { attachment: promptAttachment, inlineBytes };
  }

  const refreshed = await createFileAttachment(
    vscode.Uri.parse(attachment.uri, true),
    attachment.id
  );
  if (!refreshed) {
    return null;
  }

  if (
    capabilities.image === true &&
    isSupportedImageMimeType(refreshed.mimeType)
  ) {
    if (
      refreshed.size !== undefined &&
      (refreshed.size > MAX_IMAGE_BYTES ||
        currentInlineBytes + refreshed.size > MAX_INLINE_ATTACHMENT_BYTES)
    ) {
      return {
        attachment: { ...refreshed, transport: "resource_link" },
        inlineBytes: 0,
        warning: `${refreshed.name} was linked instead of embedded because it exceeds the image limit.`,
      };
    }
    let bytes: Uint8Array;
    try {
      const opened = await openTrustedWorkspaceFile(
        vscode.Uri.parse(refreshed.uri).fsPath,
        "read"
      );
      try {
        bytes = await readOpenedWorkspaceFileBytes(opened, MAX_IMAGE_BYTES);
      } finally {
        await opened.fileHandle.close();
      }
    } catch (error) {
      if (error instanceof WorkspaceFileTooLargeError) {
        return {
          attachment: { ...refreshed, transport: "resource_link" },
          inlineBytes: 0,
          warning: `${refreshed.name} was linked instead of embedded because it exceeds the image limit.`,
        };
      }
      throw error;
    }
    if (
      bytes.byteLength > MAX_IMAGE_BYTES ||
      currentInlineBytes + bytes.byteLength > MAX_INLINE_ATTACHMENT_BYTES
    ) {
      return {
        attachment: { ...refreshed, size: bytes.byteLength },
        inlineBytes: 0,
        warning: `${refreshed.name} was linked instead of embedded because it exceeds the image limit.`,
      };
    }
    if (detectedImageMimeType(bytes) !== refreshed.mimeType) {
      return {
        attachment: {
          ...refreshed,
          mimeType: undefined,
          size: bytes.byteLength,
          kind: "file",
          transport: "resource_link",
        },
        inlineBytes: 0,
        warning: `${refreshed.name} was linked because its bytes do not match ${refreshed.mimeType}.`,
      };
    }
    const data = Buffer.from(bytes).toString("base64");
    return {
      attachment: {
        ...refreshed,
        size: bytes.byteLength,
        transport: "image",
        ...(includePreview || attachment.previewDataUrl !== undefined
          ? { previewDataUrl: `data:${refreshed.mimeType};base64,${data}` }
          : {}),
        payload: { type: "image", data },
      },
      inlineBytes: bytes.byteLength,
    };
  }

  if (
    capabilities.embeddedContext === true &&
    isEmbeddableTextMimeType(refreshed.mimeType)
  ) {
    const contextLimitWarning = `${refreshed.name} was linked instead of embedded because it exceeds the context limit.`;

    let opened: OpenedWorkspaceFile | undefined;
    let text: string;
    try {
      opened = await openTrustedWorkspaceFile(
        vscode.Uri.parse(refreshed.uri).fsPath,
        "read"
      );
      const canonicalUri = vscode.Uri.file(opened.canonicalPath).toString();
      const openDocument = vscode.workspace.textDocuments.find(
        (document) =>
          document.uri.scheme === "file" &&
          document.uri.toString() === canonicalUri
      );
      if (openDocument) {
        text = openDocument.getText();
      } else {
        const bytes = await readOpenedWorkspaceFileBytes(
          opened,
          MAX_EMBEDDED_RESOURCE_BYTES
        );
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return {
            attachment: { ...refreshed, transport: "resource_link" },
            inlineBytes: 0,
            warning: `${refreshed.name} was linked because it is not valid UTF-8 text.`,
          };
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceFileTooLargeError) {
        return {
          attachment: { ...refreshed, transport: "resource_link" },
          inlineBytes: 0,
          warning: contextLimitWarning,
        };
      }
      throw error;
    } finally {
      await opened?.fileHandle.close();
    }
    const size = Buffer.byteLength(text, "utf8");
    if (
      size > MAX_EMBEDDED_RESOURCE_BYTES ||
      currentInlineBytes + size > MAX_INLINE_ATTACHMENT_BYTES
    ) {
      return {
        attachment: { ...refreshed, transport: "resource_link" },
        inlineBytes: 0,
        warning: `${refreshed.name} was linked instead of embedded because it exceeds the context limit.`,
      };
    }
    return {
      attachment: {
        ...refreshed,
        size,
        transport: "resource",
        payload: { type: "text", text },
      },
      inlineBytes: size,
    };
  }

  return {
    attachment: { ...refreshed, transport: "resource_link" },
    inlineBytes: 0,
  };
}

/** Builds bounded display-only metadata from attachment blocks replayed by an agent. */
export function createReplayAttachment(
  content: ContentBlock,
  id: string
): FileAttachment | null {
  if (content.type === "text") {
    const match = /^Selected code from (.+:L\d+(?:-L\d+)?):\n\n/.exec(
      content.text
    );
    if (!match) {
      return null;
    }
    try {
      return toAttachmentMetadata(
        createSelectionAttachment(
          match[1],
          content.text.slice(match[0].length),
          id,
          0
        )
      );
    } catch {
      return null;
    }
  }

  if (content.type === "resource_link") {
    if (
      typeof content.name !== "string" ||
      typeof content.uri !== "string" ||
      (content.mimeType !== undefined &&
        content.mimeType !== null &&
        typeof content.mimeType !== "string") ||
      (content.size !== undefined &&
        content.size !== null &&
        typeof content.size !== "number")
    ) {
      return null;
    }
    const mimeType = content.mimeType ?? undefined;
    const size = content.size ?? undefined;
    if (!isAttachmentMetadataValid(content.name, content.uri, mimeType, size)) {
      return null;
    }
    return {
      id,
      uri: content.uri,
      name: content.name,
      mimeType,
      size,
      source: "file",
      kind: isSupportedImageMimeType(mimeType) ? "image" : "file",
      transport: "resource_link",
    };
  }

  if (content.type === "resource") {
    const resource: unknown = content.resource;
    if (
      typeof resource !== "object" ||
      resource === null ||
      !Object.prototype.hasOwnProperty.call(resource, "text") ||
      Object.prototype.hasOwnProperty.call(resource, "blob")
    ) {
      return null;
    }
    const resourceRecord = resource as Record<string, unknown>;
    if (
      typeof resourceRecord.uri !== "string" ||
      typeof resourceRecord.text !== "string" ||
      (resourceRecord.mimeType !== undefined &&
        resourceRecord.mimeType !== null &&
        typeof resourceRecord.mimeType !== "string")
    ) {
      return null;
    }
    const text = resourceRecord.text;
    if (text.length > MAX_EMBEDDED_RESOURCE_BYTES) {
      return null;
    }
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_EMBEDDED_RESOURCE_BYTES) {
      return null;
    }
    const uri = resourceRecord.uri;
    const selectionName = selectionAttachmentName(uri);
    let name: string;
    if (selectionName) {
      if (!text.startsWith(`Selected code from ${selectionName}:\n\n`)) {
        return null;
      }
      name = selectionName;
    } else {
      try {
        name = basenameFromUriPath(vscode.Uri.parse(uri, true));
      } catch {
        return null;
      }
    }
    const mimeType =
      typeof resourceRecord.mimeType === "string"
        ? resourceRecord.mimeType
        : selectionName
          ? "text/plain"
          : undefined;
    if (isSupportedImageMimeType(mimeType)) {
      return null;
    }
    const source = uri.startsWith("file://") ? "file" : "memory";
    const attachment: FileAttachment = {
      id,
      uri,
      name,
      mimeType,
      size,
      source,
      kind: selectionName ? "selection" : "file",
      transport: "resource",
    };
    return isFileAttachmentValid(attachment) ? attachment : null;
  }

  if (content.type === "image" && isSupportedImageMimeType(content.mimeType)) {
    if (
      typeof content.data !== "string" ||
      content.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    ) {
      return null;
    }
    const size = decodedBase64Size(content.data);
    if (size === null || size > MAX_IMAGE_BYTES) {
      return null;
    }
    const bytes = Buffer.from(content.data, "base64");
    if (
      bytes.byteLength !== size ||
      detectedImageMimeType(bytes) !== content.mimeType
    ) {
      return null;
    }
    const extensionByMime: Record<SupportedImageMimeType, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
    };
    const suffix = id.split("-").at(-1) ?? "attachment";
    const name = `Image ${suffix}.${extensionByMime[content.mimeType]}`;
    const uri = memoryAttachmentUri(id, name);
    const attachment: FileAttachment = {
      id,
      uri,
      name,
      mimeType: content.mimeType,
      size,
      source: "memory",
      kind: "image",
      transport: "image",
      previewDataUrl: `data:${content.mimeType};base64,${content.data}`,
    };
    return isFileAttachmentValid(attachment) ? attachment : null;
  }

  return null;
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
      if (
        !(input instanceof vscode.TabInputText) &&
        !(input instanceof vscode.TabInputCustom)
      ) {
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
