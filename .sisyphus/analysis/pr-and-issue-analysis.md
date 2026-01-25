# vscode-acp: PR and Issue Analysis

**Generated**: 2026-01-25  
**Purpose**: Comprehensive review of existing work and feature roadmap

---

## Executive Summary

### Current State

- **Open PRs**: 9 (7 feature PRs with implementations, 2 dependency updates)
- **Open Issues**: 20 (features ranging from high to low priority)
- **Client Capabilities**: Currently EMPTY (`clientCapabilities: {}`)
- **Recent Merges**: Plan view sticky, terminal output embedding, tool kind icons

### Key Finding

**There are 7 feature PRs with COMPLETE implementations sitting unmerged:**

1. PR #64 - Terminal integration (fs + terminal capabilities) ✅
2. PR #63 - File system capabilities (fs/read, fs/write) ✅
3. PR #62 - Permission request UI ✅
4. PR #66 - Agent thought chunks display ✅
5. PR #65 - Tool call diff display ✅
6. PR #61 - Plan sticky header (duplicate of merged #75) ⚠️

**All PRs have passing CI** - ready to merge immediately.

---

## Open PRs (Detailed Analysis)

### Category: Feature PRs (Ready to Merge)

#### PR #64: Terminal Integration + FS Capabilities

- **Branch**: `feat/terminal-integration`
- **Status**: ✅ All CI passing
- **Impact**: HIGH (implements issues #39 and #40)
- **Commits**: 3
- **Capabilities Added**:
  - `terminal/create` - Create terminal with command execution
  - `terminal/output` - Get output with truncation
  - `terminal/wait_for_exit` - Wait for completion
  - `terminal/kill` - Kill running command
  - `terminal/release` - Clean up resources
- **Edge Cases**: No workspace folder, output truncation (UTF-8), process cleanup, orphan handling
- **Tests**: Includes test file for fs/read_text_file
- **Dependencies**: None
- **Merge Recommendation**: **MERGE FIRST** (foundational capabilities)

#### PR #63: File System Capabilities

- **Branch**: `feat/filesystem-capabilities`
- **Status**: ✅ All CI passing
- **Impact**: HIGH (implements issue #39)
- **Commits**: 2
- **Capabilities Added**:
  - `fs/read_text_file` - Read with optional line range
  - `fs/write_text_file` - Write content to files
- **Edge Cases**: Negative line values, trailing newlines, open editors, error messages
- **Tests**: Placeholder tests exist
- **Merge Recommendation**: **MERGE AFTER #64** (may have overlap)
- **Note**: Likely superseded by #64 which includes both fs + terminal

#### PR #62: Permission Request UI

- **Branch**: `feat/permission-request-ui`
- **Status**: ⚠️ CI partial (no build tests, only CodeQL)
- **Impact**: HIGH (implements issue #49)
- **Commits**: 5
- **Features**:
  - Modal UI with "Allow Once", "Always Allow", "Reject"
  - Keyboard navigation (Escape, Tab)
  - Accessibility (ARIA, focus management)
  - Theme-aware styling
  - Memory leak fixes
- **Manual Testing**: Screenshot shows working UI
- **Merge Recommendation**: **MERGE THIRD** (UX enhancement for capabilities)

#### PR #66: Agent Thought Chunks Display

- **Branch**: `feat/agent-thought-chunks`
- **Status**: ✅ All CI passing
- **Impact**: MEDIUM (implements issue #45)
- **Commits**: 3
- **Features**:
  - Displays agent reasoning in collapsible panel
  - 💭 icon, muted italic styling
  - Real-time streaming
  - Accessibility (role, aria-live, aria-label)
- **Tests**: 8 new tests
- **Merge Recommendation**: **MERGE FOURTH** (UX enhancement)

#### PR #65: Tool Call Diff Display

- **Branch**: `feat/tool-call-diffs`
- **Status**: ✅ All CI passing
- **Impact**: MEDIUM (implements issue #43)
- **Commits**: 3
- **Features**:
  - Visual diff rendering (green +, red -, gray context)
  - File path header
  - Syntax detection
  - Union types: `DiffContent`, `ContentBlock`, `TerminalContent`
- **Tests**: 18 new tests
- **Merge Recommendation**: **MERGE FIFTH** (UX enhancement)

#### PR #61: Plan Sticky Header

- **Branch**: `fix/plan-sticky-header`
- **Status**: ✅ All CI passing
- **Impact**: LOW (duplicate of merged #75)
- **Commits**: 2
- **Note**: **CLOSE THIS PR** - Same feature as PR #75 which was already merged
- **Action**: Close with comment explaining #75 was merged

### Category: Dependency Updates

#### PR #70: Bump qs 6.14.0 → 6.14.1

- **Type**: Security fix
- **CI**: ✅ All passing
- **Merge Recommendation**: **MERGE IMMEDIATELY** (security)

#### PR #68: Pin dependencies (Renovate)

- **Type**: Maintenance
- **CI**: ✅ All passing
- **Merge Recommendation**: **MERGE AFTER #70** (low risk)

#### PR #36: Release 1.4.0

- **Type**: Automated release PR
- **Status**: Waiting for merges
- **Action**: Will auto-update when features merge

---

## Open Issues (Prioritized)

### Priority: HIGH (Impact + Community Need)

#### #49: Permission Request UI ✅

- **Status**: IMPLEMENTED (PR #62)
- **Action**: Merge PR #62

#### #40: Terminal Integration ✅

- **Status**: IMPLEMENTED (PR #64)
- **Action**: Merge PR #64

#### #39: File System Capabilities ✅

- **Status**: IMPLEMENTED (PR #63 and #64)
- **Action**: Merge PR #64 (supersedes #63)

### Priority: MEDIUM

#### #56: Resource Links in Prompts

- **Type**: Enhancement
- **Area**: prompt-content
- **Status**: Not started
- **Description**: Support resource links in prompts per ACP spec

#### #55: MCP Server Configuration

- **Type**: Enhancement
- **Area**: config
- **Status**: Not started
- **Description**: Configure MCP servers

#### #48: Authentication Flow

- **Type**: Enhancement
- **Area**: session
- **Status**: Not started
- **Description**: Implement auth flow for agents requiring authentication

#### #47: Embedded Resource Context

- **Type**: Enhancement
- **Area**: prompt-content
- **Status**: Not started
- **Description**: Support embedded resources in prompts

#### #43: Tool Call Diffs ✅

- **Status**: IMPLEMENTED (PR #65)
- **Action**: Merge PR #65

#### #42: Session Loading

- **Type**: Enhancement
- **Area**: session
- **Status**: Not started
- **Description**: Implement session/load to restore previous sessions

#### #41: Image Content in Prompts

- **Type**: Enhancement
- **Area**: prompt-content
- **Status**: Not started
- **Description**: Support image content in prompts

### Priority: LOW

#### #58: Model Selection UI

- **Type**: Enhancement
- **Area**: ui-ux
- **Status**: Not started
- **Note**: Model dropdown already exists, may need enhancement

#### #57: Protocol Version Negotiation

- **Type**: Enhancement
- **Area**: protocol
- **Status**: Not started
- **Description**: Handle version mismatches gracefully

#### #54: Slash Command Input Hints

- **Type**: Enhancement
- **Area**: ui-ux
- **Status**: Not started
- **Description**: Show hints/descriptions for slash commands

#### #53: Agent-Initiated Mode Changes

- **Type**: Enhancement
- **Area**: config
- **Status**: Not started
- **Description**: Handle when agent changes mode

#### #52: Display Agent Info

- **Type**: Enhancement
- **Area**: ui-ux
- **Status**: Not started
- **Description**: Show agent metadata in UI

#### #51: Different Stop Reasons

- **Type**: Enhancement
- **Area**: ui-ux
- **Status**: Not started
- **Description**: Display different stop reasons (length, stop sequence, etc.)

#### #50: Tool Kind Icons

- **Type**: Enhancement
- **Area**: tool-display
- **Status**: ✅ MERGED (PR #67)
- **Action**: Close issue

#### #46: Audio Content in Prompts

- **Type**: Enhancement
- **Area**: prompt-content
- **Status**: Not started
- **Description**: Support audio in prompts (low priority)

#### #45: Agent Thought Chunks ✅

- **Status**: IMPLEMENTED (PR #66)
- **Action**: Merge PR #66

#### #44: Tool Call Location Tracking

- **Type**: Enhancement
- **Area**: tool-display
- **Status**: Not started
- **Description**: "Follow along" feature showing where tool operates

---

## Current Implementation Status

### Client Capabilities (Currently Advertised)

```typescript
clientCapabilities: {
} // EMPTY!
```

**Problem**: Agent cannot use ANY client-side capabilities because we don't advertise them.

### What's Implemented (But Not Advertised)

Based on PR #64:

- ✅ `terminal/*` - Full terminal integration
- ✅ `fs/read_text_file` - Read files
- ✅ `fs/write_text_file` - Write files

**Once #64 merges, we MUST update clientCapabilities to**:

```typescript
clientCapabilities: {
  filesystem: {
    read_text_file: {},
    write_text_file: {}
  },
  terminal: {
    create: {},
    output: {},
    wait_for_exit: {},
    kill: {},
    release: {}
  }
}
```

---

## Merge Strategy (Recommended Order)

### Phase 1: Critical Fixes (Immediate)

1. ✅ **PR #70** - Security fix (qs dependency)
2. ✅ **PR #68** - Pin dependencies

### Phase 2: Core Capabilities (This Week)

3. ✅ **PR #64** - Terminal + FS capabilities (foundational)
   - **THEN**: Update `clientCapabilities` in client.ts
   - **CREATE**: New PR to advertise capabilities
4. ❌ **Close PR #63** - Superseded by #64
5. ✅ **PR #62** - Permission UI (needed for #64 interactions)

### Phase 3: UX Enhancements (Next Week)

6. ✅ **PR #66** - Thought chunks
7. ✅ **PR #65** - Diff display
8. ❌ **Close PR #61** - Duplicate of merged #75

### Phase 4: Release

9. ✅ **Merge PR #36** - Release 1.4.0 (auto-updates)

---

## New Work Needed

### 1. Advertise Capabilities (Critical)

- **Issue**: After PR #64 merges, client still won't work
- **Fix**: Update `src/acp/client.ts` line 209
- **Create**: New PR `feat/advertise-capabilities`
- **Branch**: `feat/advertise-client-capabilities`

### 2. Resource Links in Prompts (#56)

- **Priority**: Medium
- **Complexity**: Medium
- **Estimate**: 1-2 days

### 3. MCP Server Configuration (#55)

- **Priority**: Medium
- **Complexity**: High
- **Estimate**: 3-5 days

### 4. Image Content Support (#41)

- **Priority**: Medium
- **Complexity**: Medium
- **Estimate**: 2-3 days

### 5. Session Loading (#42)

- **Priority**: Medium
- **Complexity**: Medium
- **Estimate**: 2-3 days

---

## Risk Analysis

### High Risk

- **PR #64 + #63 conflict**: Both implement fs capabilities. #64 is more complete.
  - **Mitigation**: Close #63, merge #64

### Medium Risk

- **Missing capability advertisement**: Even after merging capabilities, they won't work
  - **Mitigation**: Create follow-up PR immediately after #64

### Low Risk

- **PR #61 duplicate**: Confusing to have two identical PRs
  - **Mitigation**: Close #61 with explanation

---

## Next Actions (Immediate)

1. ✅ Merge PR #70 (security fix)
2. ✅ Merge PR #68 (dependency pins)
3. ✅ Merge PR #64 (terminal + fs)
4. ✅ Create PR to advertise capabilities in client.ts
5. ✅ Merge PR #62 (permission UI)
6. ✅ Close PR #63 (superseded by #64)
7. ✅ Close PR #61 (duplicate of #75)
8. ✅ Merge PR #66 (thought chunks)
9. ✅ Merge PR #65 (diffs)
10. ✅ Merge PR #36 (release)
11. ✅ Close issue #50 (already merged)

---

## Questions for Background Agents

Waiting on:

- `bg_52d09184` - OpenCode ACP feature analysis
- `bg_a448401e` - vscode-acp issue deep dive
- `bg_f7bfc387` - Current implementation exploration

Will update this document when agents complete.
