# Fix PR Feedback - Implementation Plan

**Generated**: 2026-01-25  
**Source**: Copilot reviews on PR #65 (Diff Display) and PR #62 (Permission UI)

---

## Branch Strategy

Each branch addresses a specific category of issues from the PR reviews.

---

## Branch 1: fix/permission-ui-critical-issues

**Priority**: CRITICAL  
**Target Issues**: PR #62 feedback  
**Estimated Time**: 2-3 hours

### Issues to Fix

#### 1. Memory Leaks (CRITICAL)

- **File**: `src/views/webview/main.ts`
- **Issue**: Event listeners not cleaned up when modal hides
- **Fix**: Use event delegation or cleanup listeners in `hidePermissionModal()`

#### 2. Promise Timeout (CRITICAL)

- **File**: `src/views/chat.ts`
- **Issue**: Permission promises never timeout, hang forever if webview closes
- **Fix**: Add timeout mechanism (30s default), reject on timeout

#### 3. Cleanup on Dispose (CRITICAL)

- **File**: `src/views/chat.ts`
- **Issue**: Pending requests not cleaned up on dispose
- **Fix**: Reject all pending promises in dispose method

#### 4. Concurrent Request Handling (HIGH)

- **File**: `src/views/webview/main.ts`
- **Issue**: Second permission request overwrites first
- **Fix**: Queue requests or reject new ones when modal open

#### 5. Empty Options Validation (HIGH)

- **File**: `src/views/webview/main.ts`
- **Issue**: Modal shows with no buttons if options array empty
- **Fix**: Validate options.length > 0, add default Cancel button

#### 6. JSON Stringify Safety (MEDIUM)

- **File**: `src/views/webview/main.ts`
- **Issue**: Can throw on circular refs
- **Fix**: Wrap in try-catch, provide fallback

### Tasks

```typescript
// Task 1: Event delegation for buttons
// BEFORE:
options.forEach(opt => {
  const btn = document.createElement('button');
  btn.addEventListener('click', () => this.respondToPermission(opt.optionId));
  container.appendChild(btn);
});

// AFTER:
container.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-option-id]');
  if (btn) this.respondToPermission(btn.dataset.optionId);
});

// Task 2: Add timeout to permission promises
// In src/views/chat.ts:
const PERMISSION_TIMEOUT = 30000; // 30 seconds
const timeoutId = setTimeout(() => {
  this.pendingPermissionRequests.delete(requestId);
  reject(new Error('Permission request timed out'));
}, PERMISSION_TIMEOUT);

// Task 3: Cleanup on dispose
dispose() {
  this.pendingPermissionRequests.forEach((pending) => {
    pending.reject(new Error('Webview disposed'));
  });
  this.pendingPermissionRequests.clear();
}
```

---

## Branch 2: fix/permission-ui-accessibility

**Priority**: HIGH  
**Target Issues**: PR #62 ARIA/a11y feedback  
**Estimated Time**: 2-3 hours

### Issues to Fix

#### 1. Keyboard Navigation (CRITICAL for a11y)

- **File**: `src/views/webview/main.ts`
- **Issue**: No Escape key to close modal
- **Fix**: Add keydown handler for Escape

#### 2. Focus Trap (CRITICAL for a11y)

- **File**: `src/views/webview/main.ts`
- **Issue**: Can tab outside modal (ARIA violation)
- **Fix**: Implement proper focus trap

#### 3. Focus Restoration (HIGH)

- **File**: `src/views/webview/main.ts`
- **Issue**: Focus not restored when modal closes
- **Fix**: Save activeElement on open, restore on close

#### 4. ARIA Labels (MEDIUM)

- **File**: HTML template in `src/views/chat.ts`
- **Issue**: Missing aria-describedby
- **Fix**: Add proper ARIA attributes

### Tasks

