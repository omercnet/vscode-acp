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

const WINDOWS_EXTENDED_PREFIX = /^\\\\[?.]\\(UNC\\)?/i;
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

const SHIM_LOCAL_TOKEN = /^%dp0%[\\/](.+)$/i;
const SHIM_UNSAFE_TOKEN = /[%&|<>^"]/;

function resolveShimInterpreter(
  contents: string,
  shimDirectory: string,
  context: ResolutionContext,
  explicit: boolean
): string | undefined {
  const localProgram = contents.match(/SET\s+"_prog=%dp0%[\\/]([^"%]+)"/i)?.[1];
  const local = localProgram
    ? canonicalFile(
        win32.resolve(shimDirectory, localProgram),
        context,
        true,
        explicit
      )
    : undefined;
  if (local) {
    return local;
  }

  const fallbackPrograms = [...contents.matchAll(/SET\s+"_prog=([^"%]+)"/gi)];
  const fallbackProgram =
    fallbackPrograms[fallbackPrograms.length - 1]?.[1]?.trim();
  return fallbackProgram
    ? resolveNativeExecutable(fallbackProgram, context)
    : undefined;
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
    .find((line) => line.includes("%*") && /%dp0%[\\/]/i.test(line));
  if (!invocationLine) {
    return undefined;
  }

  const invocation = invocationLine.slice(0, invocationLine.lastIndexOf("%*"));
  const tokens = [...invocation.matchAll(/"([^"]*)"|(\S+)/g)].map(
    (match) => match[1] ?? match[2]
  );
  const programIndex = tokens.findIndex(
    (token) => token === "%_prog%" || SHIM_LOCAL_TOKEN.test(token)
  );
  if (programIndex < 0) {
    return undefined;
  }

  const shimDirectory = win32.dirname(shimPath);
  const program =
    tokens[programIndex] === "%_prog%"
      ? resolveShimInterpreter(contents, shimDirectory, context, explicit)
      : canonicalFile(
          win32.resolve(
            shimDirectory,
            SHIM_LOCAL_TOKEN.exec(tokens[programIndex])?.[1] ?? ""
          ),
          context,
          true,
          explicit
        );
  if (!program) {
    return undefined;
  }

  const shimArguments: string[] = [];
  for (const token of tokens.slice(programIndex + 1)) {
    const local = SHIM_LOCAL_TOKEN.exec(token);
    if (local) {
      const file = canonicalFile(
        win32.resolve(shimDirectory, local[1]),
        context,
        false,
        explicit
      );
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
  if (context.excludedDirectories.length === 0) {
    return environment;
  }

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
  }
  environment.PATH = safeDirectories.join(
    context.platform === "win32" ? ";" : ":"
  );
  return environment;
}
