# Tool Call Diffs Implementation (#43)

## Context

### Issue Summary

**Issue #43**: Display Tool Call Diffs - Render file diffs from tool calls with proper syntax highlighting and diff visualization.

**Current State**: Tool outputs shown as plain text, including raw diff content.

**Desired State**: When tool call content includes `type: "diff"`, render as unified diff with:

- Syntax highlighting
- Line indicators (add/remove/context)
- File path header
- Proper CSS styling (green for additions, red for deletions)

### Research Findings

**Type Definition Already Exists** (line 48, main.ts):

```typescript
export type ToolCallContentItem =
  | { type: "content"; content?: { type: "text"; text?: string } }
  | { type: "diff"; path?: string; oldText?: string; newText?: string }
  | { type: "terminal"; terminalId?: string };
```

**Current Tool Rendering** (lines 258-273, main.ts):

- `getToolsHtml()` renders tool.output as plain text
- ANSI codes are converted to HTML (hasAnsiCodes check)
- Terminal output gets special class
- **NO diff rendering logic**

**Message Flow**:

1. ACP agent sends `toolCallComplete` with `content` array
2. `chat.ts:537` passes `update.content` to webview
3. `main.ts:906-913` extracts output from content
4. Currently handles `type === "content"` and `type === "terminal"`
5. **Missing**: `type === "diff"` handling

### Key Files

- `src/views/webview/main.ts` - Rendering logic
- `media/main.css` - Styling
- `src/test/webview.test.ts` - Tests

---

## Work Objectives

### Core Objective

Add visual diff rendering for tool calls that include diff content, making file changes easy to understand at a glance.

### Concrete Deliverables

1. Diff rendering function that converts oldText/newText to unified diff HTML
2. Updated `getToolsHtml()` to detect and render diff content
3. CSS styles for diff visualization (additions, deletions, context)
4. Tests covering diff rendering edge cases

### Definition of Done

- [ ] Diff content is visually rendered (not plain text)
- [ ] Additions shown in green with `+` prefix
- [ ] Deletions shown in red with `-` prefix
- [ ] Context lines shown in gray
- [ ] File path displayed as header
- [ ] `npm test` passes with new diff rendering tests
- [ ] `npm run compile` succeeds with no TypeScript errors

### Must Have

- Simple line-by-line diff algorithm (no external dependencies)
- Proper escaping of HTML in diff content
- CSS using VS Code theme variables for colors
- Tests for: empty diffs, new files, deleted files, modified files

### Must NOT Have (Guardrails)

- NO side-by-side diff view (unified only for v1)
- NO syntax highlighting within diff (plain text is fine)
- NO external diff libraries (keep lightweight)
- NO changes to Tool interface structure
- NO changes to message flow from agent

---

## Verification Strategy (MANDATORY)

### Test Decision

- **Infrastructure exists**: YES (vscode-test with mocha)
- **User wants tests**: YES (quality matters)
- **Framework**: Tests in `src/test/webview.test.ts`

### Test Coverage Required

1. Empty diff (no changes)
2. New file (oldText = null)
3. Deleted file (newText = null)
4. Modified file (both oldText and newText)
5. Multi-line changes
6. HTML escaping in diff content

---

## Task Flow

```
Task 1 (Diff Algorithm)
    ↓
Task 2 (Integrate with getToolsHtml)
    ↓
Task 3 (CSS Styling)
    ↓
Task 4 (Update Tool Content Handling)
    ↓
Task 5 (Write Tests)
    ↓
Task 6 (Integration Verification)
```

## Parallelization

All tasks are sequential - each depends on the previous.

| Task | Depends On | Reason                           |
| ---- | ---------- | -------------------------------- |
| 2    | 1          | Needs diff algorithm to render   |
| 3    | 2          | Needs HTML structure to style    |
| 4    | 2          | Needs rendering function to call |
| 5    | 1,2,4      | Tests all components             |
| 6    | 1-5        | Final verification               |

---

## TODOs

