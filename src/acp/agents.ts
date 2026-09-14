import {
  resolveAgentCommand as resolveCommand,
  type AgentCommandResolutionOptions,
  type ResolvedAgentCommand,
} from "./agentCommand";

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export interface AgentWithStatus extends AgentConfig {
  available: boolean;
}
export interface AgentDiscoveryOptions extends AgentCommandResolutionOptions {
  agentPaths?: Readonly<Record<string, string>>;
}

export const AGENTS: AgentConfig[] = [
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["@zed-industries/claude-code-acp"],
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "npx",
    args: ["@zed-industries/codex-acp"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: ["--acp"],
  },
  {
    id: "goose",
    name: "Goose",
    command: "goose",
    args: ["acp"],
  },
  {
    id: "amp",
    name: "Amp",
    command: "amp",
    args: ["acp"],
  },
  {
    id: "aider",
    name: "Aider",
    command: "aider",
    args: ["--acp"],
  },
  {
    id: "augment",
    name: "Augment Code",
    command: "augment",
    args: ["acp"],
  },
  {
    id: "kimi",
    name: "Kimi CLI",
    command: "kimi",
    args: ["--acp"],
  },
  {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    command: "vibe",
    args: ["acp"],
  },
  {
    id: "openhands",
    name: "OpenHands",
    command: "openhands",
    args: ["acp"],
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    command: "qwen",
    args: ["--experimental-acp"],
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    command: "kiro-cli",
    args: ["acp"],
  },
];

const TEST_AGENT_COMMAND = process.env.VSCODE_ACP_TEST_AGENT_COMMAND;

export function getAgent(
  id: string,
  agentPaths: Readonly<Record<string, string>> = {}
): AgentConfig | undefined {
  const agent = AGENTS.find((candidate) => candidate.id === id);
  if (!agent) {
    return undefined;
  }
  const configuredPath = agentPaths[id];
  return configuredPath ? { ...agent, command: configuredPath } : agent;
}

export function getDefaultAgent(
  agentPaths: Readonly<Record<string, string>> = {}
): AgentConfig {
  if (TEST_AGENT_COMMAND) {
    return { ...AGENTS[0], command: TEST_AGENT_COMMAND, args: [] };
  }
  return getAgent(AGENTS[0].id, agentPaths) ?? AGENTS[0];
}

export function resolveAgentCommand(
  agent: AgentConfig,
  options: AgentCommandResolutionOptions = {}
): ResolvedAgentCommand | undefined {
  return resolveCommand(agent.command, agent.args, options);
}

export function getAgentsWithStatus(
  options: AgentDiscoveryOptions = {}
): AgentWithStatus[] {
  const { agentPaths = {}, ...resolutionOptions } = options;
  return AGENTS.map((configuredAgent) => {
    const agent = getAgent(configuredAgent.id, agentPaths) ?? configuredAgent;
    return {
      ...agent,
      available: resolveAgentCommand(agent, resolutionOptions) !== undefined,
    };
  });
}

export function getFirstAvailableAgent(
  options: AgentDiscoveryOptions = {}
): AgentConfig {
  if (TEST_AGENT_COMMAND) {
    return getDefaultAgent(options.agentPaths);
  }

  const available = getAgentsWithStatus(options).find(
    (agent) => agent.available
  );
  return available
    ? (getAgent(available.id, options.agentPaths) ?? available)
    : getDefaultAgent(options.agentPaths);
}
