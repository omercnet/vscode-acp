import * as path from "path";
import * as vscode from "vscode";
import * as acp from "@agentclientprotocol/sdk";
import {
  getNodeValue,
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";

export const MCP_SERVERS_SETTING = "vscode-acp.mcpServers";
export const MCP_PROJECT_CONFIG_PATH = ".vscode/mcp.json";
export interface ConfiguredSession {
  parameters: acp.NewSessionRequest;
  sensitiveValues: readonly string[];
}

export type McpConfigurationErrorCode =
  | "MCP_CONFIG_MALFORMED"
  | "MCP_CONFIG_DUPLICATE"
  | "MCP_CONFIG_UNSUPPORTED"
  | "MCP_CONFIG_UNSAFE"
  | "MCP_CONFIG_ENV"
  | "MCP_CONFIG_READ";

export class McpConfigurationError extends Error {
  constructor(
    readonly code: McpConfigurationErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = "McpConfigurationError";
  }
}

type JsonObject = Record<string, unknown>;

const MAX_SERVERS = 16;
const MAX_NAME_LENGTH = 128;
const MAX_STRING_LENGTH = 8_192;
const MAX_ARGS = 64;
const MAX_VALUES = 64;
const MAX_CONFIGURATION_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const ENV_REFERENCE = /\$\{env:([^}]*)\}/g;
const INTERPOLATION = /\$\{[^}]*\}/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export function getMcpConfigurationResource(
  cwd: string,
  workspaceFolders = vscode.workspace.workspaceFolders,
  resource?: vscode.Uri
): vscode.Uri {
  const exactResource = resource
    ? workspaceFolders?.find(
        (folder) => folder.uri.toString() === resource.toString()
      )
    : undefined;
  if (exactResource) {
    return exactResource.uri;
  }

  const cwdMatches =
    workspaceFolders?.filter((folder) => folder.uri.fsPath === cwd) ?? [];
  return cwdMatches.length === 1 ? cwdMatches[0].uri : vscode.Uri.file(cwd);
}

