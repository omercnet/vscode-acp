# VSCode ACP Feature Push: Plan View + FS + Terminal Capabilities

## Context

### Original Request

Push vscode-acp forward by implementing core ACP features that enable agents to actually work: fix the plan view UX issue, and implement file system and terminal capabilities.

### Interview Summary

**Key Discussions**:

- Primary goal: Fix critical bugs and add high-impact features
- Timeline: 1-2 days (quick wins)
- Approach: Plan View fix first (quick), then FS + Terminal (high impact)
- Test strategy: TDD - write tests first

**Research Findings**:

- Current `clientCapabilities: {}` means agents can't access files or run commands
- Plan view appends to messages container and scrolls away (line 740 in main.ts)
- ACP SDK v0.12.0 provides `Client` interface with optional handlers:
  - `readTextFile?`, `writeTextFile?`
  - `createTerminal?`, `terminalOutput?`, `releaseTerminal?`, `killTerminal?`
- VS Code APIs: `workspace.fs`, `workspace.textDocuments`, `window.createTerminal()`

### Self-Review Gaps Identified

**Auto-resolved**:

- SDK interface verified - handlers are optional properties on Client
- Test infrastructure confirmed - uses vscode-test-cli with mock server pattern

**Defaults Applied**:

- Terminal output buffer: 100KB (standard limit)
- File read line limits: Follow ACP spec defaults

---

## Work Objectives

### Core Objective

Enable agents to perform real work by implementing ACP client capabilities (file system and terminal), and fix the plan view UX so users can track agent progress.

### Concrete Deliverables

1. Fixed plan view pinned at top of chat (CSS `position: sticky`)
2. FS capabilities: `fs/read_text_file`, `fs/write_text_file`
3. Terminal capabilities: `terminal/create`, `terminal/output`, `terminal/release`, `terminal/kill`
4. Client capabilities advertised during initialize()

### Definition of Done

- [ ] Plan view stays visible at top regardless of chat scroll position
- [ ] `npm test` passes with new capability tests
- [ ] Agent can read files (including unsaved editor buffers)
- [ ] Agent can write files
- [ ] Agent can execute terminal commands and get output
- [ ] No regressions in existing tests

### Must Have

- All 4 terminal methods implemented (create, output, release, kill)
- Both FS methods implemented (read, write)
- Plan view fixed at top
- Tests for each capability
- Capabilities advertised in initialize()

### Must NOT Have (Guardrails)

