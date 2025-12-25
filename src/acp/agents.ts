import { execSync } from "child_process";

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export interface AgentWithStatus extends AgentConfig {
  available: boolean;
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
    command: "qwen-code",
    args: ["acp"],
  },
];

export function getAgent(id: string): AgentConfig | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function getDefaultAgent(): AgentConfig {
  return AGENTS[0];
}

/**
 * Check if a command exists on the system PATH.
 * For npx commands, we assume they're available since npx can install on demand.
 */
function isCommandAvailable(command: string): boolean {
  if (command === "npx") {
    // npx can install packages on demand, assume available if node/npm is installed
    try {
      execSync("which npx || where npx", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  try {
    // Use 'which' on Unix, 'where' on Windows
    const whichCmd = process.platform === "win32" ? "where" : "which";
    execSync(`${whichCmd} ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all agents with their availability status.
 * Caches the result for performance.
 */
let cachedAgentsWithStatus: AgentWithStatus[] | null = null;

export function getAgentsWithStatus(forceRefresh = false): AgentWithStatus[] {
  if (cachedAgentsWithStatus && !forceRefresh) {
    return cachedAgentsWithStatus;
  }

  cachedAgentsWithStatus = AGENTS.map((agent) => ({
    ...agent,
    available: isCommandAvailable(agent.command),
  }));

  return cachedAgentsWithStatus;
}

/**
 * Get the first available agent, or fall back to the default.
 */
export function getFirstAvailableAgent(): AgentConfig {
  const agents = getAgentsWithStatus();
  const available = agents.find((a) => a.available);
  return available ?? AGENTS[0];
}

export function isAgentAvailable(agentId: string): boolean {
  const agents = getAgentsWithStatus();
  const agent = agents.find((a) => a.id === agentId);
  return agent?.available ?? false;
}