```typescript
// Task 1: Add keyboard handler
showPermissionModal() {
  // ... existing code ...

  this._modalKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelPermission();
    }
  };

  this.elements.permissionModal.addEventListener('keydown', this._modalKeyHandler);

  // Save focus
  this._previousFocus = document.activeElement as HTMLElement;
}

// Task 2: Focus trap
private trapFocus(modal: HTMLElement) {
  const focusable = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );

  const first = focusable[0] as HTMLElement;
  const last = focusable[focusable.length - 1] as HTMLElement;

  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}
```

---

## Branch 3: fix/diff-display-improvements

**Priority**: MEDIUM  
**Target Issues**: PR #65 feedback  
**Estimated Time**: 3-4 hours

### Issues to Fix

#### 1. Terminal Content Handling (HIGH)

- **File**: `src/views/webview/main.ts`
- **Issue**: Terminal type in union not handled
- **Fix**: Add terminal content handling in toolCallComplete

#### 2. Performance - Large Diffs (HIGH)

- **File**: `src/views/webview/main.ts`
- **Issue**: Large diffs cause performance issues
- **Fix**: Add max line limit (1000), show truncation notice

#### 3. Better Diff Algorithm (MEDIUM)

- **File**: `src/views/webview/main.ts`
- **Issue**: Simple line-by-line doesn't handle reordering
- **Fix**: Use diff library (e.g., `diff` npm package)

#### 4. Duplicate Interface (LOW)

- **File**: `src/views/webview/main.ts`
- **Issue**: DiffData duplicates DiffContent
- **Fix**: Remove DiffData, use DiffContent

#### 5. Incomplete Validation (MEDIUM)

- **File**: `src/views/webview/main.ts`
- **Issue**: isDiffData doesn't validate newText
- **Fix**: Add newText validation

### Tasks

```typescript
// Task 1: Handle terminal content
if (firstContent?.type === "terminal") {
  const terminalText = firstContent.text ?? firstContent.output;
  if (typeof terminalText === "string" && terminalText.trim()) {
    output = terminalText;
  }
}

// Task 2: Add line limit
const MAX_DIFF_LINES = 1000;
function renderDiff(diffData: DiffContent): string {
  const lines = computeDiffLines(diffData.oldText, diffData.newText);
  const isTruncated = lines.length > MAX_DIFF_LINES;
  const linesToRender = isTruncated ? lines.slice(0, MAX_DIFF_LINES) : lines;

  const truncationNotice = isTruncated
    ? `<div class="diff-truncated">Showing first ${MAX_DIFF_LINES} of ${lines.length} lines</div>`
    : "";

  // ... render ...
}

// Task 3: Better validation
function isDiffData(output: string): DiffContent | null {
  try {
    const parsed = JSON.parse(output);
    if (
      parsed?.type === "diff" &&
      typeof parsed.path === "string" &&
      typeof parsed.newText === "string" // <-- ADD THIS
    ) {
      return parsed as DiffContent;
    }
  } catch {
    return null;
  }
  return null;
}
```

---

## Branch 4: fix/diff-display-accessibility

**Priority**: MEDIUM  
**Target Issues**: PR #65 a11y feedback  
**Estimated Time**: 1-2 hours

### Issues to Fix

#### 1. Color-Only Differentiation (a11y violation)

- **File**: `media/main.css`
- **Issue**: Relies only on color for add/remove
- **Fix**: Add border styles, ensure WCAG contrast

#### 2. Long Path Truncation (UX)

- **File**: `src/views/webview/main.ts`, `media/main.css`
- **Issue**: Long paths truncated, info lost
- **Fix**: Add title attribute with full path

#### 3. Word Break (UX)

- **File**: `media/main.css`
- **Issue**: break-all makes code unreadable
- **Fix**: Use break-word or overflow-wrap

### Tasks

