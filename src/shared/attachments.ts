import type {
  ContentBlock,
  PromptCapabilities,
} from "@agentclientprotocol/sdk";

/**
 * Attachment types and limits shared between the extension host
 * (`src/attachments.ts`, `src/views/chat.ts`, `src/acp/client.ts`) and the
 * webview UI (`src/views/webview/main.ts`).
 *
 * This module MUST NOT import "vscode" (or anything else host-only) so it
 * can be bundled directly into the browser-context webview script by
 * esbuild.
 */

/** Maximum number of attachments allowed on a single prompt turn. */
export const MAX_ATTACHMENTS = 10;

/** Maximum raw bytes for one image content block. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Maximum UTF-8 bytes for one embedded text resource. */
export const MAX_EMBEDDED_RESOURCE_BYTES = 1024 * 1024;

/** Maximum aggregate raw bytes embedded in one prompt. */
export const MAX_INLINE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Maximum length (UTF-16 code units) for a displayed attachment name. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

/** Maximum length (UTF-16 code units) for an attachment's URI. */
export const MAX_ATTACHMENT_URI_LENGTH = 8192;

/** Maximum length (UTF-16 code units) for an attachment MIME type. */
export const MAX_ATTACHMENT_MIME_LENGTH = 255;

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
export type AttachmentSource = "file" | "memory";
export type AttachmentKind = "file" | "image";
export type AttachmentTransport = "resource_link" | "resource" | "image";
/**
 * Safe metadata rendered by the webview. Prompt payloads remain host-only;
 * only a bounded, validated raster preview may cross back to the webview.
 */
export interface FileAttachment {
  /** Opaque identifier scoped to the current composer draft. */
  id: string;
  /** Canonical local file URI or a host-generated in-memory attachment URI. */
  uri: string;
  /** Human-readable file name (basename). */
  name: string;
  /** Validated MIME type, if known. */
  mimeType?: string;
  /** Raw content size in bytes, when known. */
  size?: number;
  /** Defaults to `file` for legacy ResourceLink metadata. */
  source?: AttachmentSource;
  /** Defaults to `file`; image attachments use an image-specific chip. */
  kind?: AttachmentKind;
  /** Actual or currently negotiated ACP transport. */
  transport?: AttachmentTransport;
  /** Bounded raster data URL used only for a local image preview. */
  previewDataUrl?: string;
}

export type PromptAttachmentPayload =
  { type: "image"; data: string } | { type: "text"; text: string };

/** Host-only attachment state used to construct ACP content blocks. */
export interface PromptAttachment extends FileAttachment {
  payload?: PromptAttachmentPayload;
}

/** Formats a byte count as a short human-readable string (e.g. "12.4 KB"). */
export function formatByteSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/** Characters that can create false rows, reorder text, or hide file names. */
const UNSAFE_LABEL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

/** Strips display-control characters from an attachment label. */
export function sanitizeAttachmentLabel(label: string): string {
  return label.replace(UNSAFE_LABEL_CHARS, "");
}

function hasSafeMetadata(
  name: string,
  uri: string,
  mimeType?: string,
  size?: number
): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_ATTACHMENT_NAME_LENGTH &&
    name === sanitizeAttachmentLabel(name) &&
    uri.length > 0 &&
    uri.length <= MAX_ATTACHMENT_URI_LENGTH &&
    uri === sanitizeAttachmentLabel(uri) &&
    (mimeType === undefined ||
      (mimeType.length > 0 &&
        mimeType.length <= MAX_ATTACHMENT_MIME_LENGTH &&
        MIME_TYPE_PATTERN.test(mimeType))) &&
    (size === undefined || (Number.isSafeInteger(size) && size >= 0))
  );
}

function uriBasenameMatches(name: string, uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return false;
    }
    const encodedName = parsed.pathname.split("/").filter(Boolean).at(-1);
    return (
      encodedName !== undefined &&
      sanitizeAttachmentLabel(decodeURIComponent(encodedName)) === name
    );
  } catch {
    return false;
  }
}

function hasMatchingCanonicalFileName(name: string, uri: string): boolean {
  if (!uri.startsWith("file://")) {
    return false;
  }
  try {
    return new URL(uri).protocol === "file:" && uriBasenameMatches(name, uri);
  } catch {
    return false;
  }
}

function hasMatchingMemoryName(name: string, uri: string): boolean {
  if (!uri.startsWith("vscode-acp-attachment:///memory/")) {
    return false;
  }
  try {
    return (
      new URL(uri).protocol === "vscode-acp-attachment:" &&
      uriBasenameMatches(name, uri)
    );
  } catch {
    return false;
  }
}

