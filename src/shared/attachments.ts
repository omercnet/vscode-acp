import type { ContentBlock } from "@agentclientprotocol/sdk";

/**
 * Attachment types and limits shared between the extension host
 * (`src/attachments.ts`, `src/views/chat.ts`, `src/acp/client.ts`) and the
 * webview UI (`src/views/webview/main.ts`).
 *
 * This module MUST NOT import "vscode" (or anything else host-only) so it
 * can be bundled directly into the browser-context webview script by
 * esbuild.
 */

/** Maximum number of file attachments allowed on a single prompt turn. */
export const MAX_ATTACHMENTS = 10;

/** Maximum length (UTF-16 code units) for a displayed attachment name. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

/** Maximum length (UTF-16 code units) for an attachment's URI. */
export const MAX_ATTACHMENT_URI_LENGTH = 8192;

/** Maximum length (UTF-16 code units) for an attachment MIME type. */
export const MAX_ATTACHMENT_MIME_LENGTH = 255;

/**
 * Metadata describing a file attachment selected through trusted VS Code
 * file APIs (open editor tabs, `showOpenDialog`). Every field here
 * originates from the local filesystem and MUST be treated as untrusted
 * display data by the webview: render with `textContent`/property
 * assignment only, never through `innerHTML` or string concatenation.
 */
export interface FileAttachment {
  /** Opaque identifier scoped to the current composer draft. */
  id: string;
  /** Canonical resource URI; newly selected attachments use `file://`. */
  uri: string;
  /** Human-readable file name (basename). */
  name: string;
  /** Best-effort MIME type inferred from the file extension, if known. */
  mimeType?: string;
  /** File size in bytes, when available from a filesystem stat. */
  size?: number;
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

/**
 * Characters that must never survive into an attachment label: C0/C1
 * controls (a file name may legally contain newlines and escapes on POSIX)
 * plus the zero-width and bidirectional formatting characters. Left in
 * place they let a file name or an agent-supplied replay label forge chip
 * tooltips, reorder displayed text, or smuggle instructions into the
 * `resource_link.name` an agent feeds to its model.
 */
const UNSAFE_LABEL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Strips control, zero-width, and bidi-override characters from a label. */
export function sanitizeAttachmentLabel(label: string): string {
  return label.replace(UNSAFE_LABEL_CHARS, "");
}

/**
 * Validates attachment metadata against the reasonable size/count
 * boundaries above. Returns `false` for names/URIs that are empty,
 * absurdly long, carry unsafe label characters, or point at anything other
 * than a local file; callers should drop (not truncate) offending entries.
 */
export function isAttachmentMetadataValid(
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
    uri.toLowerCase().startsWith("file://") &&
    (mimeType === undefined ||
      (mimeType.length <= MAX_ATTACHMENT_MIME_LENGTH &&
        mimeType === sanitizeAttachmentLabel(mimeType))) &&
    (size === undefined || (Number.isSafeInteger(size) && size >= 0))
  );
}

/**
 * Builds the ordered `ContentBlock` array for a prompt turn: the user's
 * text first (when non-empty), followed by a `resource_link` block per
 * attachment in selection order. Never reads or embeds file contents -
 * only the reference metadata travels over the wire.
 */
export function buildPromptContent(
  text: string,
  attachments: readonly FileAttachment[]
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }

  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    if (
      !isAttachmentMetadataValid(
        attachment.name,
        attachment.uri,
        attachment.mimeType,
        attachment.size
      )
    ) {
      continue;
    }
    blocks.push({
      type: "resource_link",
      uri: attachment.uri,
      name: attachment.name,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    });
  }

  return blocks;
}