```css
/* Task 1: Add visual indicators beyond color */
.diff-add {
  background-color: var(--vscode-diffEditor-insertedTextBackground);
  border-left: 3px solid var(--vscode-diffEditor-insertedLineBackground);
}

.diff-remove {
  background-color: var(--vscode-diffEditor-removedTextBackground);
  border-left: 3px dashed var(--vscode-diffEditor-removedLineBackground);
}

/* Task 2: Better word break */
.diff-content {
  overflow-wrap: break-word;
  word-break: normal;
}
```

---

## Branch 5: fix/add-tests-for-feedback

**Priority**: LOW  
**Target Issues**: Missing test coverage mentioned in reviews  
**Estimated Time**: 2-3 hours

### Tests to Add

#### Permission UI Tests

- `showPermissionModal` displays modal correctly
- User interactions send correct messages
- Multiple concurrent requests handled
- Timeout mechanism works
- Cleanup on dispose works

#### Diff Display Tests

- Edge cases: very long lines, unicode, empty files
- Terminal content handling
- Large diff truncation
- isDiffData with missing newText

---

## Execution Plan

### Phase 1: Critical Fixes (Today)

1. Create `fix/permission-ui-critical-issues` branch
2. Fix memory leaks, timeouts, cleanup
3. Create PR, merge

### Phase 2: Accessibility (This Week)

4. Create `fix/permission-ui-accessibility` branch
5. Implement keyboard nav, focus trap
6. Create PR, merge

### Phase 3: Improvements (Next Week)

7. Create `fix/diff-display-improvements` branch
8. Better diff algo, performance improvements
9. Create PR, merge

10. Create `fix/diff-display-accessibility` branch
11. Visual indicators, better UX
12. Create PR, merge

### Phase 4: Testing (Later)

13. Create `fix/add-tests-for-feedback` branch
14. Add comprehensive tests
15. Create PR, merge

---

## Git Commands

```bash
# Phase 1
git checkout -b fix/permission-ui-critical-issues main
# ... implement fixes ...
git add .
git commit -m "fix: resolve critical permission UI issues (memory leaks, timeouts, cleanup)"
git push -u origin fix/permission-ui-critical-issues
gh pr create --title "fix: resolve critical permission UI issues" --body "Fixes memory leaks, promise timeouts, and cleanup issues identified in PR #62 review"

# Phase 2
git checkout -b fix/permission-ui-accessibility main
# ... implement fixes ...
git add .
git commit -m "fix: improve permission UI accessibility (keyboard nav, focus trap, ARIA)"
git push -u origin fix/permission-ui-accessibility
gh pr create --title "fix: improve permission UI accessibility" --body "Adds keyboard navigation, focus trap, and proper ARIA attributes per PR #62 review"

# Phase 3
git checkout -b fix/diff-display-improvements main
# ... implement fixes ...
git add .
git commit -m "fix: improve diff display (performance, terminal handling, validation)"
git push -u origin fix/diff-display-improvements
gh pr create --title "fix: improve diff display implementation" --body "Addresses performance, terminal content handling, and validation issues from PR #65 review"

git checkout -b fix/diff-display-accessibility main
# ... implement fixes ...
git add .
git commit -m "fix: improve diff display accessibility and UX"
git push -u origin fix/diff-display-accessibility
gh pr create --title "fix: improve diff display accessibility" --body "Adds visual indicators beyond color, improves path display, better word breaking per PR #65 review"

# Phase 4
git checkout -b fix/add-tests-for-feedback main
# ... implement tests ...
git add .
git commit -m "test: add coverage for permission UI and diff display"
git push -u origin fix/add-tests-for-feedback
gh pr create --title "test: add test coverage for recent features" --body "Adds tests for permission UI and diff display edge cases identified in reviews"
```

---

## Success Criteria

- [ ] All memory leaks fixed
- [ ] Promises timeout and cleanup properly
- [ ] Full keyboard navigation works
- [ ] Focus trap implemented
- [ ] WCAG accessibility compliance
- [ ] Large diffs perform well
- [ ] All edge cases tested
- [ ] All PRs merged
