export type AgentPathMap = Readonly<Record<string, string>>;

export interface AgentPathInspection {
  defaultValue?: AgentPathMap;
  globalValue?: AgentPathMap;
  workspaceValue?: AgentPathMap;
  workspaceFolderValue?: AgentPathMap;
}

/**
 * Selects executable overrides from VS Code configuration scopes. Workspace
 * values can affect process launch only after Workspace Trust is granted.
 */
export function selectAgentPaths(
  inspection: AgentPathInspection | undefined,
  workspaceTrusted: boolean
): AgentPathMap {
  const selected: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const scopes = [inspection?.defaultValue, inspection?.globalValue];
  if (workspaceTrusted) {
    scopes.push(inspection?.workspaceValue, inspection?.workspaceFolderValue);
  }

  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    for (const [agentId, configuredPath] of Object.entries(scope)) {
      if (typeof configuredPath === "string" && configuredPath !== "") {
        selected[agentId] = configuredPath;
      }
    }
  }
  return selected;
}
