import * as assert from "assert";
import * as vscode from "vscode";
import { canonicalFileUri, guessMimeType } from "../attachments";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_MIME_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENT_URI_LENGTH,
  buildPromptContent,
  isAttachmentMetadataValid,
  type FileAttachment,
} from "../shared/attachments";

function attachment(
  id: string,
  uri: string,
  name: string,
  overrides: Partial<FileAttachment> = {}
): FileAttachment {
  return {
    id,
    uri,
    name,
    ...overrides,
  };
}

suite("Resource link attachments", () => {
  suite("canonicalFileUri", () => {
    test("encodes POSIX paths with spaces and non-ASCII characters", () => {
      const uri = vscode.Uri.from({
        scheme: "file",
        path: "/home/alice/My résumé.ts",
      });

      assert.strictEqual(
        canonicalFileUri(uri),
        "file:///home/alice/My%20r%C3%A9sum%C3%A9.ts"
      );
    });

    test("canonicalizes Windows drive-letter file URI form", () => {
      const uri = vscode.Uri.from({
        scheme: "file",
        path: "/C:/Users/Alice/My File.ts",
      });

      assert.strictEqual(
        canonicalFileUri(uri),
        "file:///c%3A/Users/Alice/My%20File.ts"
      );
    });

    test("preserves UNC authority and encodes share paths", () => {
      const uri = vscode.Uri.from({
        scheme: "file",
        authority: "server",
        path: "/share/My File.ts",
      });

      assert.strictEqual(
        canonicalFileUri(uri),
        "file://server/share/My%20File.ts"
      );
    });
  });

  suite("metadata", () => {
    test("infers common MIME types without reading file content", () => {
      assert.strictEqual(guessMimeType("component.TSX"), "text/typescript");
      assert.strictEqual(guessMimeType("document.pdf"), "application/pdf");
      assert.strictEqual(guessMimeType("LICENSE"), undefined);
    });

    test("rejects empty or excessive name and URI metadata", () => {
      assert.strictEqual(
        isAttachmentMetadataValid("file.ts", "file:///x"),
        true
      );
      assert.strictEqual(isAttachmentMetadataValid("", "file:///x"), false);
      assert.strictEqual(
        isAttachmentMetadataValid(
          "a".repeat(MAX_ATTACHMENT_NAME_LENGTH + 1),
          "file:///x"
        ),
        false
      );
      assert.strictEqual(
        isAttachmentMetadataValid(
          "file.ts",
          "x".repeat(MAX_ATTACHMENT_URI_LENGTH + 1)
        ),
        false
      );
      assert.strictEqual(
        isAttachmentMetadataValid(
          "file.ts",
          "file:///x",
          "x".repeat(MAX_ATTACHMENT_MIME_LENGTH + 1)
        ),
        false
      );
      assert.strictEqual(
        isAttachmentMetadataValid(
          "file.ts",
          "file:///x",
          "text/typescript",
          -1
        ),
        false
      );
      assert.strictEqual(
        isAttachmentMetadataValid(
          "file.ts",
          "file:///x",
          "text/typescript",
          Number.MAX_SAFE_INTEGER + 1
        ),
        false
      );
    });
  });

  suite("buildPromptContent", () => {
    const first = attachment("a", "file:///workspace/a.ts", "a.ts", {
      mimeType: "text/typescript",
      size: 123,
    });
    const second = attachment("b", "file:///workspace/b.json", "b.json", {
      mimeType: "application/json",
      size: 456,
    });

    test("orders user text before resource links", () => {
      const blocks = buildPromptContent("Review these files", [first, second]);

      assert.deepStrictEqual(blocks, [
        { type: "text", text: "Review these files" },
        {
          type: "resource_link",
          uri: "file:///workspace/a.ts",
          name: "a.ts",
          mimeType: "text/typescript",
          size: 123,
        },
        {
          type: "resource_link",
          uri: "file:///workspace/b.json",
          name: "b.json",
          mimeType: "application/json",
          size: 456,
        },
      ]);
    });

    test("supports an attachment-only prompt without an empty text block", () => {
      const blocks = buildPromptContent("", [first]);

      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(blocks[0].type, "resource_link");
    });

    test("uses JSON-serializable integer metadata supported by ACP", () => {
      const blocks = buildPromptContent("", [first]);

      assert.doesNotThrow(() => JSON.stringify(blocks));
      const firstBlock = blocks[0];
      assert.ok("size" in firstBlock);
      assert.strictEqual(typeof firstBlock.size, "number");
    });

    test("drops resource links with invalid metadata", () => {
      const blocks = buildPromptContent("Keep the text", [
        attachment("invalid", "file:///workspace/invalid.ts", "invalid.ts", {
          size: -1,
        }),
      ]);

      assert.deepStrictEqual(blocks, [{ type: "text", text: "Keep the text" }]);
    });
    test("caps resource links at the attachment boundary", () => {
      const attachments = Array.from(
        { length: MAX_ATTACHMENTS + 3 },
        (_, index) =>
          attachment(
            `att-${index}`,
            `file:///workspace/${index}.ts`,
            `${index}.ts`
          )
      );

      const blocks = buildPromptContent("", attachments);
      assert.strictEqual(blocks.length, MAX_ATTACHMENTS);
    });
  });
});
