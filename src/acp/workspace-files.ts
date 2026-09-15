import { Buffer } from "buffer";
import { constants, type Stats } from "fs";
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export const WORKSPACE_FILE_ACCESS_DENIED =
  "ACP file access is restricted to trusted workspace files.";

export const WORKSPACE_FILE_TOO_LARGE =
  "ACP file access is restricted to files under 16 MiB.";

/** Largest file ACP may pull into the extension host in one read. */
export const MAX_WORKSPACE_FILE_BYTES = 16 * 1024 * 1024;

export class WorkspaceFileAccessDeniedError extends Error {
  constructor() {
    super(WORKSPACE_FILE_ACCESS_DENIED);
    this.name = "WorkspaceFileAccessDeniedError";
  }
}

export class WorkspaceFileTooLargeError extends Error {
  constructor() {
    super(WORKSPACE_FILE_TOO_LARGE);
    this.name = "WorkspaceFileTooLargeError";
  }
}

export type WorkspaceFileOperation = "read" | "write";

/**
 * `descriptor` resolves and opens every component below the workspace root
 * relative to an open directory descriptor through `/proc/self/fd`, which is
 * how Linux expresses `openat` from Node. `verified` is the portable
 * equivalent for macOS, Windows and Linux without `/proc`: every component is
 * identity-pinned (`dev`/`ino`) before the open and re-checked afterwards, the
 * open itself carries no destructive flag, and a write only truncates through
 * the descriptor once containment has been re-established.
 */
export type WorkspaceFileOpenStrategy = "descriptor" | "verified";

export interface WorkspaceFileAccessContext {
  isTrusted: boolean;
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  /** Test-only barrier between root validation and the strategy open. */
  beforeStrategyOpen?: () => Promise<void>;
  /** Test-only barrier for deterministic verified-strategy race coverage. */
  beforeVerifiedOpen?: () => Promise<void>;
}

export interface OpenedWorkspaceFile {
  /** The request path normalized as a VS Code file URI. */
  requestUri: vscode.Uri;
  /**
   * The canonical local path that was authorized. Kept as the raw `realpath`
   * string: routing it through `vscode.Uri` lowercases the Windows drive
   * letter and would no longer compare equal to the canonical root.
   */
  canonicalPath: string;
  /** Canonical path of the trusted workspace root that authorized the file. */
  canonicalRootPath: string;
  fileHandle: FileHandle;
  /** Containment strategy that produced the descriptor. */
  strategy: WorkspaceFileOpenStrategy;
  /** Size of the opened file at verification time. */
  byteLength: number;
}

/** Keeps `open` from blocking on a FIFO an agent planted inside the tree. */
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Electron's bundled `fs.constants` carry the x86 values of the
 * architecture-specific O_* block on some Linux builds: on arm64 the reported
 * `O_NOFOLLOW` is really `O_LARGEFILE`, so passing it silently follows
 * symlinks, and the reported `O_DIRECTORY` is really `O_DIRECT`, which fails
 * directory opens with EINVAL. Probe both against `/proc` rather than trusting
 * the constants.
 */
const NO_FOLLOW_CANDIDATES = [
  constants.O_NOFOLLOW ?? 0,
  0o400000, // x86, x86_64, ia64
  0o100000, // asm-generic: arm, arm64, riscv, mips
];
const DIRECTORY_CANDIDATES = [
  constants.O_DIRECTORY ?? 0,
  0o200000, // x86, x86_64, ia64
  0o40000, // asm-generic: arm, arm64, riscv, mips
];
/** Linux UAPI value, stable across supported architectures. */
const O_PATH = 0o10000000;

let noFollowFlagValue: Promise<number> | undefined;
let directoryFlagValue: Promise<number> | undefined;
let pathOnlySupport: Promise<boolean> | undefined;
let descriptorSupport: Promise<boolean> | undefined;

interface RootIdentity {
  dev: number;
  ino: number;
}

/**
 * Trust anchor per configured workspace folder. Capability negotiation pins
 * the folder the user opened before an ACP request can arrive; a later rename
 * plus a symlink or junction in its place cannot redefine the boundary.
 */