export function getMcpProjectConfigurationUri(
  cwd: string,
  workspaceFolders = vscode.workspace.workspaceFolders,
  resource?: vscode.Uri
): vscode.Uri | undefined {
  let workspaceFolder: vscode.WorkspaceFolder | undefined;
  if (resource) {
    workspaceFolder = workspaceFolders?.find(
      (folder) => folder.uri.toString() === resource.toString()
    );
  } else {
    const matches =
      workspaceFolders?.filter((folder) => folder.uri.fsPath === cwd) ?? [];
    if (matches.length === 1) workspaceFolder = matches[0];
  }
  return workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder.uri, MCP_PROJECT_CONFIG_PATH)
    : undefined;
}
export interface McpConfigurationSource {
  readonly location: string;
  readonly configuration: unknown;
}
interface McpSettingInspection {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

export function selectMcpSettingSources(
  inspected: McpSettingInspection | undefined,
  isTrusted: boolean
): McpConfigurationSource[] {
  const sources: McpConfigurationSource[] = [
    {
      location: `${MCP_SERVERS_SETTING} (user)`,
      configuration:
        inspected?.globalValue === undefined ? [] : inspected.globalValue,
    },
  ];
  if (isTrusted) {
    sources.push(
      {
        location: `${MCP_SERVERS_SETTING} (workspace)`,
        configuration:
          inspected?.workspaceValue === undefined
            ? []
            : inspected.workspaceValue,
      },
      {
        location: `${MCP_SERVERS_SETTING} (workspace folder)`,
        configuration:
          inspected?.workspaceFolderValue === undefined
            ? []
            : inspected.workspaceFolderValue,
      }
    );
  }
  return sources;
}

export function parseMcpProjectConfiguration(contents: Uint8Array): unknown[] {
  if (contents.byteLength > MAX_CONFIGURATION_BYTES) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${MCP_PROJECT_CONFIG_PATH} exceeds the ${MAX_CONFIGURATION_BYTES}-byte limit`
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${MCP_PROJECT_CONFIG_PATH} must contain valid UTF-8`
    );
  }
  const errors: ParseError[] = [];
  const parsedTree = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${MCP_PROJECT_CONFIG_PATH} contains invalid JSONC at offset ${errors[0].offset}`
    );
  }
  if (parsedTree) rejectDuplicateJsonProperties(parsedTree);
  const parsed = parsedTree ? getNodeValue(parsedTree) : undefined;

  const root = requireObject(parsed, MCP_PROJECT_CONFIG_PATH);
  requireKeys(root, MCP_PROJECT_CONFIG_PATH, ["servers"]);
  const servers = requireObject(
    root.servers,
    `${MCP_PROJECT_CONFIG_PATH}.servers`
  );
  return Object.entries(servers).map(([name, value]) => {
    const location = `${MCP_PROJECT_CONFIG_PATH}.servers[${JSON.stringify(name)}]`;
    const server = requireObject(value, location);
    if (Object.prototype.hasOwnProperty.call(server, "name")) {
      fail(
        "MCP_CONFIG_MALFORMED",
        `${location}.name is unsupported; the object key is the server name`
      );
    }
    const normalized: JsonObject = { ...server, name };
    const type = server.type === undefined ? "stdio" : server.type;
    if (type === "stdio" && server.env !== undefined) {
      normalized.env = projectNamedValues(server.env, `${location}.env`);
    }
    if ((type === "http" || type === "sse") && server.headers !== undefined) {
      normalized.headers = projectNamedValues(
        server.headers,
        `${location}.headers`
      );
    }
    return normalized;
  });
}
function rejectDuplicateJsonProperties(root: JsonNode): void {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === "object") {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const name = property.children?.[0]?.value;
        if (typeof name === "string") {
          if (names.has(name)) {
            fail(
              "MCP_CONFIG_DUPLICATE",
              `${MCP_PROJECT_CONFIG_PATH} contains duplicate property ${JSON.stringify(name)} at offset ${property.offset}`
            );
          }
          names.add(name);
        }
        const value = property.children?.[1];
        if (value) pending.push(value);
      }
    } else {
      pending.push(...(node.children ?? []));
    }
  }
}

export function configureMcpServers(
  sources: readonly McpConfigurationSource[],
  capabilities: acp.McpCapabilities,
  environment: NodeJS.ProcessEnv = process.env,
  sensitiveValues = new Set<string>()
): acp.McpServer[] {
  const merged = new Map<string, acp.McpServer>();
  for (const source of sources) {
    const servers = validateMcpServers(
      source.configuration,
      capabilities,
      environment,
      sensitiveValues,
      source.location
    );
    for (const server of servers) {
      merged.set(server.name.toLowerCase(), server);
    }
  }
  const configured = [...merged.values()];
  if (configured.length > MAX_SERVERS) {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${MCP_SERVERS_SETTING} supports at most ${MAX_SERVERS} entries after precedence is applied`
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(configured), "utf8") >
    MAX_CONFIGURATION_BYTES
  ) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${MCP_SERVERS_SETTING} exceeds the ${MAX_CONFIGURATION_BYTES}-byte limit after precedence is applied`
    );
  }
  return configured;
}

export async function getConfiguredSession(
  cwd: string,
  capabilities: acp.McpCapabilities,
  environment: NodeJS.ProcessEnv = process.env,
  resource?: vscode.Uri
): Promise<ConfiguredSession> {
  const configurationResource = getMcpConfigurationResource(
    cwd,
    undefined,
    resource
  );
  const configuration = vscode.workspace.getConfiguration(
    "vscode-acp",
    configurationResource
  );
  const inspected = configuration.inspect<unknown>("mcpServers");
  const sources = selectMcpSettingSources(
    inspected,
    vscode.workspace.isTrusted
  );

  if (vscode.workspace.isTrusted) {
    const projectUri = getMcpProjectConfigurationUri(cwd, undefined, resource);
    if (projectUri) {
      const projectConfiguration =
        await readMcpProjectConfiguration(projectUri);
      if (projectConfiguration) {
        sources.push({
          location: `${MCP_PROJECT_CONFIG_PATH}.servers`,
          configuration: projectConfiguration,
        });
      }
    }
  }

  const sensitiveValues = new Set<string>();
  const mcpServers = configureMcpServers(
    sources,
    capabilities,
    environment,
    sensitiveValues
  );
  return {
    parameters: { cwd, mcpServers },
    sensitiveValues: [...sensitiveValues],
  };
}

async function readMcpProjectConfiguration(
  uri: vscode.Uri
): Promise<unknown[] | undefined> {
  let contents: Uint8Array;
  try {
    contents = await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    fail("MCP_CONFIG_READ", `${MCP_PROJECT_CONFIG_PATH} could not be read`);
  }
  return parseMcpProjectConfiguration(contents);
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FileNotFound" || error.code === "ENOENT")
  );
}

function projectNamedValues(
  value: unknown,
  location: string
): Array<{ name: string; value: string }> {
  const object = requireObject(value, location);
  return Object.entries(object).map(([name, entryValue]) => {
    if (typeof entryValue !== "string") {
      fail("MCP_CONFIG_MALFORMED", `${location}.${name} must be a string`);
    }
    return { name, value: entryValue };
  });
}

export class McpSecretRedactor {
  private readonly sensitiveValues = new Set<string>();

  add(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length > 0) this.sensitiveValues.add(value);
    }
  }

  clear(): void {
    this.sensitiveValues.clear();
  }

  redact(text: string): string {
    return [...this.sensitiveValues]
      .sort((left, right) => right.length - left.length)
      .reduce(
        (redacted, secret) => redacted.split(secret).join("[redacted]"),
        text
      );
  }

  redactError(error: unknown): Error {
    if (!(error instanceof Error)) {
      return new Error(this.redact(String(error)));
    }
    const message = this.redact(error.message);
    if (error instanceof acp.RequestError) {
      return new acp.RequestError(error.code, message);
    }
    if (message === error.message) {
      return error;
    }
    const redacted = new Error(message);
    redacted.name = error.name;
    return redacted;
  }
}

export function validateMcpServers(
  configuration: unknown,
  capabilities: acp.McpCapabilities,
  environment: NodeJS.ProcessEnv = process.env,
  sensitiveValues?: Set<string>,
  locationBase = MCP_SERVERS_SETTING
): acp.McpServer[] {
  if (!Array.isArray(configuration)) {
    fail("MCP_CONFIG_MALFORMED", `${locationBase} must be an array`);
  }
  if (configuration.length > MAX_SERVERS) {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${locationBase} supports at most ${MAX_SERVERS} entries`
    );
  }

  const names = new Set<string>();
  const servers = configuration.map((entry, index) => {
    const location = `${locationBase}[${index}]`;
    const object = requireObject(entry, location);
    const type = object.type === undefined ? "stdio" : object.type;
    if (type !== "stdio" && type !== "http" && type !== "sse") {
      fail(
        "MCP_CONFIG_UNSUPPORTED",
        `${location}.type must be stdio, http, or sse`
      );
    }

    const name = requireString(object.name, `${location}.name`);
    if (
      name.trim() !== name ||
      name.length > MAX_NAME_LENGTH ||
      CONTROL_CHARACTER.test(name)
    ) {
      fail(
        "MCP_CONFIG_UNSAFE",
        `${location}.name must be 1-${MAX_NAME_LENGTH} printable characters without surrounding whitespace`
      );
    }
    const duplicateKey = name.toLowerCase();
    if (names.has(duplicateKey)) {
      fail(
        "MCP_CONFIG_DUPLICATE",
        `${location}.name duplicates another server name`
      );
    }
    names.add(duplicateKey);

    if (type === "stdio") {
      return validateStdio(
        object,
        location,
        name,
        environment,
        sensitiveValues
      );
    }
    return validateRemote(
      object,
      location,
      name,
      type,
      capabilities,
      environment,
      sensitiveValues
    );
  });
  if (
    Buffer.byteLength(JSON.stringify(servers), "utf8") > MAX_CONFIGURATION_BYTES
  ) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${locationBase} exceeds the ${MAX_CONFIGURATION_BYTES}-byte limit after environment resolution`
    );
  }
  return servers;
}

function validateStdio(
  object: JsonObject,
  location: string,
  name: string,
  environment: NodeJS.ProcessEnv,
  sensitiveValues?: Set<string>
): acp.McpServer {
  requireKeys(object, location, ["type", "name", "command", "args", "env"]);
  const command = requireString(object.command, `${location}.command`);
  rejectUnsafeLiteral(command, `${location}.command`);
  if (CONTROL_CHARACTER.test(command) || !path.isAbsolute(command)) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${location}.command must be a printable absolute executable path`
    );
  }

  const args = optionalStringArray(object.args, `${location}.args`, MAX_ARGS);
  args.forEach((argument, index) => {
    rejectUnsafeLiteral(argument, `${location}.args[${index}]`);
  });

  const env = optionalNamedValues(object.env, `${location}.env`);
  const resolvedEnv = env.map(({ name: envName, value }) => {
    if (!ENV_NAME.test(envName)) {
      fail(
        "MCP_CONFIG_MALFORMED",
        `${location}.env contains an invalid environment variable name`
      );
    }
    return {
      name: envName,
      value: resolveEnvironmentReferences(
        value,
        environment,
        `${location}.env`,
        sensitiveValues
      ),
    };
  });

  return { name, command, args, env: resolvedEnv };
}

