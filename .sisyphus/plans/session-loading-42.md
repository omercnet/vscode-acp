# Session Loading Implementation Plan (Issue #42)

## Overview

Implement `session/load` capability to allow resuming previous conversation sessions for persistence across VS Code restarts.

## Current State

- Sessions are ephemeral - lost when VS Code closes
- No session persistence or history
- `mcpServers: []` always passed to `newSession()`

## Target State

- Persist session IDs to workspace storage
- Show session history picker
- Resume sessions with full conversation replay via `session/update` notifications
- Restore session state (modes, context, conversation history)

## Prerequisites

Agent must advertise `loadSession: true` capability in `InitializeResponse.agentCapabilities`

## Implementation Tasks

### Task 1: Add Session Storage Infrastructure ✅

**Parallelizable**: No
**Estimated Effort**: Medium
**Files to modify**:

- `src/views/chat.ts` - Add session storage methods
- `src/extension.ts` - Initialize storage on activation

**Requirements**:

- [x] Use `context.workspaceState` for workspace-specific sessions
- [x] Use `context.globalState` for global session history
- [x] Store session metadata: `{ sessionId, timestamp, cwd, lastMessage }`
- [x] Implement `saveSession()` method
- [x] Implement `loadSessionList()` method
- [x] Implement `deleteSession()` method

### Task 2: Check Agent Capability ✅

**Parallelizable**: No (depends on Task 1)
**Estimated Effort**: Small
**Files to modify**:

- `src/acp/client.ts` - Parse `loadSession` capability

**Requirements**:

- [x] Parse `InitializeResponse.agentCapabilities.loadSession`
- [x] Store capability flag in client state
- [x] Expose via getter method

### Task 3: Implement session/load Method

**Parallelizable**: No (depends on Task 2)
**Estimated Effort**: Medium
**Files to modify**:

- `src/acp/client.ts` - Add `loadSession()` method

**Requirements**:

- [ ] Add `loadSession(sessionId, cwd, mcpServers)` method
- [ ] Handle `session/update` notifications during replay
- [ ] Parse `user_message_chunk` and `agent_message_chunk`
- [ ] Return `SessionModeState` from response
- [ ] Handle errors gracefully

### Task 4: Handle Session Replay Notifications

**Parallelizable**: No (depends on Task 3)
**Estimated Effort**: Large
**Files to modify**:

- `src/views/chat.ts` - Handle replay messages
- `src/views/webview/main.ts` - Display replay UI

**Requirements**:

- [ ] Clear existing chat before replay
- [ ] Process `user_message_chunk` notifications
- [ ] Process `agent_message_chunk` notifications
- [ ] Show loading indicator during replay
- [ ] Rebuild message history in correct order
- [ ] Handle tool calls in replayed messages
- [ ] Update session state after replay completes

### Task 5: Add Session Picker UI

**Parallelizable**: Yes (can work in parallel with Task 4)
**Estimated Effort**: Large
**Files to modify**:

- `src/views/webview/main.ts` - Session picker modal
- `media/main.css` - Session picker styles

**Requirements**:

- [ ] Create session picker modal component
- [ ] Display session list with metadata (date, preview)
- [ ] Add search/filter functionality
- [ ] Show "New Session" option
- [ ] Add delete session button
- [ ] Handle session selection
- [ ] Show loading state during load

### Task 6: Add VS Code Commands

**Parallelizable**: Yes (can work in parallel with Tasks 4-5)
**Estimated Effort**: Small
**Files to modify**:

- `src/extension.ts` - Register commands
- `package.json` - Add command definitions

**Requirements**:

- [ ] Add "ACP: Load Session" command
- [ ] Add "ACP: New Session" command
- [ ] Add "ACP: Delete Session" command
- [ ] Add keyboard shortcuts
- [ ] Update command palette entries

### Task 7: Auto-save Current Session

**Parallelizable**: No (depends on Task 1)
**Estimated Effort**: Small
**Files to modify**:

- `src/views/chat.ts` - Auto-save on message

**Requirements**:

- [ ] Save session after each user message
- [ ] Save session after each agent response
- [ ] Update session metadata (lastMessage, timestamp)
- [ ] Handle session creation vs update

### Task 8: Add Session Management Settings

**Parallelizable**: Yes (can work in parallel with other tasks)
**Estimated Effort**: Small
**Files to modify**:

- `package.json` - Add settings schema

**Requirements**:

- [ ] Add `vscode-acp.sessions.autoSave` setting
- [ ] Add `vscode-acp.sessions.maxHistory` setting
- [ ] Add `vscode-acp.sessions.showPicker` setting
- [ ] Document settings in README

### Task 9: Add Comprehensive Tests

**Parallelizable**: Yes (can work in parallel with implementation)
**Estimated Effort**: Large
**Files to create/modify**:

- `src/test/session-storage.test.ts` - Storage tests
- `src/test/session-load.test.ts` - Load method tests
- `src/test/webview.test.ts` - UI tests

**Requirements**:

- [ ] Test session save/load/delete
- [ ] Test session replay handling
- [ ] Test capability checking
- [ ] Test error handling
- [ ] Test UI interactions
- [ ] Test auto-save behavior
- [ ] Mock storage APIs
- [ ] Mock ACP client responses

### Task 10: Update Documentation

**Parallelizable**: Yes (can work in parallel with implementation)
**Estimated Effort**: Small
**Files to modify**:

- `README.md` - Add session loading docs
- `CHANGELOG.md` - Add entry

**Requirements**:

- [ ] Document session loading feature
- [ ] Add usage examples
- [ ] Document settings
- [ ] Add screenshots/GIFs
- [ ] Update feature list

## Parallelization Strategy

**Phase 1 - Foundation** (Sequential):

1. Task 1: Session Storage Infrastructure
2. Task 2: Check Agent Capability
3. Task 3: Implement session/load Method

**Phase 2 - Core Features** (Parallel groups):

- Group A: Task 4 (Session Replay)
- Group B: Task 5 (Session Picker UI)
- Group C: Task 6 (VS Code Commands)
- Group D: Task 9 (Tests)

**Phase 3 - Polish** (Parallel):

- Task 7: Auto-save
- Task 8: Settings
- Task 10: Documentation

## Technical Notes

### ACP Protocol Reference

```typescript
// session/load request
{
  sessionId: string;
  cwd: string;
  mcpServers: McpServer[];
}

// session/load response
{
  modes?: SessionModeState;
}

// Replay notifications
{
  method: "session/update",
  params: {
    sessionId: string,
    update: {
      sessionUpdate: "user_message_chunk" | "agent_message_chunk",
      content: ContentBlock[]
    }
  }
}
```

### Storage Schema

```typescript
interface StoredSession {
  sessionId: string;
  timestamp: number;
  cwd: string;
  lastMessage: string; // Preview text
  messageCount: number;
}

// Workspace state key: "acp.sessions"
// Global state key: "acp.sessions.global"
```

### Error Handling

- Agent doesn't support `loadSession`: Show error, disable feature
- Session not found: Show error, remove from list
- Replay fails: Show error, allow retry or new session
- Storage quota exceeded: Implement LRU eviction

## Success Criteria

- [ ] Sessions persist across VS Code restarts
- [ ] Session picker shows recent sessions
- [ ] Session replay reconstructs full conversation
- [ ] Auto-save works reliably
- [ ] All tests pass
- [ ] Documentation complete
- [ ] No regressions in existing features

## References

- [ACP Session Setup - Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
- [VS Code Extension API - Storage](https://code.visualstudio.com/api/references/vscode-api#ExtensionContext)
- Issue #42: https://github.com/omercnet/vscode-acp/issues/42