- NO permission UI changes (defer to #49)
- NO session persistence (defer to #42)
- NO wait_for_exit blocking implementation (can be added later)
- NO changes to agent selection or mode/model handling
- NO changes to message streaming logic
- Keep terminal implementation simple - no PTY complexity

---

## Verification Strategy (MANDATORY)

### Test Decision

- **Infrastructure exists**: YES (vscode-test-cli, mock server pattern)
- **User wants tests**: TDD
- **Framework**: vscode-test with mocha assertions

### TDD Structure

Each TODO follows RED-GREEN-REFACTOR:

1. **RED**: Write failing test first
2. **GREEN**: Implement minimum code to pass
3. **REFACTOR**: Clean up while keeping green

---

## Task Flow

```
Task 1 (Plan View CSS)
    ↓
Task 2 (Plan View Logic)
    ↓
Task 3 (FS Read Test) → Task 4 (FS Read Impl)
                            ↓
                       Task 5 (FS Write Test) → Task 6 (FS Write Impl)
                                                    ↓
                                               Task 7 (Terminal Tests) → Task 8 (Terminal Impl)
                                                                             ↓
                                                                        Task 9 (Advertise Capabilities)
                                                                             ↓
                                                                        Task 10 (Integration Test)
```

## Parallelization

| Group | Tasks | Reason                                         |
| ----- | ----- | ---------------------------------------------- |
| A     | 1, 2  | Plan view is independent of capabilities       |
| B     | 3-10  | Capabilities depend on each other sequentially |

| Task | Depends On | Reason                                              |
| ---- | ---------- | --------------------------------------------------- |
| 2    | 1          | CSS must exist before JS references it              |
| 4    | 3          | Implementation follows test                         |
| 6    | 5          | Implementation follows test                         |
| 8    | 7          | Implementation follows test                         |
| 9    | 6, 8       | Capabilities must be implemented before advertising |
| 10   | 9          | Integration test requires all pieces                |

---

## TODOs

- [x] 1. Add sticky plan view CSS styles

  **What to do**:
  - Add `.agent-plan-sticky` class with `position: sticky`, `top: 0`, `z-index: 10`
  - Style as header/banner (different from chat bubbles)
  - Add background color for visibility when scrolling
  - Make collapsible with `<details>` element

  **Must NOT do**:
  - Don't change existing `.agent-plan` class (will be used as fallback)
  - Don't add animations or transitions (keep simple)

  **Parallelizable**: YES (independent of JS changes)

  **References**:
  - `media/main.css` - Existing styles, add new `.agent-plan-sticky` class
  - `src/views/webview/main.ts:728-768` - Current `showPlan()` method for class naming context

  **Acceptance Criteria**:
  - [ ] New CSS class `.agent-plan-sticky` added to `media/main.css`
  - [ ] Manual verification: Open extension, plan element uses sticky positioning
  - [ ] Plan stays visible when scrolling through messages

  **Commit**: YES
  - Message: `fix(ui): add sticky positioning for plan view`
  - Files: `media/main.css`

---

- [x] 2. Move plan element outside messages container

  **What to do**:
  - Move `planEl` creation to be a sibling of `messagesEl`, not a child
  - Insert before `messagesEl` in DOM
  - Update `showPlan()` to use new sticky class
  - Update `hidePlan()` to handle new location
  - Ensure plan updates in place (don't re-append each time)

  **Must NOT do**:
  - Don't break existing plan entry rendering
  - Don't change plan data structure

  **Parallelizable**: NO (depends on Task 1 CSS)

  **References**:
  - `src/views/webview/main.ts:728-768` - `showPlan()` method to modify
  - `src/views/webview/main.ts:783-788` - `hidePlan()` method
  - `src/views/chat.ts:439-495` - HTML structure showing messages container

  **Acceptance Criteria**:
  - [ ] Test: Plan element is sibling of messages, not child
  - [ ] Manual verification using Playwright:
    - Navigate to extension sidebar
    - Send a message that triggers plan display
    - Scroll down through messages
    - Verify: Plan remains visible at top

  **Commit**: YES
  - Message: `fix(ui): pin plan view at top of chat (#60)`
  - Files: `src/views/webview/main.ts`, `src/views/chat.ts`

---

- [ ] 3. Write tests for fs/read_text_file capability

  **What to do**:
  - Create new test file `src/test/capabilities.test.ts`
  - Test: Mock server calls `readTextFile`, client returns file content
  - Test: Reading unsaved editor buffer returns buffer content
  - Test: Reading non-existent file returns appropriate error
  - Test: Line/limit parameters are respected

  **Must NOT do**:
  - Don't implement the actual capability yet (RED phase)

  **Parallelizable**: YES (after Task 2, parallel with nothing else)

  **References**:
  - `src/test/client.test.ts` - Test patterns and mock server usage
  - `src/test/mocks/acp-server.ts` - Mock server implementation to extend
  - `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` - `ReadTextFileRequest/Response` types

  **Acceptance Criteria**:
  - [ ] Test file `src/test/capabilities.test.ts` exists
  - [ ] `npm test` runs (tests FAIL - that's expected in RED phase)
  - [ ] Tests cover: success case, unsaved buffer, file not found, line limits

  **Commit**: YES
  - Message: `test(fs): add tests for read_text_file capability`
  - Files: `src/test/capabilities.test.ts`, `src/test/mocks/acp-server.ts`

---

- [ ] 4. Implement fs/read_text_file handler

  **What to do**:
  - Add `readTextFile` handler to `Client` object in `client.ts`
  - Check `workspace.textDocuments` first for unsaved buffers
  - Fall back to `workspace.fs.readFile()` for on-disk files
  - Handle `line` and `limit` parameters per ACP spec
  - Return `{ content: string }` response

  **Must NOT do**:
  - Don't handle binary files (text only per ACP spec)
  - Don't add capability advertisement yet (Task 9)

  **Parallelizable**: NO (depends on Task 3)

  **References**:
  - `src/acp/client.ts:154-176` - Existing `client` object to extend
  - VS Code API: `vscode.workspace.textDocuments` - Open editor buffers
  - VS Code API: `vscode.workspace.fs.readFile()` - File system access
  - ACP Spec: `https://agentclientprotocol.com/protocol/file-system#reading-files`

  **Acceptance Criteria**:
  - [ ] `npm test` - readTextFile tests PASS
  - [ ] Handler implemented in `client.ts`
  - [ ] Manual verification:
    ```
    # Open a file in VS Code, make unsaved changes
    # Send message to agent that triggers file read
    # Verify agent sees unsaved content
    ```

  **Commit**: YES
  - Message: `feat(fs): implement read_text_file capability`
  - Files: `src/acp/client.ts`

---

- [ ] 5. Write tests for fs/write_text_file capability

  **What to do**:
  - Add tests to `src/test/capabilities.test.ts`
  - Test: Mock server calls `writeTextFile`, file is created/updated
  - Test: Writing to existing file overwrites content
  - Test: Writing to new file creates it
  - Test: Invalid path returns appropriate error

  **Must NOT do**:
  - Don't implement the actual capability yet (RED phase)

  **Parallelizable**: NO (depends on Task 4)

  **References**:
  - `src/test/capabilities.test.ts` - Add to existing test file
  - `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` - `WriteTextFileRequest/Response` types

  **Acceptance Criteria**:
  - [ ] Tests added to `src/test/capabilities.test.ts`
  - [ ] `npm test` - new writeTextFile tests FAIL (RED phase)
  - [ ] Tests cover: create new file, overwrite existing, invalid path

  **Commit**: YES
  - Message: `test(fs): add tests for write_text_file capability`
  - Files: `src/test/capabilities.test.ts`

---

- [ ] 6. Implement fs/write_text_file handler

  **What to do**:
  - Add `writeTextFile` handler to `Client` object in `client.ts`
  - Use `workspace.fs.writeFile()` to write content
  - Create parent directories if needed
  - Return `{}` on success per ACP spec

  **Must NOT do**:
  - Don't add capability advertisement yet (Task 9)
  - Don't add permission checks (handled by agent, not client)

  **Parallelizable**: NO (depends on Task 5)

  **References**:
  - `src/acp/client.ts` - Add handler to client object
  - VS Code API: `vscode.workspace.fs.writeFile()`
  - ACP Spec: `https://agentclientprotocol.com/protocol/file-system#writing-files`

  **Acceptance Criteria**:
  - [ ] `npm test` - writeTextFile tests PASS
  - [ ] Handler implemented in `client.ts`
  - [ ] Manual verification:
    ```
    # Send message to agent that triggers file write
    # Verify file is created/updated on disk
    ```

  **Commit**: YES
  - Message: `feat(fs): implement write_text_file capability`
  - Files: `src/acp/client.ts`

---

- [ ] 7. Write tests for terminal capabilities

  **What to do**:
  - Add terminal tests to `src/test/capabilities.test.ts`
  - Test: `createTerminal` returns terminal ID
  - Test: `terminalOutput` returns command output
  - Test: `killTerminal` stops running command
  - Test: `releaseTerminal` cleans up resources
  - Update mock server to simulate terminal calls

  **Must NOT do**:
  - Don't implement the actual capability yet (RED phase)
  - Don't test `waitForExit` (out of scope)

  **Parallelizable**: NO (depends on Task 6)

  **References**:
  - `src/test/capabilities.test.ts` - Add to existing test file
  - `src/test/mocks/acp-server.ts` - Extend mock for terminal
  - `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` - Terminal types

  **Acceptance Criteria**:
  - [ ] Terminal tests added to `src/test/capabilities.test.ts`
  - [ ] `npm test` - new terminal tests FAIL (RED phase)
  - [ ] Tests cover: create, output, kill, release

  **Commit**: YES
  - Message: `test(terminal): add tests for terminal capabilities`
  - Files: `src/test/capabilities.test.ts`, `src/test/mocks/acp-server.ts`

---

- [ ] 8. Implement terminal capability handlers

  **What to do**:
  - Add terminal tracking Map: `Map<string, vscode.Terminal>`
  - Implement `createTerminal`: Use `vscode.window.createTerminal()`, return ID
  - Implement `terminalOutput`: Capture output (note: VS Code limitation - may need pseudo-terminal)
  - Implement `killTerminal`: Send SIGTERM to terminal process
  - Implement `releaseTerminal`: Dispose terminal, remove from map
  - Handle `outputByteLimit` parameter

  **Must NOT do**:
  - Don't implement `waitForExit` (blocking, out of scope)
  - Don't add capability advertisement yet (Task 9)
  - Don't over-engineer - simple implementation first

  **Parallelizable**: NO (depends on Task 7)

  **References**:
  - `src/acp/client.ts` - Add handlers to client object
  - VS Code API: `vscode.window.createTerminal()`
  - VS Code API: `vscode.Terminal` interface
  - ACP Spec: `https://agentclientprotocol.com/protocol/terminals`

  **Acceptance Criteria**:
  - [ ] `npm test` - terminal tests PASS
  - [ ] Handlers implemented in `client.ts`
  - [ ] Terminal map tracks active terminals
  - [ ] Manual verification:
    ```
    # Send message to agent that runs a command
    # Verify terminal appears in VS Code
    # Verify output is captured
    ```

  **Commit**: YES
  - Message: `feat(terminal): implement terminal capabilities`
  - Files: `src/acp/client.ts`

---

- [ ] 9. Advertise client capabilities in initialize()

  **What to do**:
  - Update `clientCapabilities` in `connect()` method
  - Add `fs: { readTextFile: true, writeTextFile: true }`
  - Add `terminal: true`
  - Verify capabilities are sent during initialization

  **Must NOT do**:
  - Don't add capabilities that aren't implemented
  - Don't change protocol version

  **Parallelizable**: NO (depends on Task 6, 8)

  **References**:
  - `src/acp/client.ts:207-214` - Current initialize() call
  - ACP Spec: `https://agentclientprotocol.com/protocol/initialization`

  **Acceptance Criteria**:
  - [ ] Test: Initialize response includes capabilities
  - [ ] `npm test` passes
  - [ ] `clientCapabilities` includes `fs` and `terminal`
  - [ ] Manual verification: Connect to agent, agent recognizes capabilities

  **Commit**: YES
  - Message: `feat(capabilities): advertise fs and terminal capabilities`
  - Files: `src/acp/client.ts`

---

- [ ] 10. Integration test with real agent

  **What to do**:
  - Manual testing with OpenCode
  - Verify agent can read files
  - Verify agent can write files
  - Verify agent can run terminal commands
  - Verify plan view stays pinned
  - Test issue #74 scenario (may be resolved now)

  **Must NOT do**:
  - Don't create automated integration tests (manual is fine for now)

  **Parallelizable**: NO (final task)

  **References**:
  - All previous tasks

  **Acceptance Criteria**:
  - [ ] Using Playwright or manual testing:
    - Connect to OpenCode
    - Ask agent to read a file → Verify success
    - Ask agent to write a file → Verify file created
    - Ask agent to run `ls` → Verify terminal output shown
    - Trigger plan display → Verify stays at top
  - [ ] Check if #74 is resolved (may have been due to missing capabilities)

  **Commit**: NO (testing only)

---

## Commit Strategy

| After Task | Message                                                      | Files                                   | Verification          |
| ---------- | ------------------------------------------------------------ | --------------------------------------- | --------------------- |
| 1          | `fix(ui): add sticky positioning for plan view`              | `media/main.css`                        | Visual check          |
| 2          | `fix(ui): pin plan view at top of chat (#60)`                | `main.ts`, `chat.ts`                    | `npm test`            |
| 3          | `test(fs): add tests for read_text_file capability`          | `capabilities.test.ts`                  | Tests fail (expected) |
| 4          | `feat(fs): implement read_text_file capability`              | `client.ts`                             | `npm test`            |
| 5          | `test(fs): add tests for write_text_file capability`         | `capabilities.test.ts`                  | Tests fail (expected) |
| 6          | `feat(fs): implement write_text_file capability`             | `client.ts`                             | `npm test`            |
| 7          | `test(terminal): add tests for terminal capabilities`        | `capabilities.test.ts`, `acp-server.ts` | Tests fail (expected) |
| 8          | `feat(terminal): implement terminal capabilities`            | `client.ts`                             | `npm test`            |
| 9          | `feat(capabilities): advertise fs and terminal capabilities` | `client.ts`                             | `npm test`            |

---

## Success Criteria

### Verification Commands

```bash
npm test           # All tests pass
npm run lint       # No lint errors
npm run compile    # Builds successfully
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Plan view pinned at top
- [ ] Agent can read files
- [ ] Agent can write files
- [ ] Agent can run terminal commands
- [ ] Capabilities advertised