- [x] 1. Implement simple diff algorithm

  **What to do**:
  - Create `computeLineDiff(oldText: string | null | undefined, newText: string | null | undefined)` function
  - Return array of `{ type: 'add' | 'remove' | 'context', line: string, lineNumber?: number }`
  - Handle edge cases: null oldText (new file), null newText (deleted file)
  - Use simple line-by-line comparison (split by \n, compare arrays)

  **Must NOT do**:
  - Don't use external diff libraries
  - Don't implement complex Myers algorithm (overkill)
  - Don't add line numbers yet (optional for v1)

  **References**:
  - `src/views/webview/main.ts` - Add function before `getToolsHtml()`
  - Simple diff: split lines, mark removed/added/unchanged

  **Acceptance Criteria**:
  - [ ] Function `computeLineDiff()` exists in main.ts
  - [ ] Returns correct diff for simple case (1 line added)
  - [ ] Handles null oldText (new file) - all lines marked 'add'
  - [ ] Handles null newText (deleted file) - all lines marked 'remove'
  - [ ] TypeScript compiles without errors

  **Commit**: YES
  - Message: `feat(diff): add simple line-by-line diff algorithm`
  - Files: `src/views/webview/main.ts`

---

- [ ] 2. Create diff HTML renderer

  **What to do**:
  - Create `renderDiff(path: string | undefined, oldText: string | null | undefined, newText: string | null | undefined)` function
  - Use `computeLineDiff()` to get diff lines
  - Generate HTML with proper structure:
    ```html
    <div class="diff-container">
      <div class="diff-header">path/to/file.ts</div>
      <pre class="diff-content">
        <div class="diff-line diff-add">+ added line</div>
        <div class="diff-line diff-remove">- removed line</div>
        <div class="diff-line diff-context">  context line</div>
      </pre>
    </div>
    ```
  - Escape HTML in all line content using `escapeHtml()`
  - Truncate if diff > 500 lines

  **Must NOT do**:
  - Don't add syntax highlighting (future enhancement)
  - Don't add line numbers (keep simple for v1)

  **References**:
  - `src/views/webview/main.ts:226-326` - `getToolsHtml()` for structure patterns
  - `src/views/webview/main.ts:82-89` - `escapeHtml()` function

  **Acceptance Criteria**:
  - [ ] Function `renderDiff()` exists in main.ts
  - [ ] Returns HTML string with proper structure
  - [ ] All content is HTML-escaped
  - [ ] File path shown in header (if provided)
  - [ ] TypeScript compiles without errors

  **Commit**: YES
  - Message: `feat(diff): add diff HTML renderer`
  - Files: `src/views/webview/main.ts`

---

- [ ] 3. Add diff CSS styles

  **What to do**:
  - Add CSS classes to `media/main.css`:
    ```css
    .diff-container {
      margin: 8px 0;
    }
    .diff-header {
      font-weight: bold;
      color: var(--vscode-editor-foreground);
      margin-bottom: 4px;
    }
    .diff-content {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
    }
    .diff-line {
      padding: 2px 4px;
    }
    .diff-add {
      background-color: var(--vscode-diffEditor-insertedTextBackground);
      color: var(
        --vscode-diffEditor-insertedTextForeground,
        var(--vscode-editor-foreground)
      );
    }
    .diff-remove {
      background-color: var(--vscode-diffEditor-removedTextBackground);
      color: var(
        --vscode-diffEditor-removedTextForeground,
        var(--vscode-editor-foreground)
      );
    }
    .diff-context {
      color: var(--vscode-descriptionForeground);
    }
    ```

  **Must NOT do**:
  - Don't hardcode colors (use theme variables)
  - Don't add animations or transitions
  - Don't modify existing tool-output styles

  **References**:
  - `media/main.css` - Existing tool styles around line 150-200
  - VS Code theme variables: `--vscode-diffEditor-*`

  **Acceptance Criteria**:
  - [ ] Diff styles added to `media/main.css`
  - [ ] Uses VS Code theme variables (no hardcoded colors)
  - [ ] Styles render correctly in light and dark themes
  - [ ] Visual check: green additions, red deletions, gray context

  **Commit**: YES
  - Message: `style(diff): add CSS for diff visualization`
  - Files: `media/main.css`

---

