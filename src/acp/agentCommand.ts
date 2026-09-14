import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  statSync,
} from "fs";
import { posix, win32 } from "path";

const WINDOWS_NATIVE_EXTENSIONS = [".com", ".exe"];
const DEFAULT_WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat"];
const SUPPORTED_WINDOWS_SHIM_EXTENSIONS: Record<string, true> = {
  ".cmd": true,
  ".bat": true,
};
const MAX_SHIM_BYTES = 64 * 1024;

export type AgentCommandSource =
  "explicit executable" | "PATH executable" | "Windows command shim";

export interface ResolvedAgentCommand {
  command: string;
  args: string[];
  source: AgentCommandSource;
  cwd: string;
}

export interface AgentCommandFileSystem {
  isFile(path: string): boolean;
  isExecutable(path: string): boolean;
  readText(path: string): string | undefined;
  realpath(path: string): string;
}

export interface AgentCommandResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  excludedDirectories?: readonly string[];
  fileSystem?: AgentCommandFileSystem;
}

const nodeFileSystem: AgentCommandFileSystem = {
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readText(path) {
    try {
      const contents = readFileSync(path);
      return contents.byteLength <= MAX_SHIM_BYTES
        ? contents.toString("utf8")
        : undefined;
    } catch {
      return undefined;
    }
  },
  realpath(path) {
    return realpathSync.native(path);
  },
};

interface ResolutionContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  excludedDirectories: readonly string[];
  fileSystem: AgentCommandFileSystem;
}

function getEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== "win32") {
    return env[name];
  }

  const key = Object.keys(env)
    .sort()
    .find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function getWindowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = getEnvironmentValue(env, "PATHEXT", "win32");
  const shimExtensions = (
    configured ? configured.split(";") : DEFAULT_WINDOWS_SHIM_EXTENSIONS
  )
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`
    )
    .filter((extension) => SUPPORTED_WINDOWS_SHIM_EXTENSIONS[extension]);
  return [...new Set([...WINDOWS_NATIVE_EXTENSIONS, ...shimExtensions])];
}

const WINDOWS_EXTENDED_PREFIX = /^[\\/]{2}[?.][\\/](UNC[\\/])?/i;
const WINDOWS_DRIVE_ROOT = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_ROOT = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/;

/**
 * Rewrites a Windows extended-length or device prefix (`\\?\C:\x`,
 * `\\?\UNC\host\share`) into its ordinary spelling so the same path cannot be
 * written two ways to dodge a comparison.
 */
function withoutWindowsPrefix(value: string): string {
  const extended = WINDOWS_EXTENDED_PREFIX.exec(value);
  if (!extended) {
    return value;
  }
  const remainder = value.slice(extended[0].length);
  return extended[1] ? `\\\\${remainder}` : remainder;
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? win32.normalize(withoutWindowsPrefix(value)).toLowerCase()
    : value;
}

/**
 * Accepts only paths anchored to a real root. Windows drive-relative roots such
 * as `\tools` still depend on the current working drive, so they are rejected
 * together with device paths.
 */
function isRooted(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") {
    return posix.isAbsolute(value);
  }
  const candidate = withoutWindowsPrefix(value);
  return WINDOWS_DRIVE_ROOT.test(candidate) || WINDOWS_UNC_ROOT.test(candidate);
}

function isWithinDirectory(
  candidate: string,
  directory: string,
  platform: NodeJS.Platform
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const relative = pathApi.relative(
    comparablePath(directory, platform),
    comparablePath(candidate, platform)
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !pathApi.isAbsolute(relative))
  );
}

function isExcluded(candidate: string, context: ResolutionContext): boolean {
  return context.excludedDirectories.some((directory) =>
    isWithinDirectory(candidate, directory, context.platform)
  );
}

function getAbsoluteSearchDirectories(
  pathValue: string,
  platform: NodeJS.Platform
): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  return pathValue
    .split(delimiter)
    .map((directory) => {
      if (
        directory.length >= 2 &&
        ((directory.startsWith('"') && directory.endsWith('"')) ||
          (directory.startsWith("'") && directory.endsWith("'")))
      ) {
        return directory.slice(1, -1);
      }
      return directory;
    })
    .filter((directory) => isRooted(directory, platform));
}

function createResolutionContext(
  options: AgentCommandResolutionOptions
): ResolutionContext {
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const pathApi = platform === "win32" ? win32 : posix;
  const excludedDirectories = [
    ...new Set(
      (options.excludedDirectories ?? []).flatMap((directory) => {
        const lexical = pathApi.resolve(directory);
        try {
          return [lexical, fileSystem.realpath(directory)];
        } catch {
          return [lexical];
        }
      })
    ),
  ];
  return {
    platform,
    env: options.env ?? process.env,
    excludedDirectories,
    fileSystem,
  };
}

function canonicalFile(
  candidate: string,
  context: ResolutionContext,
  requireExecutable: boolean,
  allowExcluded: boolean
): string | undefined {
  const exists = requireExecutable
    ? context.fileSystem.isExecutable(candidate)
    : context.fileSystem.isFile(candidate);
  if (!exists) {
    return undefined;
  }

  if (!allowExcluded && isExcluded(candidate, context)) {
    return undefined;
  }

  try {
    const canonical = context.fileSystem.realpath(candidate);
    if (
      !isRooted(canonical, context.platform) ||
      (!allowExcluded && isExcluded(canonical, context))
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function commandCandidates(
  command: string,
  context: ResolutionContext
): { paths: string[]; explicit: boolean } | undefined {
  const pathApi = context.platform === "win32" ? win32 : posix;
  const explicit = isRooted(command, context.platform);
  if (!explicit && pathApi.basename(command) !== command) {
    return undefined;
  }

  const names =
    context.platform === "win32" && pathApi.extname(command) === ""
      ? getWindowsExtensions(context.env).map(
          (extension) => command + extension
        )
      : [command];

  if (explicit) {
    const directory = pathApi.dirname(command);
    return {
      explicit,
      paths: names.map((name) =>
        pathApi.join(directory, pathApi.basename(name))
      ),
    };
  }

  const pathValue = getEnvironmentValue(context.env, "PATH", context.platform);
  if (!pathValue) {
    return { explicit, paths: [] };
  }

  const directories = getAbsoluteSearchDirectories(pathValue, context.platform);

  return {
    explicit,
    paths: directories.flatMap((directory) =>
      names.map((name) => pathApi.join(directory, name))
    ),
  };
}

interface ExecutableCandidate {
  path: string;
  extension: string;
  explicit: boolean;
}

/**
 * Yields canonical executables for a command in Windows PATH/PATHEXT order.
 * Shared by discovery, launch, and shim interpreter lookup so every caller
 * applies the same trust boundary.
 */
function* executableCandidates(
  command: string,
  context: ResolutionContext,
  nativeOnly = false
): Generator<ExecutableCandidate> {
  const candidates = commandCandidates(command, context);
  if (!candidates) {
    return;
  }

  for (const candidate of candidates.paths) {
    const extension =
      context.platform === "win32"
        ? win32.extname(candidate).toLowerCase()
        : "";
    const native = extension === ".exe" || extension === ".com";
    if (nativeOnly && !native) {
      continue;
    }

    const path = canonicalFile(
      candidate,
      context,
      context.platform !== "win32" || native,
      candidates.explicit
    );
    if (path) {
      yield { path, extension, explicit: candidates.explicit };
    }
  }
}

function resolveNativeExecutable(
  command: string,
  context: ResolutionContext
): string | undefined {
  for (const candidate of executableCandidates(command, context, true)) {
    return candidate.path;
  }
  return undefined;
}

const SHIM_VARIABLE = /^%([A-Za-z_][A-Za-z0-9_]*)%$/;
const SHIM_LOCAL_PATH = /^%~?dp0%?[\\/](.+)$/i;
const SHIM_UNSAFE_TOKEN = /[%&|<>^"]/;

interface ShimContext {
  assignments: Map<string, string[]>;
  directory: string;
  context: ResolutionContext;
  explicit: boolean;
}

/**
 * Resolves one shim token. `SET "NAME=value"` bindings are followed in file
 * order, which is how npm expresses "use the bundled interpreter, otherwise
 * fall back to PATH". Anything else fails the resolution closed.
 */
function resolveShimToken(
  token: string,
  shim: ShimContext,
  requireExecutable: boolean,
  visited: Set<string>
): string | undefined {
  const value = token.trim();

  const variable = SHIM_VARIABLE.exec(value);
  if (variable) {
    const name = variable[1].toLowerCase();
    if (visited.has(name)) {
      return undefined;
    }
    visited.add(name);
    for (const assigned of shim.assignments.get(name) ?? []) {
      const resolved = resolveShimToken(
        assigned,
        shim,
        requireExecutable,
        visited
      );
      if (resolved) {
        return resolved;
      }
    }
    visited.delete(name);
    return undefined;
  }

  const local = SHIM_LOCAL_PATH.exec(value);
  if (local) {
    return SHIM_UNSAFE_TOKEN.test(local[1])
      ? undefined
      : canonicalFile(
          win32.resolve(shim.directory, local[1]),
          shim.context,
          requireExecutable,
          shim.explicit
        );
  }

  if (!requireExecutable || value === "" || SHIM_UNSAFE_TOKEN.test(value)) {
    return undefined;
  }
  return resolveNativeExecutable(value, shim.context);
}

/**
 * Decodes an npm-style `.cmd`/`.bat` shim into an absolute interpreter plus the
 * arguments it would have passed, without handing the line to a shell. Every
 * token the tokenizer cannot account for fails the resolution closed.
 */
function resolveWindowsCommandShim(
  shimPath: string,
  args: readonly string[],
  context: ResolutionContext,
  explicit: boolean
): ResolvedAgentCommand | undefined {
  const contents = context.fileSystem.readText(shimPath);
  if (!contents) {
    return undefined;
  }

  const invocationLine = contents
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.includes("%*"));
  if (!invocationLine) {
    return undefined;
  }

  const invocation = invocationLine.slice(0, invocationLine.lastIndexOf("%*"));
  const tokens = [...invocation.matchAll(/"([^"]*)"|(\S+)/g)].map(
    (match) => match[1] ?? match[2]
  );
  const shim: ShimContext = {
    assignments: new Map(),
    directory: win32.dirname(shimPath),
    context,
    explicit,
  };
  for (const assignment of contents.matchAll(
    /SET\s+"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"/gi
  )) {
    const name = assignment[1].toLowerCase();
    const values = shim.assignments.get(name);
    if (values) {
      values.push(assignment[2]);
    } else {
      shim.assignments.set(name, [assignment[2]]);
    }
  }

  // npm's package shims prefix the invocation with `endLocal & goto ... &
  // title %COMSPEC%`, so the interpreter is the first token that names an
  // executable this resolver trusts, not simply the first variable.
  let programIndex = -1;
  let program: string | undefined;
  for (const [index, token] of tokens.entries()) {
    if (!SHIM_VARIABLE.test(token) && !SHIM_LOCAL_PATH.test(token)) {
      continue;
    }
    program = resolveShimToken(token, shim, true, new Set<string>());
    if (program) {
      programIndex = index;
      break;
    }
  }
  if (!program) {
    return undefined;
  }

  const shimArguments: string[] = [];
  for (const token of tokens.slice(programIndex + 1)) {
    if (SHIM_VARIABLE.test(token) || SHIM_LOCAL_PATH.test(token)) {
      const file = resolveShimToken(token, shim, false, new Set<string>());
      if (!file) {
        return undefined;
      }
      shimArguments.push(file);
      continue;
    }
    if (SHIM_UNSAFE_TOKEN.test(token)) {
      return undefined;
    }
    shimArguments.push(token);
  }

  return {
    command: program,
    args: [...shimArguments, ...args],
    cwd: win32.dirname(program),
    source: "Windows command shim",
  };
}

