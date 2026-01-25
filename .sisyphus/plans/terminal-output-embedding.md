# Terminal Output Embedding with ANSI Colors

## Context

### Bead

- ID: `vscode-acp--oktjg-mjphd3aumgl`
- Title: Add terminal output embedding with ANSI colors
- Type: task
- Priority: P3

### Current State

- Tool call content only extracts text: `msg.content?.[0]?.content?.text` (line 895 in main.ts)
- ExtensionMessage interface doesn't support full ToolCallContent union
- ANSI color support already exists in CSS (lines 102-481 in main.css)

### Desired State

- Support `ToolCallContent` type="terminal" in tool calls
- Display terminal output with ANSI colors when embedded
- Follow ACP spec: Terminal content has `{ type: "terminal", terminalId: string }`

## Work Objectives

### Core Objective

Enable display of terminal output embedded in tool calls with ANSI color rendering.

### Concrete Deliverables

1. Updated ExtensionMessage interface to support terminal content
2. Handler logic to extract terminal output from content array
3. Display terminal output with ANSI color support (reuse existing CSS)

### Definition of Done

- [ ] Tool calls with terminal content display output
- [ ] ANSI colors render correctly in terminal output
- [ ] `npm test` passes
- [ ] Build succeeds

## TODOs

- [x] 1. Update ExtensionMessage interface for terminal content

  **What to do**:
  - Update `content` field to support terminal type
  - Add `terminalId` field to ExtensionMessage
  - Match ACP SDK ToolCallContent union type

  **References**:
  - `src/views/webview/main.ts:46-74` - ExtensionMessage interface
  - `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` - ToolCallContent type

  **Commit**: NO (wait for full implementation)

---

- [x] 2. Extract terminal output from tool call content

  **What to do**:
  - Update toolCallComplete handler (line 891-905)
  - Check if content[0].type === "terminal"
  - If terminal, store terminalId and fetch output
  - If content, extract text as before
  - Handle diff type as well (for future)

  **Must NOT do**:
  - Don't break existing text content handling

  **References**:
  - `src/views/webview/main.ts:891-905` - toolCallComplete case
  - `src/views/chat.ts:195-215` - Tool call update forwarding

  **Commit**: NO (wait for full implementation)

---

- [x] 3. Display terminal output with ANSI colors

  **What to do**:
  - When terminal content detected, fetch output via terminal/output
  - Use existing `ansiToHtml()` function to render ANSI codes
  - Display in tool output area with terminal styling

  **References**:
  - `src/views/webview/main.ts:164-214` - ansiToHtml() function
  - `src/views/webview/main.ts:350-368` - tool output rendering

  **Commit**: YES
  - Message: `feat: add terminal output embedding with ANSI colors`
  - Files: `src/views/webview/main.ts`, `src/views/chat.ts`

## Success Criteria

- [ ] Terminal content in tool calls displays output
- [ ] ANSI colors render correctly
- [ ] `npm run compile` succeeds
- [ ] No TypeScript errors
