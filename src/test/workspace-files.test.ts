import * as assert from "assert";
import { execFile } from "child_process";
import { constants } from "fs";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  isPathWithin,
  MAX_WORKSPACE_FILE_BYTES,
  noFollowFlag,
  openTrustedWorkspaceFile,
  readOpenedWorkspaceFile,
  writeOpenedWorkspaceFile,
  WORKSPACE_FILE_ACCESS_DENIED,
  WORKSPACE_FILE_TOO_LARGE,
  workspaceFileCapabilities,
  type WorkspaceFileAccessContext,
  type WorkspaceFileOpenStrategy,
} from "../acp/workspace-files";

const execFileAsync = promisify(execFile);

const isDenied = (error: unknown): boolean =>
  error instanceof Error && error.message === WORKSPACE_FILE_ACCESS_DENIED;

suite("Trusted workspace file access", () => {
  let sandbox: string;
  let workspaceRoot: string;
  let outsideRoot: string;
  let context: WorkspaceFileAccessContext;
  let capabilities: { readTextFile: boolean; writeTextFile: boolean };

  setup(async () => {
    sandbox = await realpath(
      await mkdtemp(path.join(tmpdir(), "vscode-acp-files-"))
    );
    workspaceRoot = path.join(sandbox, "workspace");
    outsideRoot = path.join(sandbox, "outside");
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
    context = {
      isTrusted: true,
      workspaceFolders: [
        { uri: vscode.Uri.file(workspaceRoot) } as vscode.WorkspaceFolder,
      ],
    };
    capabilities = await workspaceFileCapabilities(context);
  });

  teardown(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  test("reads workspace files with every available strategy", async () => {
    const allowedPath = path.join(workspaceRoot, "nested", "allowed.txt");
    await mkdir(path.dirname(allowedPath));
    await writeFile(allowedPath, "allowed");

    const strategies: WorkspaceFileOpenStrategy[] = capabilities.writeTextFile
      ? ["descriptor", "verified"]
      : ["verified"];
    for (const strategy of strategies) {
      const opened = await openTrustedWorkspaceFile(
        allowedPath,
        "read",
        context,
        strategy
      );
      try {
        assert.strictEqual(opened.strategy, strategy);
        assert.strictEqual(
          new TextDecoder().decode(await opened.fileHandle.readFile()),
          "allowed"
        );
      } finally {
        await opened.fileHandle.close();
      }
    }
  });

  test("writes files and creates missing parents only with descriptor containment", async function () {
    if (!capabilities.writeTextFile) {
      this.skip();
    }
    const createdPath = path.join(workspaceRoot, "fresh", "nested", "file.txt");
    const created = await openTrustedWorkspaceFile(
      createdPath,
      "write",
      context,
      "descriptor"
    );
    try {
      await writeOpenedWorkspaceFile(
        created,
        new TextEncoder().encode("created")
      );
    } finally {
      await created.fileHandle.close();
    }
    assert.strictEqual(await readFile(createdPath, "utf8"), "created");

    const truncated = await openTrustedWorkspaceFile(
      createdPath,
      "write",
      context,
      "descriptor"
    );
    try {
      await writeOpenedWorkspaceFile(
        truncated,
        new TextEncoder().encode("new")
      );
    } finally {
      await truncated.fileHandle.close();
    }
    assert.strictEqual(await readFile(createdPath, "utf8"), "new");
  });

  test("leaves an authorized file unchanged when a pre-write check fails", async function () {
    if (!capabilities.writeTextFile) {
      this.skip();
    }
    const filePath = path.join(workspaceRoot, "conflict.txt");
    await writeFile(filePath, "user content");
    const opened = await openTrustedWorkspaceFile(
      filePath,
      "write",
      context,
      "descriptor"
    );
    try {
      await assert.rejects(
        () =>
          writeOpenedWorkspaceFile(
            opened,
            new TextEncoder().encode("agent content"),
            async () => {
              throw new Error("conflict");
            }
          ),
        /conflict/
      );
    } finally {
      await opened.fileHandle.close();
    }
    assert.strictEqual(await readFile(filePath, "utf8"), "user content");
  });

  test("denies portable writes instead of racing path verification", async () => {
    const allowedPath = path.join(workspaceRoot, "allowed.txt");
    await writeFile(allowedPath, "unchanged");

    await assert.rejects(
      () => openTrustedWorkspaceFile(allowedPath, "write", context, "verified"),
      isDenied
    );
    assert.strictEqual(await readFile(allowedPath, "utf8"), "unchanged");
    if (process.platform !== "linux") {
      assert.strictEqual(capabilities.writeTextFile, false);
    }
  });

  test("allows a symlinked directory that stays inside the workspace", async () => {
    const realDir = path.join(workspaceRoot, "real");
    await mkdir(realDir);
    await writeFile(path.join(realDir, "file.txt"), "linked");
    await symlink(realDir, path.join(workspaceRoot, "link"), "dir");

    const opened = await openTrustedWorkspaceFile(
      path.join(workspaceRoot, "link", "file.txt"),
      "read",
      context
    );
    try {
      assert.strictEqual(
        new TextDecoder().decode(await opened.fileHandle.readFile()),
        "linked"
      );
    } finally {
      await opened.fileHandle.close();
    }
  });

  test("denies untrusted, no-workspace, and non-file workspace contexts", async () => {
    const allowedPath = path.join(workspaceRoot, "allowed.txt");
    await writeFile(allowedPath, "allowed");

    for (const denied of [
      { isTrusted: false, workspaceFolders: context.workspaceFolders },
      { isTrusted: true, workspaceFolders: undefined },
      {
        isTrusted: true,
        workspaceFolders: [
          {
            uri: vscode.Uri.parse(
              "vscode-remote://ssh-remote+example/workspace"
            ),
          } as vscode.WorkspaceFolder,
        ],
      },
    ] satisfies WorkspaceFileAccessContext[]) {
      await assert.rejects(
        () => openTrustedWorkspaceFile(allowedPath, "read", denied),
        isDenied
      );
      assert.deepStrictEqual(await workspaceFileCapabilities(denied), {
        readTextFile: false,
        writeTextFile: false,
      });
    }
  });

  test("blocks traversal and URI-shaped input without revealing denied paths", async () => {
    const secretPath = path.join(outsideRoot, "secret.txt");
    await writeFile(secretPath, "secret");

    for (const requestPath of [
      path.join(workspaceRoot, "..", "outside", "secret.txt"),
      vscode.Uri.file(secretPath).toString(),
      `${workspaceRoot}\0/allowed.txt`,
    ]) {
      await assert.rejects(
        () => openTrustedWorkspaceFile(requestPath, "read", context),
        (error: unknown) =>
          isDenied(error) && !(error as Error).message.includes(secretPath)
      );
    }
  });

  test("blocks read and write requests that escape through a symlink", async () => {
    const secretPath = path.join(outsideRoot, "secret.txt");
    const linkPath = path.join(workspaceRoot, "outside-link.txt");
    const danglingPath = path.join(workspaceRoot, "dangling-link.txt");
    const linkedDirPath = path.join(workspaceRoot, "outside-dir");
    await writeFile(secretPath, "secret");
    await symlink(secretPath, linkPath);
    await symlink(path.join(outsideRoot, "missing.txt"), danglingPath);
    await symlink(outsideRoot, linkedDirPath, "dir");

    for (const operation of ["read", "write"] as const) {
      for (const requestPath of [
        linkPath,
        danglingPath,
        path.join(linkedDirPath, "secret.txt"),
      ]) {
        await assert.rejects(
          () => openTrustedWorkspaceFile(requestPath, operation, context),
          isDenied
        );
      }
    }
    assert.strictEqual(await readFile(secretPath, "utf8"), "secret");
  });

  test("keeps the pinned root trusted when its path is replaced", async () => {
    const secretPath = path.join(outsideRoot, "secret.txt");
    const originalRoot = path.join(sandbox, "workspace-original");
    await writeFile(secretPath, "secret");
    await rename(workspaceRoot, originalRoot);
    await symlink(outsideRoot, workspaceRoot, "dir");

    await assert.rejects(
      () =>
        openTrustedWorkspaceFile(
          path.join(workspaceRoot, "secret.txt"),
          "read",
          context
        ),
      isDenied
    );
    await assert.rejects(
      () =>
        openTrustedWorkspaceFile(
          path.join(workspaceRoot, "new.txt"),
          "write",
          context
        ),
      isDenied
    );
    assert.strictEqual(await readFile(secretPath, "utf8"), "secret");
    await assert.rejects(() => readFile(path.join(outsideRoot, "new.txt")));
  });

  test("binds each strategy open to the pre-spawn root identity", async () => {
    const cases: Array<{
      strategy: WorkspaceFileOpenStrategy;
      operation: "read" | "write";
    }> = [{ strategy: "verified", operation: "read" }];
    if (capabilities.writeTextFile) {
      cases.push(
        { strategy: "descriptor", operation: "read" },
        { strategy: "descriptor", operation: "write" }
      );
    }

    for (const { strategy, operation } of cases) {
      const label = `${strategy}-${operation}`;
      const root = path.join(sandbox, `root-${label}`);
      const original = path.join(sandbox, `root-${label}-original`);
      const replacement = path.join(sandbox, `root-${label}-replacement`);
      const requestedPath = path.join(root, "target.txt");
      const replacementPath = path.join(replacement, "target.txt");
      await mkdir(root);
      await mkdir(replacement);
      await writeFile(requestedPath, "inside");
      await writeFile(replacementPath, "replacement");
      const raceContext: WorkspaceFileAccessContext = {
        isTrusted: true,
        workspaceFolders: [
          { uri: vscode.Uri.file(root) } as vscode.WorkspaceFolder,
        ],
        beforeStrategyOpen: async () => {
          await rename(root, original);
          await rename(replacement, root);
        },
      };
      await workspaceFileCapabilities(raceContext);

      await assert.rejects(
        () =>
          openTrustedWorkspaceFile(
            requestedPath,
            operation,
            raceContext,
            strategy
          ),
        isDenied
      );
      assert.strictEqual(
        await readFile(path.join(root, "target.txt"), "utf8"),
        "replacement"
      );
    }
  });

  test("detects a verified ancestor swap before returning bytes", async () => {
    const nested = path.join(workspaceRoot, "nested");
    const originalNested = path.join(workspaceRoot, "nested-original");
    const requestedPath = path.join(nested, "secret.txt");
    const outsidePath = path.join(outsideRoot, "secret.txt");
    await mkdir(nested);
    await writeFile(requestedPath, "inside");
    await writeFile(outsidePath, "outside-secret");

    const raceContext: WorkspaceFileAccessContext = {
      ...context,
      beforeVerifiedOpen: async () => {
        await rename(nested, originalNested);
        await symlink(outsideRoot, nested, "dir");
      },
    };

    await assert.rejects(
      () =>
        openTrustedWorkspaceFile(
          requestedPath,
          "read",
          raceContext,
          "verified"
        ),
      isDenied
    );
    assert.strictEqual(await readFile(outsidePath, "utf8"), "outside-secret");
  });

  test("allows hard-link reads but denies destructive writes", async () => {
    const secretPath = path.join(outsideRoot, "secret.txt");
    const aliasPath = path.join(workspaceRoot, "alias.txt");
    await writeFile(secretPath, "secret");
    await link(secretPath, aliasPath);

    const opened = await openTrustedWorkspaceFile(aliasPath, "read", context);
    try {
      assert.strictEqual(
        new TextDecoder().decode(await opened.fileHandle.readFile()),
        "secret"
      );
    } finally {
      await opened.fileHandle.close();
    }
    await assert.rejects(
      () => openTrustedWorkspaceFile(aliasPath, "write", context),
      isDenied
    );
    assert.strictEqual(await readFile(secretPath, "utf8"), "secret");
  });

  test("denies the workspace root and directory targets", async () => {
    const directory = path.join(workspaceRoot, "nested");
    await mkdir(directory);

    await assert.rejects(
      () => openTrustedWorkspaceFile(workspaceRoot, "read", context),
      isDenied
    );
    await assert.rejects(
      () => openTrustedWorkspaceFile(directory, "read", context),
      isDenied
    );
  });

  test("denies non-regular files without blocking", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const fifoPath = path.join(workspaceRoot, "pipe");
    await execFileAsync("mkfifo", [fifoPath]);

    await assert.rejects(
      () => openTrustedWorkspaceFile(fifoPath, "read", context),
      isDenied
    );
    await assert.rejects(
      () => openTrustedWorkspaceFile(fifoPath, "write", context),
      isDenied
    );
  });

  test("reports missing files as ENOENT against the requested path", async () => {
    const missingPath = path.join(workspaceRoot, "missing", "file.txt");

    await assert.rejects(
      () => openTrustedWorkspaceFile(missingPath, "read", context),
      (error: unknown) => {
        const errno = error as NodeJS.ErrnoException;
        return (
          errno.code === "ENOENT" &&
          errno.path === missingPath &&
          !errno.message.includes("/proc/")
        );
      }
    );
  });

  test("rejects oversized reads before allocating their contents", async () => {
    const largePath = path.join(workspaceRoot, "large.txt");
    await writeFile(largePath, "");
    await truncate(largePath, MAX_WORKSPACE_FILE_BYTES + 1);

    await assert.rejects(
      () => openTrustedWorkspaceFile(largePath, "read", context),
      (error: unknown) =>
        error instanceof Error && error.message === WORKSPACE_FILE_TOO_LARGE
    );
  });

  test("stops a file that grows after its descriptor is authorized", async () => {
    const growingPath = path.join(workspaceRoot, "growing.txt");
    await writeFile(growingPath, "small");
    const opened = await openTrustedWorkspaceFile(growingPath, "read", context);
    try {
      await truncate(growingPath, MAX_WORKSPACE_FILE_BYTES + 1);
      await assert.rejects(
        () => readOpenedWorkspaceFile(opened),
        (error: unknown) =>
          error instanceof Error && error.message === WORKSPACE_FILE_TOO_LARGE
      );
    } finally {
      await opened.fileHandle.close();
    }
  });

  test("refuses symlinks with a host-verified O_NOFOLLOW value", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const targetPath = path.join(workspaceRoot, "target.txt");
    const linkPath = path.join(workspaceRoot, "link.txt");
    await writeFile(targetPath, "target");
    await symlink(targetPath, linkPath);

    const flag = await noFollowFlag();
    assert.notStrictEqual(flag, 0);
    await assert.rejects(
      () => open(linkPath, constants.O_RDONLY | flag),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP"
    );
  });

  test("contains POSIX and Windows paths by components, not prefixes", () => {
    assert.ok(isPathWithin("/workspace", "/workspace/src/file.ts"));
    assert.ok(!isPathWithin("/workspace", "/workspace-private/file.ts"));
    assert.ok(
      isPathWithin("C:\\Workspace", "c:\\workspace\\src\\file.ts", path.win32)
    );
    assert.ok(
      !isPathWithin(
        "C:\\Workspace",
        "C:\\Workspace-private\\file.ts",
        path.win32
      )
    );
    assert.ok(
      !isPathWithin("C:\\Workspace", "\\\\server\\share\\file.ts", path.win32)
    );
    assert.ok(
      isPathWithin(
        "\\\\server\\share\\workspace",
        "\\\\server\\share\\workspace\\file.ts",
        path.win32
      )
    );
  });
});
