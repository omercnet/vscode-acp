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

function isWithinDirectory(
  candidate: string,
  directory: string,
  platform: NodeJS.Platform
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalize = (value: string) =>
    platform === "win32" ? value.toLowerCase() : value;
  const relative = pathApi.relative(normalize(directory), normalize(candidate));
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
  const pathApi = platform === "win32" ? win32 : posix;
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
    .filter((directory) => directory !== "" && pathApi.isAbsolute(directory));
}

function createResolutionContext(
  options: AgentCommandResolutionOptions
): ResolutionContext {
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const pathApi = platform === "win32" ? win32 : posix;
  const excludedDirectories = (options.excludedDirectories ?? []).map(
    (directory) => {
      try {
        return fileSystem.realpath(directory);
      } catch {
        return pathApi.resolve(directory);
      }
    }
  );
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

  try {
    const canonical = context.fileSystem.realpath(candidate);
    if (!allowExcluded && isExcluded(canonical, context)) {
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
  const explicit = pathApi.isAbsolute(command);
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

function resolveExecutableFile(
  command: string,
  context: ResolutionContext,
  executableExtensionsOnly = false
): { path: string; explicit: boolean } | undefined {
  const candidates = commandCandidates(command, context);
  if (!candidates) {
    return undefined;
  }

  for (const candidate of candidates.paths) {
    const extension =
      context.platform === "win32"
        ? win32.extname(candidate).toLowerCase()
        : "";
    if (
      executableExtensionsOnly &&
      extension !== ".exe" &&
      extension !== ".com"
    ) {
      continue;
    }

    const resolved = canonicalFile(
      candidate,
      context,
      context.platform !== "win32" ||
        extension === ".exe" ||
        extension === ".com",
      candidates.explicit
    );
    if (resolved) {
      return { path: resolved, explicit: candidates.explicit };
    }
  }
  return undefined;
}

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

  const targetMatches = [...invocationLine.matchAll(/"%dp0%[\\/]([^"%]+)"/gi)];
  const targetMatch = targetMatches[targetMatches.length - 1];
  const targetRelative = targetMatch?.[1];
  if (!targetRelative) {
    return undefined;
  }

  const targetCandidate = win32.resolve(
    win32.dirname(shimPath),
    targetRelative
  );
  const target = canonicalFile(targetCandidate, context, false, explicit);
  if (!target) {
    return undefined;
  }

  if (!invocationLine.includes('"%_prog%"')) {
    const executable = canonicalFile(targetCandidate, context, true, explicit);
    return executable
      ? {
          command: executable,
          args: [...args],
          source: "Windows command shim",
        }
      : undefined;
  }

  const localProgram = contents.match(/SET\s+"_prog=%dp0%[\\/]([^"%]+)"/i)?.[1];
  const fallbackPrograms = [...contents.matchAll(/SET\s+"_prog=([^"%]+)"/gi)];
  const fallbackProgram =
    fallbackPrograms[fallbackPrograms.length - 1]?.[1]?.trim();

  let interpreter: string | undefined;
  if (localProgram) {
    interpreter = canonicalFile(
      win32.resolve(win32.dirname(shimPath), localProgram),
      context,
      true,
      explicit
    );
  }
  if (!interpreter && fallbackProgram) {
    interpreter = resolveExecutableFile(fallbackProgram, context, true)?.path;
  }
  if (!interpreter) {
    return undefined;
  }

  const escapedTarget = targetMatch?.[0];
  const invocationStart = invocationLine.indexOf('"%_prog%"') + 10;
  const targetStart = escapedTarget
    ? invocationLine.lastIndexOf(escapedTarget)
    : -1;
  const interpreterArguments = invocationLine
    .slice(invocationStart, targetStart)
    .trim();
  if (interpreterArguments !== "") {
    return undefined;
  }

  return {
    command: interpreter,
    args: [target, ...args],
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
  const { platform } = context;
  const candidates = commandCandidates(command, context);
  if (!candidates) {
    return undefined;
  }

  for (const candidate of candidates.paths) {
    const extension =
      platform === "win32" ? win32.extname(candidate).toLowerCase() : "";
    const executable = canonicalFile(
      candidate,
      context,
      platform !== "win32" || extension === ".exe" || extension === ".com",
      candidates.explicit
    );
    if (!executable) {
      continue;
    }

    if (
      platform === "win32" &&
      (extension === ".cmd" || extension === ".bat")
    ) {
      const shim = resolveWindowsCommandShim(
        executable,
        args,
        context,
        candidates.explicit
      );
      if (shim) {
        return shim;
      }
      continue;
    }

    return {
      command: executable,
      args: [...args],
      source: candidates.explicit ? "explicit executable" : "PATH executable",
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
