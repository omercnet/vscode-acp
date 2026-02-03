import { execSync } from "child_process";
import * as vscode from "vscode";

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
}

export interface AgentWithStatus extends AgentConfig {
  available: boolean;
  isCustom?: boolean;
}

/**
 * Built-in agents that ship with the extension.
 */
export const BUILTIN_AGENTS: AgentConfig[] = [
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
];

/**
 * Get custom agents from VS Code settings.
 * These are defined in settings.json under "acp.customAgents".
 */
export function getCustomAgents(): AgentConfig[] {
  // Guard for test environments where vscode may not be fully available
  const isTestEnv = process.env.NODE_ENV === "test";
  if (isTestEnv && !vscode?.workspace?.getConfiguration) {
    return [];
  }

  try {
    const config = vscode.workspace.getConfiguration("acp");
    const customAgents = config.get<AgentConfig[]>("customAgents", []);

    // Validate and normalize custom agents
    return customAgents
      .filter((agent) => agent.id && agent.name && agent.command)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        command: agent.command,
        args: agent.args || [],
      }));
  } catch {
    // Return empty array if settings can't be read
    return [];
  }
}

/**
 * Get all agents (built-in + custom).
 * Custom agents appear after built-in agents.
 */
export function getAllAgents(): AgentConfig[] {
  return [...BUILTIN_AGENTS, ...getCustomAgents()];
}

/**
 * For backwards compatibility - returns all agents.
 * @deprecated Use getAllAgents() instead
 */
export const AGENTS = getAllAgents();

export function getAgent(id: string): AgentConfig | undefined {
  return getAllAgents().find((a) => a.id === id);
}

export function getDefaultAgent(): AgentConfig {
  return getAllAgents()[0];
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
 * Note: Custom agents are always re-fetched since settings can change.
 */
let cachedBuiltinAgentsWithStatus: AgentWithStatus[] | null = null;

export function getAgentsWithStatus(forceRefresh = false): AgentWithStatus[] {
  // Cache built-in agents status (they don't change)
  if (!cachedBuiltinAgentsWithStatus || forceRefresh) {
    cachedBuiltinAgentsWithStatus = BUILTIN_AGENTS.map((agent) => ({
      ...agent,
      available: isCommandAvailable(agent.command),
      isCustom: false,
    }));
  }

  // Always fetch custom agents fresh (settings can change)
  const customAgentsWithStatus = getCustomAgents().map((agent) => ({
    ...agent,
    available: isCommandAvailable(agent.command),
    isCustom: true,
  }));

  return [...cachedBuiltinAgentsWithStatus, ...customAgentsWithStatus];
}

/**
 * Get the first available agent, or fall back to the default.
 */
export function getFirstAvailableAgent(): AgentConfig {
  const agents = getAgentsWithStatus();
  const available = agents.find((a) => a.available);
  return available ?? getAllAgents()[0];
}

export function isAgentAvailable(agentId: string): boolean {
  const agents = getAgentsWithStatus();
  const agent = agents.find((a) => a.id === agentId);
  return agent?.available ?? false;
}
