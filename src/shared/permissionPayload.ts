/** File-write approvals include the complete proposed file, not just a label. */
export function isFileWritePermissionPayload(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "tool" in value &&
    value.tool === "write_file"
  );
}

export const MAX_FILE_WRITE_PERMISSION_VALUE_LENGTH = 1_048_576;
export const MAX_FILE_WRITE_PERMISSION_BYTES = 2_097_152;