/**
 * Resolves an agent command without delegating lookup to child_process.spawn.
 * Bare commands search only absolute PATH entries. Relative PATH entries and
 * untrusted workspace directories are ignored, and absolute commands are
 * treated as explicit user choices.
 */
export function resolveAgentCommand(
  command: string,
  args: readonly string[],
  options: AgentCommandResolutionOptions = {}
): ResolvedAgentCommand | undefined {
  const context = createResolutionContext(options);

  for (const candidate of executableCandidates(command, context)) {
    if (candidate.extension === ".cmd" || candidate.extension === ".bat") {
      const shim = resolveWindowsCommandShim(
        candidate.path,
        args,
        context,
        candidate.explicit
      );
      if (shim) {
        return shim;
      }
      continue;
    }

    return {
      command: candidate.path,
      args: [...args],
      cwd:
        context.platform === "win32"
          ? win32.dirname(candidate.path)
          : posix.dirname(candidate.path),
      source: candidate.explicit ? "explicit executable" : "PATH executable",
    };
  }
  return undefined;
}

/**
 * Removes cwd-relative and untrusted workspace entries from the PATH inherited
 * by an agent. This also protects scripts that use env-based shebangs.
 */
export function createAgentEnvironment(
  options: AgentCommandResolutionOptions = {}
): NodeJS.ProcessEnv {
  const context = createResolutionContext(options);
  const environment = { ...context.env };

  const pathValue = getEnvironmentValue(context.env, "PATH", context.platform);
  if (pathValue === undefined) {
    return environment;
  }

  const safeDirectories: string[] = [];
  for (const directory of getAbsoluteSearchDirectories(
    pathValue,
    context.platform
  )) {
    if (isExcluded(directory, context)) {
      continue;
    }
    try {
      const canonical = context.fileSystem.realpath(directory);
      if (!isExcluded(canonical, context)) {
        safeDirectories.push(canonical);
      }
    } catch {
      // A missing or inaccessible directory cannot contribute an executable.
    }
  }

  if (context.platform === "win32") {
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === "path") {
        delete environment[key];
      }
    }
  } else {
    delete environment.PATH;
  }
  if (safeDirectories.length > 0) {
    environment.PATH = safeDirectories.join(
      context.platform === "win32" ? ";" : ":"
    );
  }
  return environment;
}
