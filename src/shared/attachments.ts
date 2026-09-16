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

const EMBEDDABLE_APPLICATION_MIME_TYPES: Readonly<Record<string, true>> = {
  "application/json": true,
  "application/javascript": true,
  "application/xml": true,
  "application/yaml": true,
  "application/sql": true,
  "application/x-httpd-php": true,
  "application/x-sh": true,
};

export function isEmbeddableTextMimeType(
  mimeType: string | undefined
): boolean {
  return (
    mimeType?.startsWith("text/") === true ||
    (mimeType !== undefined &&
      EMBEDDABLE_APPLICATION_MIME_TYPES[mimeType] === true)
  );
}

export type SupportedImageMimeType =
  (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];
export type AttachmentSource = "file" | "memory";
export type AttachmentKind = "file" | "image" | "selection";
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
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_ATTACHMENT_NAME_LENGTH &&
    name === sanitizeAttachmentLabel(name) &&
    typeof uri === "string" &&
    uri.length > 0 &&
    uri.length <= MAX_ATTACHMENT_URI_LENGTH &&
    uri === sanitizeAttachmentLabel(uri) &&
    (mimeType === undefined ||
      (typeof mimeType === "string" &&
        mimeType.length > 0 &&
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

function hasMatchingSelectionName(name: string, uri: string): boolean {
  if (!uri.startsWith("vscode-acp-attachment:///selection/")) {
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

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/** Returns the decoded byte length only for canonical RFC 4648 base64. */
export function decodedBase64Size(data: string): number | null {
  if (typeof data !== "string" || data.length % 4 !== 0) {
    return null;
  }
  if (data.length === 0) {
    return 0;
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bodyLength = data.length - padding;
  for (let index = 0; index < bodyLength; index += 1) {
    if (base64Value(data.charCodeAt(index)) < 0) {
      return null;
    }
  }
  for (let index = bodyLength; index < data.length; index += 1) {
    if (data[index] !== "=") {
      return null;
    }
  }
  if (
    (padding === 2 &&
      (base64Value(data.charCodeAt(bodyLength - 1)) & 0x0f) !== 0) ||
    (padding === 1 &&
      (base64Value(data.charCodeAt(bodyLength - 1)) & 0x03) !== 0)
  ) {
    return null;
  }
  return (data.length / 4) * 3 - padding;
}

export function detectedImageMimeType(
  bytes: Uint8Array
): SupportedImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function decodedBase64Prefix(
  data: string,
  maximumBytes: number
): Uint8Array | null {
  const size = decodedBase64Size(data);
  if (size === null) {
    return null;
  }
  const bytes = new Uint8Array(Math.min(size, maximumBytes));
  let output = 0;
  for (let index = 0; output < bytes.length; index += 4) {
    const first = base64Value(data.charCodeAt(index));
    const second = base64Value(data.charCodeAt(index + 1));
    const third = base64Value(data.charCodeAt(index + 2));
    const fourth = base64Value(data.charCodeAt(index + 3));
    bytes[output++] = (first << 2) | (second >> 4);
    if (output < bytes.length) {
      bytes[output++] = ((second & 0x0f) << 4) | (third >> 2);
    }
    if (output < bytes.length) {
      bytes[output++] = ((third & 0x03) << 6) | fourth;
    }
  }
  return bytes;
}

function detectedBase64ImageMimeType(
  data: string
): SupportedImageMimeType | null {
  const prefix = decodedBase64Prefix(data, 12);
  return prefix ? detectedImageMimeType(prefix) : null;
}

export function isFileAttachmentValid(attachment: FileAttachment): boolean {
  const source = attachment.source ?? "file";
  const kind = attachment.kind ?? "file";
  const transport = attachment.transport;
  if (
    !hasSafeMetadata(
      attachment.name,
      attachment.uri,
      attachment.mimeType,
      attachment.size
    ) ||
    (source !== "file" && source !== "memory") ||
    (kind !== "file" && kind !== "image" && kind !== "selection") ||
    (source === "file"
      ? !hasMatchingCanonicalFileName(attachment.name, attachment.uri)
      : kind === "selection"
        ? !hasMatchingSelectionName(attachment.name, attachment.uri)
        : !hasMatchingMemoryName(attachment.name, attachment.uri)) ||
    (transport !== undefined &&
      transport !== "resource_link" &&
      transport !== "resource" &&
      transport !== "image") ||
    (source === "memory" &&
      transport !== "resource" &&
      transport !== "image") ||
    (transport === "resource_link" && source !== "file") ||
    (transport === "resource" && kind !== "file" && kind !== "selection") ||
    (transport === "image" && kind !== "image") ||
    (kind === "selection" &&
      (source !== "memory" ||
        transport !== "resource" ||
        attachment.mimeType !== "text/plain")) ||
    (kind === "image" && !isSupportedImageMimeType(attachment.mimeType))
  ) {
    return false;
  }

  if (attachment.previewDataUrl !== undefined) {
    if (
      typeof attachment.previewDataUrl !== "string" ||
      kind !== "image" ||
      !isSupportedImageMimeType(attachment.mimeType)
    ) {
      return false;
    }
    const prefix = `data:${attachment.mimeType};base64,`;
    if (!attachment.previewDataUrl.startsWith(prefix)) {
      return false;
    }
    const data = attachment.previewDataUrl.slice(prefix.length);
    if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
      return false;
    }
    const size = decodedBase64Size(data);
    if (
      size === null ||
      size > MAX_IMAGE_BYTES ||
      (attachment.size !== undefined && attachment.size !== size) ||
      detectedBase64ImageMimeType(data) !== attachment.mimeType
    ) {
      return false;
    }
  }
  return true;
}

/** Validates the payload/metadata pair immediately before ACP transport. */
export function isPromptAttachmentValid(attachment: PromptAttachment): boolean {
  if (!isFileAttachmentValid(attachment)) {
    return false;
  }
  const source = attachment.source ?? "file";
  const kind = attachment.kind ?? "file";
  const transport = attachment.transport ?? "resource_link";
  const payload = attachment.payload;

  if (transport === "resource_link") {
    return source === "file" && payload === undefined;
  }
  if (transport === "image") {
    if (
      kind !== "image" ||
      payload?.type !== "image" ||
      typeof payload.data !== "string" ||
      !isSupportedImageMimeType(attachment.mimeType) ||
      payload.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    ) {
      return false;
    }
    const size = decodedBase64Size(payload.data);
    return (
      size !== null &&
      size <= MAX_IMAGE_BYTES &&
      (attachment.size === undefined || attachment.size === size) &&
      detectedBase64ImageMimeType(payload.data) === attachment.mimeType
    );
  }
  if (
    (kind !== "file" && kind !== "selection") ||
    payload?.type !== "text" ||
    typeof payload.text !== "string" ||
    (attachment.mimeType !== undefined &&
      !isEmbeddableTextMimeType(attachment.mimeType)) ||
    payload.text.length > MAX_EMBEDDED_RESOURCE_BYTES
  ) {
    return false;
  }
  return (
    new TextEncoder().encode(payload.text).byteLength <=
    MAX_EMBEDDED_RESOURCE_BYTES
  );
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
 * Builds one ordered ACP prompt path for links, embedded resources, images,
 * and editor selections. User text always precedes attached context.
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
      attachment.transport === "image" &&
      capabilities.image === true &&
      isPromptAttachmentValid(attachment)
    ) {
      const size = decodedBase64Size(attachment.payload.data);
      if (
        size !== null &&
        inlineBytes + size <= MAX_INLINE_ATTACHMENT_BYTES &&
        isSupportedImageMimeType(attachment.mimeType)
      ) {
        blocks.push({
          type: "image",
          data: attachment.payload.data,
          mimeType: attachment.mimeType,
        });
        inlineBytes += size;
        continue;
      }
    }
    if (
      attachment.payload?.type === "text" &&
      attachment.transport === "resource" &&
      isPromptAttachmentValid(attachment)
    ) {
      const size = new TextEncoder().encode(attachment.payload.text).byteLength;
      if (inlineBytes + size <= MAX_INLINE_ATTACHMENT_BYTES) {
        if (capabilities.embeddedContext === true) {
          blocks.push({
            type: "resource",
            resource: {
              uri: attachment.uri,
              text: attachment.payload.text,
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            },
          });
          inlineBytes += size;
          continue;
        }
        if (attachment.kind === "selection") {
          blocks.push({ type: "text", text: attachment.payload.text });
          inlineBytes += size;
          continue;
        }
      }
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