/** Validates baseline local-file ResourceLink metadata. */
export function isAttachmentMetadataValid(
  name: string,
  uri: string,
  mimeType?: string,
  size?: number
): boolean {
  return (
    hasSafeMetadata(name, uri, mimeType, size) &&
    hasMatchingCanonicalFileName(name, uri)
  );
}

export function isSupportedImageMimeType(
  mimeType: string | undefined
): mimeType is SupportedImageMimeType {
  return SUPPORTED_IMAGE_MIME_TYPES.includes(
    mimeType as SupportedImageMimeType
  );
}

export function isSupportedImageAttachment(
  name: string,
  mimeType: string | undefined
): boolean {
  return (
    isSupportedImageMimeType(mimeType) ||
    (mimeType === undefined && /\.(?:png|jpe?g|gif|webp)$/i.test(name))
  );
}

export function decodedBase64Size(data: string): number | null {
  if (data.length === 0 || data.length % 4 !== 0) {
    return null;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bodyLength = data.length - padding;
  for (let index = 0; index < bodyLength; index += 1) {
    const code = data.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) {
      return null;
    }
  }
  for (let index = bodyLength; index < data.length; index += 1) {
    if (data[index] !== "=") {
      return null;
    }
  }
  return (data.length / 4) * 3 - padding;
}
export function isFileAttachmentValid(attachment: FileAttachment): boolean {
  const source = attachment.source ?? "file";
  const kind = attachment.kind ?? "file";
  if (
    !hasSafeMetadata(
      attachment.name,
      attachment.uri,
      attachment.mimeType,
      attachment.size
    ) ||
    (source === "file"
      ? !hasMatchingCanonicalFileName(attachment.name, attachment.uri)
      : !hasMatchingMemoryName(attachment.name, attachment.uri)) ||
    (attachment.transport !== undefined &&
      !["resource_link", "resource", "image"].includes(attachment.transport)) ||
    (kind === "image" && !isSupportedImageMimeType(attachment.mimeType))
  ) {
    return false;
  }

  if (attachment.previewDataUrl !== undefined) {
    if (kind !== "image" || !isSupportedImageMimeType(attachment.mimeType)) {
      return false;
    }
    const prefix = `data:${attachment.mimeType};base64,`;
    if (!attachment.previewDataUrl.startsWith(prefix)) {
      return false;
    }
    const size = decodedBase64Size(
      attachment.previewDataUrl.slice(prefix.length)
    );
    if (size === null || size > MAX_IMAGE_BYTES) {
      return false;
    }
  }
  return true;
}

/** Removes host-only prompt bytes before metadata crosses into the webview. */
export function toAttachmentMetadata(
  attachment: PromptAttachment
): FileAttachment {
  return {
    id: attachment.id,
    uri: attachment.uri,
    name: attachment.name,
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.source ? { source: attachment.source } : {}),
    ...(attachment.kind ? { kind: attachment.kind } : {}),
    ...(attachment.transport ? { transport: attachment.transport } : {}),
    ...(attachment.previewDataUrl
      ? { previewDataUrl: attachment.previewDataUrl }
      : {}),
  };
}
/**
 * Builds one ordered ACP prompt path for links, embedded resources, and image
 * content. User text always precedes attachments. Optional content types are
 * emitted only when the agent explicitly advertised the matching capability.
 */
export function buildPromptContent(
  text: string,
  attachments: readonly PromptAttachment[],
  capabilities: Readonly<PromptCapabilities> = {}
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let inlineBytes = 0;

  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }

  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    if (!isFileAttachmentValid(attachment)) {
      continue;
    }
    if (
      attachment.payload?.type === "image" &&
      attachment.kind === "image" &&
      capabilities.image === true
    ) {
      const size = decodedBase64Size(attachment.payload.data);
      if (
        size !== null &&
        size <= MAX_IMAGE_BYTES &&
        inlineBytes + size <= MAX_INLINE_ATTACHMENT_BYTES &&
        isSupportedImageMimeType(attachment.mimeType)
      ) {
        blocks.push({
          type: "image",
          data: attachment.payload.data,
          mimeType: attachment.mimeType,
        });
        inlineBytes += size;
      }
      continue;
    }
    if (
      attachment.payload?.type === "text" &&
      capabilities.embeddedContext === true
    ) {
      const size = new TextEncoder().encode(attachment.payload.text).byteLength;
      if (
        size <= MAX_EMBEDDED_RESOURCE_BYTES &&
        inlineBytes + size <= MAX_INLINE_ATTACHMENT_BYTES
      ) {
        blocks.push({
          type: "resource",
          resource: {
            uri: attachment.uri,
            text: attachment.payload.text,
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          },
        });
        inlineBytes += size;
      }
      continue;
    }
    if ((attachment.source ?? "file") === "file") {
      blocks.push({
        type: "resource_link",
        uri: attachment.uri,
        name: attachment.name,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      });
    }
  }

  return blocks;
}