const pinnedRootIdentities = new Map<string, RootIdentity>();

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined);
}

function sameEntry(left: Stats, right: RootIdentity): boolean {
  // A filesystem that cannot report an inode cannot prove identity, and an
  // unprovable identity must deny rather than skip the comparison.
  return (
    left.ino !== 0 &&
    right.ino !== 0 &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

async function probeNoFollowFlag(): Promise<number> {
  if (process.platform !== "linux") {
    return constants.O_NOFOLLOW ?? 0;
  }
  for (const candidate of NO_FOLLOW_CANDIDATES) {
    if (!candidate) {
      continue;
    }
    let handle: FileHandle | undefined;
    try {
      // `/proc/self/exe` is always a symlink when /proc is mounted.
      handle = await open("/proc/self/exe", constants.O_RDONLY | candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        return candidate;
      }
      continue;
    }
    // The flag was accepted and the symlink was followed: wrong value.
    await closeQuietly(handle);
  }
  // Nothing could be proven; the caller must not rely on the flag.
  return 0;
}

async function probeDirectoryFlag(): Promise<number> {
  if (process.platform !== "linux") {
    return constants.O_DIRECTORY ?? 0;
  }
  for (const candidate of DIRECTORY_CANDIDATES) {
    if (!candidate) {
      continue;
    }
    let directory: FileHandle | undefined;
    try {
      directory = await open(
        "/proc/self/fd",
        constants.O_RDONLY | candidate | O_NONBLOCK
      );
    } catch {
      continue;
    }
    await closeQuietly(directory);

    let regular: FileHandle | undefined;
    try {
      regular = await open(
        "/proc/self/status",
        constants.O_RDONLY | candidate | O_NONBLOCK
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
        return candidate;
      }
      continue;
    }
    // A regular file opened with the candidate: it is not O_DIRECTORY.
    await closeQuietly(regular);
  }
  return 0;
}

/**
 * Resolves the real `O_NOFOLLOW` for this platform, or `0` when no value could
 * be proven. Exported so the suite can assert the flag actually refuses
 * symlinks on the host architecture.
 */
export function noFollowFlag(): Promise<number> {
  noFollowFlagValue ??= probeNoFollowFlag();
  return noFollowFlagValue;
}

function directoryFlag(): Promise<number> {
  directoryFlagValue ??= probeDirectoryFlag();
  return directoryFlagValue;
}

function supportsPathOnlyOpen(): Promise<boolean> {
  if (process.platform !== "linux") {
    return Promise.resolve(false);
  }
  pathOnlySupport ??= noFollowFlag().then(async (noFollow) => {
    if (!noFollow) {
      return false;
    }
    let handle: FileHandle | undefined;
    try {
      handle = await open("/proc/self/exe", O_PATH | noFollow | O_NONBLOCK);
      return (await handle.stat()).isSymbolicLink();
    } catch {
      return false;
    } finally {
      await closeQuietly(handle);
    }
  });
  return pathOnlySupport;
}

/**
 * The descriptor strategy needs `/proc/self/fd` to express `openat`, plus
 * proven no-follow and directory-only flags. Anything else degrades to the
 * portable `verified` strategy instead of losing filesystem access entirely.
 */
function supportsDescriptorStrategy(): Promise<boolean> {
  if (process.platform !== "linux") {
    return Promise.resolve(false);
  }
  descriptorSupport ??= Promise.all([
    access("/proc/self/fd", constants.X_OK).then(
      () => true,
      () => false
    ),
    noFollowFlag(),
    directoryFlag(),
    supportsPathOnlyOpen(),
  ]).then(([hasProc, noFollow, directory, pathOnly]) =>
    Boolean(hasProc && noFollow && directory && pathOnly)
  );
  return descriptorSupport;
}

export function isPathWithin(
  rootPath: string,
  candidatePath: string,
  pathApi: typeof path = path
): boolean {
  const relative = pathApi.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${pathApi.sep}`) &&
      relative !== ".." &&
      !pathApi.isAbsolute(relative))
  );
}

/**
 * Canonicalizes a request below `basePath`, which is either a real directory
 * path or a `/proc/self/fd/N` anchor. Components that do not exist yet are
 * kept for the open to create; an entry that exists but cannot be resolved is
 * a dangling link and stays denied.
 */
export async function canonicalizeUnder(
  basePath: string,
  relativeRequestPath: string
): Promise<string> {
  const missingSegments: string[] = [];
  let current = path.join(basePath, relativeRequestPath);

  while (current !== basePath) {
    try {
      return path.join(await realpath(current), ...missingSegments);
    } catch (realpathError) {
      if ((realpathError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw realpathError;
      }
    }

    // `realpath` also reports ENOENT for a link whose target is missing. Such
    // an entry must stay denied instead of being treated as a new file.
    try {
      await lstat(current);
      throw new WorkspaceFileAccessDeniedError();
    } catch (lstatError) {
      if (lstatError instanceof WorkspaceFileAccessDeniedError) {
        throw lstatError;
      }
      if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw lstatError;
      }
    }

    missingSegments.unshift(path.basename(current));
    current = path.dirname(current);
  }

  return path.join(await realpath(basePath), ...missingSegments);
}

async function inspectTrustedRoot(configuredPath: string): Promise<{
  canonicalRootPath: string;
  stats: Stats;
}> {
  const canonicalRootPath = await realpath(configuredPath);
  const stats = await lstat(canonicalRootPath);
  if (!stats.isDirectory() || stats.ino === 0) {
    throw new WorkspaceFileAccessDeniedError();
  }
  return { canonicalRootPath, stats };
}

async function pinTrustedRoot(configuredPath: string): Promise<boolean> {
  try {
    const { stats } = await inspectTrustedRoot(configuredPath);
    const pinned = pinnedRootIdentities.get(configuredPath);
    if (!pinned) {
      pinnedRootIdentities.set(configuredPath, {
        dev: stats.dev,
        ino: stats.ino,
      });
      return true;
    }
    return sameEntry(stats, pinned);
  } catch {
    return false;
  }
}

export interface WorkspaceFileCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
}

/** Pins current trusted roots and returns capabilities safe to advertise. */
export async function workspaceFileCapabilities(
  context: WorkspaceFileAccessContext = vscode.workspace
): Promise<WorkspaceFileCapabilities> {
  if (!context.isTrusted || !context.workspaceFolders?.length) {
    return { readTextFile: false, writeTextFile: false };
  }

  const localRoots = context.workspaceFolders.filter(
    (folder) => folder.uri.scheme === "file"
  );
  const pinned = await Promise.all(
    localRoots.map((folder) => pinTrustedRoot(folder.uri.fsPath))
  );
  const canRead = pinned.some(Boolean);
  return {
    readTextFile: canRead,
    // Portable path verification can safely authorize reads before bytes are
    // returned, but Node has no portable handle-relative primitive for a
    // side-effect-free create or overwrite.
    writeTextFile: canRead && (await supportsDescriptorStrategy()),
  };
}

async function canonicalTrustedRoot(configuredPath: string): Promise<{
  canonicalRootPath: string;
  rootIdentity: RootIdentity;
}> {
  const rootIdentity = pinnedRootIdentities.get(configuredPath);
  if (!rootIdentity) {
    throw new WorkspaceFileAccessDeniedError();
  }
  const { canonicalRootPath, stats } = await inspectTrustedRoot(configuredPath);
  if (!sameEntry(stats, rootIdentity)) {
    throw new WorkspaceFileAccessDeniedError();
  }
  return { canonicalRootPath, rootIdentity };
}

function containedSegments(
  canonicalRootPath: string,
  canonicalPath: string
): string[] {
  if (
    !isPathWithin(canonicalRootPath, canonicalPath) ||
    path.relative(canonicalRootPath, canonicalPath) === ""
  ) {
    throw new WorkspaceFileAccessDeniedError();
  }
  return path
    .relative(canonicalRootPath, canonicalPath)
    .split(path.sep)
    .filter(Boolean);
}

async function openFlags(operation: WorkspaceFileOperation): Promise<number> {
  // No O_TRUNC: truncation happens through the descriptor after containment
  // has been verified, so a raced final component cannot be destroyed first.
  const shared = (await noFollowFlag()) | O_NONBLOCK;
  return operation === "read"
    ? constants.O_RDONLY | shared
    : constants.O_WRONLY | constants.O_CREAT | shared;
}

/**
 * Directories, FIFOs, sockets and devices are never ACP text files. Writes
 * also reject multiply-linked files because truncating one alias would modify
 * every peer, which may include a path outside the workspace.
 */
function assertRegularFile(
  stats: Stats,
  operation: WorkspaceFileOperation
): void {
  if (!stats.isFile() || (operation === "write" && stats.nlink !== 1)) {
    throw new WorkspaceFileAccessDeniedError();
  }
}

async function assertRegularEntry(
  entryPath: string,
  operation: WorkspaceFileOperation
): Promise<void> {
  try {
    assertRegularFile(await lstat(entryPath), operation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function openDescriptorFile(
  finalPath: string,
  operation: WorkspaceFileOperation
): Promise<FileHandle> {
  const noFollow = await noFollowFlag();
  let pinned: FileHandle | undefined;
  try {
    pinned = await open(finalPath, O_PATH | noFollow | O_NONBLOCK);
  } catch (error) {
    if (
      operation !== "write" ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
    let created: FileHandle | undefined;
    try {
      created = await open(
        finalPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          noFollow |
          O_NONBLOCK,
        0o666
      );
      assertRegularFile(await created.stat(), "write");
      return created;
    } catch (createError) {
      await closeQuietly(created);
      if ((createError as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceFileAccessDeniedError();
      }
      throw createError;
    }
  }

  try {
    const pinnedStats = await pinned.stat();
    assertRegularFile(pinnedStats, operation);
    const flags =
      (operation === "read" ? constants.O_RDONLY : constants.O_WRONLY) |
      O_NONBLOCK;
    const fileHandle = await open(`/proc/self/fd/${pinned.fd}`, flags);
    try {
      const openedStats = await fileHandle.stat();
      assertRegularFile(openedStats, operation);
      if (!sameEntry(openedStats, pinnedStats)) {
        throw new WorkspaceFileAccessDeniedError();
      }
      return fileHandle;
    } catch (error) {
      await closeQuietly(fileHandle);
      throw error;
    }
  } finally {
    await closeQuietly(pinned);
  }
}

async function openViaDescriptors(
  canonicalRootPath: string,
  canonicalPath: string,
  rootIdentity: RootIdentity,
  operation: WorkspaceFileOperation
): Promise<FileHandle> {
  const directoryFlags =
    constants.O_RDONLY |
    O_NONBLOCK |
    (await noFollowFlag()) |
    (await directoryFlag());
  const directories: FileHandle[] = [];
  try {
    let parent = await open(canonicalRootPath, directoryFlags);
    directories.push(parent);
    if (
      !sameEntry(await parent.stat(), rootIdentity) ||
      (await realpath(`/proc/self/fd/${parent.fd}`)) !== canonicalRootPath
    ) {
      throw new WorkspaceFileAccessDeniedError();
    }

    const segments = containedSegments(canonicalRootPath, canonicalPath);
    const finalSegment = segments.pop() as string;
    for (const segment of segments) {
      const segmentPath = `/proc/self/fd/${parent.fd}/${segment}`;
      let child: FileHandle;
      try {
        child = await open(segmentPath, directoryFlags);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (operation !== "write" || code !== "ENOENT") {
          throw error;
        }
        // VS Code's own writeFile creates missing parents; the descriptor walk
        // keeps that behaviour inside the root.
        await mkdir(segmentPath);
        child = await open(segmentPath, directoryFlags);
      }
      directories.push(child);
      parent = child;
    }

    // O_PATH acquires the entry without invoking a FIFO or device open handler;
    // the I/O descriptor is then reopened from that pinned regular inode.
    const finalPath = `/proc/self/fd/${parent.fd}/${finalSegment}`;
    return await openDescriptorFile(finalPath, operation);
  } finally {
    await Promise.all(directories.map(closeQuietly));
  }
}

/**
 * Pins every directory between the root and the target by identity. Node
 * exposes no `openat` and `/dev/fd/N` on macOS cannot resolve relative
 * children, so containment is re-established against these identities after
 * the open instead of being carried by a descriptor.
 */
async function pinComponents(
  canonicalRootPath: string,
  canonicalPath: string,
  rootIdentity: RootIdentity
): Promise<{ entryPath: string; stats: Stats }[]> {
  const segments = containedSegments(canonicalRootPath, canonicalPath);
  segments.pop();

  const pinned: { entryPath: string; stats: Stats }[] = [];
  let entryPath = canonicalRootPath;
  const rootStats = await lstat(entryPath);
  if (!sameEntry(rootStats, rootIdentity)) {
    throw new WorkspaceFileAccessDeniedError();
  }
  pinned.push({ entryPath, stats: rootStats });

  for (const segment of segments) {
    entryPath = path.join(entryPath, segment);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.ino === 0) {
      throw new WorkspaceFileAccessDeniedError();
    }
    pinned.push({ entryPath, stats });
  }
  return pinned;
}

async function assertComponentsUnchanged(
  pinned: { entryPath: string; stats: Stats }[]
): Promise<void> {
  for (const component of pinned) {
    const current = await lstat(component.entryPath);
    if (current.isSymbolicLink() || !sameEntry(current, component.stats)) {
      throw new WorkspaceFileAccessDeniedError();
    }
  }
}

async function openVerified(
  canonicalRootPath: string,
  canonicalPath: string,
  rootIdentity: RootIdentity,
  beforeOpen?: () => Promise<void>
): Promise<FileHandle> {
  const pinned = await pinComponents(
    canonicalRootPath,
    canonicalPath,
    rootIdentity
  );
  await assertRegularEntry(canonicalPath, "read");

  await beforeOpen?.();
  const handle = await open(canonicalPath, await openFlags("read"));
  try {
    const opened = await handle.stat();
    assertRegularFile(opened, "read");
    // Re-establish the whole chain: a redirected ancestor changes identity, and
    // a replaced final component no longer matches the opened descriptor.
    await assertComponentsUnchanged(pinned);
    const current = await lstat(canonicalPath);
    if (current.isSymbolicLink() || !sameEntry(opened, current)) {
      throw new WorkspaceFileAccessDeniedError();
    }
    return handle;
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
}

/**
 * Maps containment failures to a redacted denial and rewrites any canonical or
 * `/proc` path in a genuine filesystem error back to the requested path, so an
 * authorized-but-failing operation keeps its errno without disclosing host
 * layout the agent did not already supply.
 */
function toAccessError(error: unknown, requestPath: string): unknown {
  if (
    error instanceof WorkspaceFileAccessDeniedError ||
    error instanceof WorkspaceFileTooLargeError
  ) {
    return error;
  }
  if (typeof error !== "object" || error === null) {
    return error;
  }
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ELOOP" || errno.code === "ENXIO") {
    return new WorkspaceFileAccessDeniedError();
  }
  if (
    typeof errno.path === "string" &&
    typeof errno.message === "string" &&
    errno.path !== requestPath
  ) {
    errno.message = errno.message.split(errno.path).join(requestPath);
    errno.path = requestPath;
  }
  return error;
}

/**
 * Opens an ACP path only when it stays inside a trusted local workspace folder
 * through canonicalization and through the open itself. Write opens do not
 * truncate an existing file; callers must use `writeOpenedWorkspaceFile` after
 * their own conflict checks. ACP exposes filesystem paths rather than URIs, so
 * non-file and virtual workspace providers are denied rather than coerced into
 * a local path.
 * `beforeWriteOpen` checks the canonical target before any missing file or
 * parents can be created; descriptor conflicts must also be checked before
 * replacement, because opening the file can yield to editor events.
 */
export async function openTrustedWorkspaceFile(
  requestPath: string,
  operation: WorkspaceFileOperation,
  context: WorkspaceFileAccessContext = vscode.workspace,
  strategy?: WorkspaceFileOpenStrategy,
  beforeWriteOpen?: (canonicalPath: string) => Promise<void>
): Promise<OpenedWorkspaceFile> {
  const workspaceFolders = context.workspaceFolders;
  if (
    !context.isTrusted ||
    !workspaceFolders?.length ||
    requestPath.includes("\0") ||
    !path.isAbsolute(requestPath)
  ) {
    throw new WorkspaceFileAccessDeniedError();
  }
  const requestUri = vscode.Uri.file(requestPath);

  const descriptorAvailable = await supportsDescriptorStrategy();
  const selected =
    strategy ?? (descriptorAvailable ? "descriptor" : "verified");
  if (
    (selected === "descriptor" && !descriptorAvailable) ||
    (selected === "verified" && operation === "write")
  ) {
    throw new WorkspaceFileAccessDeniedError();
  }

  for (const workspaceFolder of workspaceFolders) {
    if (
      workspaceFolder.uri.scheme !== "file" ||
      !isPathWithin(workspaceFolder.uri.fsPath, requestUri.fsPath)
    ) {
      continue;
    }

    let canonicalRootPath: string;
    let rootIdentity: RootIdentity;
    let canonicalPath: string;
    try {
      ({ canonicalRootPath, rootIdentity } = await canonicalTrustedRoot(
        workspaceFolder.uri.fsPath
      ));
      canonicalPath = await canonicalizeUnder(
        canonicalRootPath,
        path.relative(workspaceFolder.uri.fsPath, requestUri.fsPath)
      );
      containedSegments(canonicalRootPath, canonicalPath);
    } catch {
      // A root that cannot be canonicalized, or a request that escapes it,
      // must not authorize the file through another root either.
      continue;
    }

    // Opening a write can create the file and parents, even without O_TRUNC.
    if (operation === "write") {
      await beforeWriteOpen?.(canonicalPath);
    }

    let fileHandle: FileHandle;
    await context.beforeStrategyOpen?.();
    try {
      fileHandle =
        selected === "descriptor"
          ? await openViaDescriptors(
              canonicalRootPath,
              canonicalPath,
              rootIdentity,
              operation
            )
          : await openVerified(
              canonicalRootPath,
              canonicalPath,
              rootIdentity,
              context.beforeVerifiedOpen
            );
    } catch (error) {
      throw toAccessError(error, requestPath);
    }

    try {
      const byteLength = (await fileHandle.stat()).size;
      if (operation === "read" && byteLength > MAX_WORKSPACE_FILE_BYTES) {
        throw new WorkspaceFileTooLargeError();
      }
      return {
        requestUri,
        canonicalPath,
        canonicalRootPath,
        fileHandle,
        strategy: selected,
        byteLength,
      };
    } catch (error) {
      await closeQuietly(fileHandle);
      throw toAccessError(error, requestPath);
    }
  }

  throw new WorkspaceFileAccessDeniedError();
}
/**
 * Replaces an already-authorized file. The optional check runs before the
 * first destructive operation, so a rejected editor conflict preserves bytes.
 */
export async function writeOpenedWorkspaceFile(
  opened: OpenedWorkspaceFile,
  content: Uint8Array,
  beforeWrite?: () => Promise<void>
): Promise<void> {
  await beforeWrite?.();
  await opened.fileHandle.truncate(0);
  await opened.fileHandle.writeFile(content);
}

/** Reads at most the advertised ACP file limit, including concurrent growth. */
export async function readOpenedWorkspaceFile(
  opened: OpenedWorkspaceFile
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_WORKSPACE_FILE_BYTES) {
    const chunk = Buffer.allocUnsafe(
      Math.min(64 * 1024, MAX_WORKSPACE_FILE_BYTES + 1 - total)
    );
    const { bytesRead } = await opened.fileHandle.read(
      chunk,
      0,
      chunk.length,
      total
    );
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total).toString("utf8");
    }
    total += bytesRead;
    if (total > MAX_WORKSPACE_FILE_BYTES) {
      throw new WorkspaceFileTooLargeError();
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  throw new WorkspaceFileTooLargeError();
}