- [ ] 4. Integrate diff rendering with tool content handling

  **What to do**:
  - Update `toolCallComplete` handler in `main.ts` (around line 906)
  - Add check for `firstContent.type === "diff"`
  - Call `renderDiff()` and store in `tool.output`
  - Update `Tool` interface to support content array (or keep as string and render inline)

  **Current code** (lines 906-913):

  ```typescript
  if (msg.content && msg.content.length > 0) {
    const firstContent = msg.content[0];
    if (firstContent.type === "content" && firstContent.content?.text) {
      output = firstContent.content.text;
    } else if (firstContent.type === "terminal") {
      output = msg.terminalOutput || "";
    }
    // ADD: handle type === "diff"
  }
  ```

  **Must NOT do**:
  - Don't change Tool interface if not necessary
  - Don't break existing terminal/content handling
  - Don't modify message flow from chat.ts

  **References**:
  - `src/views/webview/main.ts:901-928` - toolCallComplete handler
  - `src/views/webview/main.ts:21-27` - Tool interface

  **Acceptance Criteria**:
  - [ ] Diff content type is detected and handled
  - [ ] `renderDiff()` is called with correct parameters
  - [ ] Rendered HTML is stored in tool.output
  - [ ] Existing content/terminal handling still works
  - [ ] TypeScript compiles without errors
  - [ ] Manual test: Tool with diff content renders visually

  **Commit**: YES
  - Message: `feat(diff): integrate diff rendering with tool display`
  - Files: `src/views/webview/main.ts`

---

- [ ] 5. Add comprehensive tests

  **What to do**:
  - Add test suite to `src/test/webview.test.ts`
  - Test `computeLineDiff()`:
    - Empty strings
    - New file (null oldText)
    - Deleted file (null newText)
    - Single line change
    - Multi-line changes
  - Test `renderDiff()`:
    - HTML escaping (< > & characters)
    - File path display
    - Truncation of large diffs
    - All diff line types (add/remove/context)
  - Test integration:
    - ToolCallContentItem with type: "diff" renders correctly

  **Must NOT do**:
  - Don't test the Tool rendering flow end-to-end (unit tests only)
  - Don't add E2E tests (can be added later)

  **References**:
  - `src/test/webview.test.ts` - Existing test patterns
  - `src/views/webview/main.ts` - Functions to test

  **Acceptance Criteria**:
  - [ ] Test file updated with diff rendering tests
  - [ ] `npm test` - all new tests PASS
  - [ ] Coverage: empty, new, deleted, modified files
  - [ ] Coverage: HTML escaping, truncation
  - [ ] All tests run in < 5 seconds

  **Commit**: YES
  - Message: `test(diff): add comprehensive diff rendering tests`
  - Files: `src/test/webview.test.ts`

---

- [ ] 6. Manual integration verification

  **What to do**:
  - Test with real agent that returns diff content
  - Verify visual rendering in extension
  - Test scenarios:
    - Agent edits a file (should show diff)
    - Agent creates new file (should show all green)
    - Agent deletes file (should show all red)
    - Multiple diffs in one tool call
  - Check light and dark themes

  **Must NOT do**:
  - Don't deploy without verification
  - Don't skip visual checks

  **References**:
  - Issue #43 for expected behavior

  **Acceptance Criteria**:
  - [ ] Manual test: Ask agent to edit a file → See visual diff
  - [ ] Manual test: Diff colors correct in light theme
  - [ ] Manual test: Diff colors correct in dark theme
  - [ ] Manual test: Long diffs are truncated properly
  - [ ] No console errors in webview
  - [ ] Screenshots taken for documentation

  **Commit**: NO (testing only)

---

## Commit Strategy

| After Task | Message                                                  | Files                       | Verification                     |
| ---------- | -------------------------------------------------------- | --------------------------- | -------------------------------- |
| 1          | `feat(diff): add simple line-by-line diff algorithm`     | `src/views/webview/main.ts` | TypeScript compiles              |
| 2          | `feat(diff): add diff HTML renderer`                     | `src/views/webview/main.ts` | TypeScript compiles              |
| 3          | `style(diff): add CSS for diff visualization`            | `media/main.css`            | Visual check                     |
| 4          | `feat(diff): integrate diff rendering with tool display` | `src/views/webview/main.ts` | TypeScript compiles, manual test |
| 5          | `test(diff): add comprehensive diff rendering tests`     | `src/test/webview.test.ts`  | `npm test`                       |

---

## Success Criteria

### Verification Commands

```bash
npm run compile     # TypeScript compiles successfully
npm test           # All tests pass
npm run lint       # No lint errors (if configured)
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Diff content renders visually (not plain text)
- [ ] Colors use VS Code theme variables
- [ ] HTML properly escaped
- [ ] Works in light and dark themes
- [ ] No TypeScript errors
- [ ] No console errors
- [ ] Manual verification complete