function validateRemote(
  object: JsonObject,
  location: string,
  name: string,
  type: "http" | "sse",
  capabilities: acp.McpCapabilities,
  environment: NodeJS.ProcessEnv,
  sensitiveValues?: Set<string>
): acp.McpServer {
  if (capabilities[type] !== true) {
    fail(
      "MCP_CONFIG_UNSUPPORTED",
      `${location} uses ${type.toUpperCase()}, but the connected agent does not advertise mcpCapabilities.${type}`
    );
  }
  requireKeys(object, location, ["type", "name", "url", "headers"]);

  const urlText = requireString(object.url, `${location}.url`);
  rejectUnsafeLiteral(urlText, `${location}.url`);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    fail("MCP_CONFIG_MALFORMED", `${location}.url must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${location}.url must use HTTPS and must not contain credentials or a fragment`
    );
  }

  const headers = optionalNamedValues(object.headers, `${location}.headers`);
  const resolvedHeaders: acp.HttpHeader[] = headers.map(
    ({ name: headerName, value }) => {
      if (!HEADER_NAME.test(headerName)) {
        fail(
          "MCP_CONFIG_MALFORMED",
          `${location}.headers contains an invalid HTTP header name`
        );
      }
      const resolved = resolveEnvironmentReferences(
        value,
        environment,
        `${location}.headers`,
        sensitiveValues
      );
      if (CONTROL_CHARACTER.test(resolved)) {
        fail(
          "MCP_CONFIG_UNSAFE",
          `${location}.headers resolves to a value containing a control character`
        );
      }
      return { name: headerName, value: resolved };
    }
  );
  const headerBytes = resolvedHeaders.reduce(
    (total, header) =>
      total +
      Buffer.byteLength(header.name, "utf8") +
      Buffer.byteLength(header.value, "utf8"),
    0
  );
  if (headerBytes > MAX_HEADER_BYTES) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${location}.headers exceeds the ${MAX_HEADER_BYTES}-byte limit after environment resolution`
    );
  }

  return { type, name, url: url.toString(), headers: resolvedHeaders };
}

function resolveEnvironmentReferences(
  value: string,
  environment: NodeJS.ProcessEnv,
  location: string,
  sensitiveValues?: Set<string>
): string {
  if (value.length > MAX_STRING_LENGTH || value.includes("\0")) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${location} is too long or contains a null character`
    );
  }

  const unsupportedSyntax = value.replace(ENV_REFERENCE, "");
  if (
    unsupportedSyntax.includes("${env:") ||
    INTERPOLATION.test(unsupportedSyntax)
  ) {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${location} contains an unsupported environment reference`
    );
  }

  let substituted = false;
  const resolved = value.replace(
    ENV_REFERENCE,
    (_reference, variable: string) => {
      substituted = true;
      if (!ENV_NAME.test(variable)) {
        fail(
          "MCP_CONFIG_MALFORMED",
          `${location} contains a malformed environment reference`
        );
      }
      const environmentValue = environment[variable];
      if (environmentValue === undefined) {
        fail(
          "MCP_CONFIG_ENV",
          `${location} references missing environment variable ${variable}`
        );
      }
      if (environmentValue.length > 0) {
        sensitiveValues?.add(environmentValue);
      }
      return environmentValue;
    }
  );
  if (resolved.length > MAX_STRING_LENGTH || resolved.includes("\0")) {
    fail("MCP_CONFIG_UNSAFE", `${location} resolves to an unsafe value`);
  }
  if (substituted && resolved.length > 0) {
    sensitiveValues?.add(resolved);
  }
  return resolved;
}

function rejectUnsafeLiteral(value: string, location: string): void {
  if (
    value.length > MAX_STRING_LENGTH ||
    value.includes("\0") ||
    INTERPOLATION.test(value)
  ) {
    fail(
      "MCP_CONFIG_UNSAFE",
      `${location} contains an unsafe or unsupported value`
    );
  }
}

function requireObject(value: unknown, location: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MCP_CONFIG_MALFORMED", `${location} must be an object`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("MCP_CONFIG_MALFORMED", `${location} must be a non-empty string`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  location: string,
  maximum: number
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${location} must be an array with at most ${maximum} strings`
    );
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      fail("MCP_CONFIG_MALFORMED", `${location}[${index}] must be a string`);
    }
    return item;
  });
}

function optionalNamedValues(
  value: unknown,
  location: string
): Array<{ name: string; value: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_VALUES) {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${location} must be an array with at most ${MAX_VALUES} entries`
    );
  }

  const names = new Set<string>();
  return value.map((entry, index) => {
    const itemLocation = `${location}[${index}]`;
    const object = requireObject(entry, itemLocation);
    requireKeys(object, itemLocation, ["name", "value"]);
    const name = requireString(object.name, `${itemLocation}.name`);
    if (names.has(name.toLowerCase())) {
      fail("MCP_CONFIG_DUPLICATE", `${location} contains a duplicate name`);
    }
    names.add(name.toLowerCase());
    if (typeof object.value !== "string") {
      fail("MCP_CONFIG_MALFORMED", `${itemLocation}.value must be a string`);
    }
    return { name, value: object.value };
  });
}

function requireKeys(
  object: JsonObject,
  location: string,
  allowedKeys: readonly string[]
): void {
  if (Object.keys(object).some((key) => !allowedKeys.includes(key))) {
    fail(
      "MCP_CONFIG_MALFORMED",
      `${location} contains an unsupported property`
    );
  }
}

function fail(code: McpConfigurationErrorCode, message: string): never {
  throw new McpConfigurationError(code, message);
}
