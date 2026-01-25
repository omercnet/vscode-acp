# Feature Gap Analysis: vscode-acp vs OpenCode ACP

**Generated**: 2026-01-25  
**Status**: Preliminary (awaiting background agent analysis)

---

## Current vscode-acp Implementation

### ✅ Implemented Capabilities

#### Filesystem

- **fs/read_text_file** ✅
  - Location: `src/views/chat.ts:254`
  - Status: Fully implemented
  - Features: Line range support, editor buffer reading
- **fs/write_text_file** ✅
  - Location: `src/views/chat.ts:287`
  - Status: Fully implemented
  - Features: File creation, overwrite

#### Terminal

- **terminal/create** ✅
  - Location: `src/views/chat.ts:302`
  - Status: Fully implemented
- **terminal/output** ✅
  - Location: `src/views/chat.ts:416`
  - Status: Fully implemented
  - Features: Truncation support
- **terminal/wait_for_exit** ✅
  - Location: `src/views/chat.ts:439`
  - Status: Fully implemented
- **terminal/kill** ✅
  - Location: `src/views/chat.ts:463`
  - Status: Fully implemented
- **terminal/release** ✅
  - Location: `src/views/chat.ts:476`
  - Status: Fully implemented

#### UI Features

- **Agent thought chunks** ✅ (merged PR #66)
- **Tool call diffs** ✅ (merged PR #65)
- **Permission request UI** ✅ (merged PR #62)
- **Agent plan display** ✅ (merged PR #75)
- **Terminal ANSI output** ✅ (merged PR #76)
- **Tool kind icons** ✅ (merged PR #67)

### Advertised Capabilities

```typescript
clientCapabilities: {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
}
```

---

## Open Issues Analysis (23 issues)

### Critical / High Priority (User-Requested)

#### #49: Implement Permission Request UI

- **Status**: ✅ COMPLETED (PR #62 merged)
- **Impact**: HIGH
- **Close this issue**

#### #45: Display Agent Thought Chunks

- **Status**: ✅ COMPLETED (PR #66 merged)
- **Impact**: MEDIUM
- **Close this issue**

#### #43: Display Tool Call Diffs

- **Status**: ✅ COMPLETED (PR #65 merged)
- **Impact**: MEDIUM
- **Close this issue**

#### #50: Tool Kind Icons

- **Status**: ✅ COMPLETED (PR #67 merged)
- **Impact**: LOW
- **Close this issue**

### High Priority (Not Yet Implemented)

#### #56: Support Resource Links in Prompts

- **Type**: Protocol feature
- **Impact**: HIGH (required for advanced agent features)
- **Complexity**: MEDIUM
- **Description**: Support `resource://` links in prompts per ACP spec
- **Use Case**: Agent references files, web pages, or resources

#### #55: MCP Server Configuration

- **Type**: Infrastructure
- **Impact**: HIGH (enables MCP ecosystem)
- **Complexity**: HIGH
- **Description**: Configure and manage MCP servers
- **Use Case**: Extend agent capabilities with MCP tools

#### #48: Implement Authentication Flow

- **Type**: Protocol feature
- **Impact**: MEDIUM-HIGH (required for some agents)
- **Complexity**: MEDIUM
- **Description**: Handle agent authentication requirements
- **Use Case**: Agents requiring API keys or OAuth

#### #42: Implement Session Loading

- **Type**: Protocol feature
- **Impact**: MEDIUM (UX improvement)
- **Complexity**: MEDIUM
- **Description**: Load previous chat sessions
- **Use Case**: Resume work from previous session

### Medium Priority

#### #57: Protocol Version Negotiation & Error Handling

- **Type**: Protocol robustness
- **Impact**: MEDIUM
- **Complexity**: LOW-MEDIUM
- **Description**: Handle version mismatches gracefully

#### #47: Support Embedded Resource Context in Prompts

- **Type**: Protocol feature
- **Impact**: MEDIUM
- **Complexity**: MEDIUM
- **Description**: Embed resource content in prompts

#### #41: Support Image Content in Prompts

- **Type**: Protocol feature
- **Impact**: MEDIUM (multimodal support)
- **Complexity**: MEDIUM
- **Description**: Allow image attachments

#### #44: Tool Call Location Tracking

- **Type**: UX feature
- **Impact**: MEDIUM
- **Complexity**: MEDIUM
- **Description**: "Follow along" - show where tool operates

#### #53: Handle Agent-Initiated Mode Changes

- **Type**: Protocol feature
- **Impact**: LOW-MEDIUM
- **Complexity**: LOW
- **Description**: React when agent changes mode

#### #52: Display Agent Info

- **Type**: UX feature
- **Impact**: LOW
- **Complexity**: LOW
- **Description**: Show agent metadata/capabilities

### Low Priority

#### #58: Model Selection UI

- **Type**: UX improvement
- **Impact**: LOW (already exists, needs enhancement)
- **Complexity**: LOW
- **Description**: Improve model dropdown UI

#### #54: Slash Command Input Hints

- **Type**: UX improvement
- **Impact**: LOW
- **Complexity**: LOW
- **Description**: Show command descriptions

#### #51: Handle Different Stop Reasons

- **Type**: UX feature
- **Impact**: LOW
- **Complexity**: LOW
- **Description**: Display why response stopped

#### #46: Support Audio Content in Prompts

- **Type**: Protocol feature
- **Impact**: LOW (rare use case)
- **Complexity**: MEDIUM
- **Description**: Audio attachments

### Fix Issues (Created from Reviews)

#### #78: Permission UI Critical Issues

- **Type**: Bug fixes
- **Priority**: HIGH
- **Branch**: `fix/permission-ui-critical-issues`

#### #79: Diff Display Improvements

- **Type**: Improvements
- **Priority**: MEDIUM
- **Branch**: `fix/diff-display-improvements`

#### #80: Diff Display Accessibility

- **Type**: Accessibility
- **Priority**: MEDIUM
- **Branch**: `fix/diff-display-accessibility`

---

## OpenCode Client Requirements Analysis

### What OpenCode Built-in Tools Need

Based on ACP protocol spec and OpenCode documentation:

| OpenCode Tool                    | Client Capability Required                 | vscode-acp Status                |
| -------------------------------- | ------------------------------------------ | -------------------------------- |
| `bash`                           | `terminal/*`                               | ✅ Fully implemented (5 methods) |
| `read`                           | `fs/read_text_file`                        | ✅ Implemented                   |
| `write`                          | `fs/write_text_file`                       | ✅ Implemented                   |
| `edit`                           | `fs/read_text_file` + `fs/write_text_file` | ✅ Implemented                   |
| `grep`, `glob`, `list`           | `fs/read_text_file` (for file access)      | ✅ Implemented                   |
| `lsp`                            | No special client capability (agent-side)  | ✅ N/A                           |
| `patch`                          | `fs/read_text_file` + `fs/write_text_file` | ✅ Implemented                   |
| `skill`, `todowrite`, `todoread` | No client capability (agent-side)          | ✅ N/A                           |
| `webfetch`, `question`           | No client capability (agent-side)          | ✅ N/A                           |

**FINDING**: OpenCode's core tools work with vscode-acp's current capabilities (fs + terminal). No critical gaps for basic functionality.

---

## ACP Protocol Feature Gaps

### Baseline Protocol Methods

| Method           | Status         | Location                | Notes                    |
| ---------------- | -------------- | ----------------------- | ------------------------ |
| `initialize`     | ✅ Implemented | `src/acp/client.ts:340` | Advertises fs + terminal |
| `authenticate`   | ❌ Missing     | -                       | Issue #48                |
| `session/new`    | ✅ Implemented | `src/acp/client.ts:363` | Working                  |
| `session/prompt` | ✅ Implemented | `src/acp/client.ts:395` | Working                  |

### Optional Protocol Methods

| Method             | Status     | Priority | Issue |
| ------------------ | ---------- | -------- | ----- |
| `session/load`     | ❌ Missing | HIGH     | #42   |
| `session/set_mode` | ⚠️ Partial | MEDIUM   | #53   |

### Client Capabilities (Extended)

| Capability               | Status         | Priority | Issue | Impact                |
| ------------------------ | -------------- | -------- | ----- | --------------------- |
| **Filesystem**           |                |          |       |                       |
| `fs/read_text_file`      | ✅ Implemented | -        | -     | Core                  |
| `fs/write_text_file`     | ✅ Implemented | -        | -     | Core                  |
| **Terminal**             |                |          |       |                       |
| `terminal/create`        | ✅ Implemented | -        | -     | Core                  |
| `terminal/output`        | ✅ Implemented | -        | -     | Core                  |
| `terminal/wait_for_exit` | ✅ Implemented | -        | -     | Core                  |
| `terminal/kill`          | ✅ Implemented | -        | -     | Core                  |
| `terminal/release`       | ✅ Implemented | -        | -     | Core                  |
| **Content Types**        |                |          |       |                       |
| Text content             | ✅ Supported   | -        | -     | Core                  |
| Resource links           | ❌ Missing     | HIGH     | #56   | Enables file/web refs |
| Embedded resources       | ❌ Missing     | MEDIUM   | #47   | Inline content        |
| Image content            | ❌ Missing     | MEDIUM   | #41   | Multimodal            |
| Audio content            | ❌ Missing     | LOW      | #46   | Rare use case         |
| **Infrastructure**       |                |          |       |                       |
| MCP server config        | ❌ Missing     | HIGH     | #55   | Ecosystem access      |
| Authentication           | ❌ Missing     | MEDIUM   | #48   | Some agents need      |
| Session loading          | ❌ Missing     | HIGH     | #42   | Resume work           |
| Protocol negotiation     | ❌ Missing     | MEDIUM   | #57   | Robustness            |
| **UX Features**          |                |          |       |                       |
| Tool location tracking   | ❌ Missing     | MEDIUM   | #44   | Follow along          |
| Mode change handling     | ⚠️ Partial     | LOW      | #53   | Agent-initiated       |
| Agent info display       | ❌ Missing     | LOW      | #52   | Metadata              |
| Stop reason display      | ❌ Missing     | LOW      | #51   | Why stopped           |
| Model selection UI       | ⚠️ Exists      | LOW      | #58   | Needs polish          |
| Command hints            | ❌ Missing     | LOW      | #54   | Discoverability       |

---

## Definitive Feature Gaps

### Critical Gaps (OpenCode works, but limited)

**NONE** - OpenCode's core tools work with current vscode-acp capabilities.

### High-Impact Gaps (Significant UX/functionality improvement)

1. **#55: MCP Server Configuration**
   - **Impact**: Unlocks entire MCP ecosystem (tools, resources, prompts)
   - **Complexity**: HIGH (requires MCP SDK integration, config UI, lifecycle management)
   - **Blocker**: Without this, agents can't use MCP servers
   - **User demand**: 0 reactions (but foundational feature)

2. **#42: Session Loading**
   - **Impact**: Resume previous conversations, maintain context
   - **Complexity**: MEDIUM (requires session persistence, state restoration)
   - **Blocker**: Users lose work when closing VS Code
   - **User demand**: 0 reactions (but common request pattern)

3. **#56: Resource Links in Prompts**
   - **Impact**: Agents can reference files, web pages, resources in prompts
   - **Complexity**: MEDIUM (URI parsing, resource resolution, content fetching)
   - **Blocker**: Limits agent's ability to reference context
   - **User demand**: 0 reactions

### Medium-Impact Gaps (Protocol completeness)

4. **#48: Authentication Flow**
   - **Impact**: Required for some agents (API keys, OAuth)
   - **Complexity**: MEDIUM (secure storage, auth UI, token management)
   - **Blocker**: Some agents won't work without auth
   - **User demand**: 0 reactions

5. **#47: Embedded Resource Context**
   - **Impact**: Inline content in prompts (vs links)
   - **Complexity**: MEDIUM (content embedding, size limits)
   - **Blocker**: None (resource links cover most cases)
   - **User demand**: 0 reactions

6. **#41: Image Content Support**
   - **Impact**: Multimodal agents can see images
   - **Complexity**: MEDIUM (image encoding, display, size limits)
   - **Blocker**: Multimodal agents can't process images
   - **User demand**: 0 reactions

7. **#57: Protocol Version Negotiation**
   - **Impact**: Graceful handling of version mismatches
   - **Complexity**: LOW (version checking, error messages)
   - **Blocker**: None (current version works)
   - **User demand**: 0 reactions

8. **#44: Tool Call Location Tracking**
   - **Impact**: "Follow along" - show where tools operate
   - **Complexity**: MEDIUM (file tracking, editor navigation)
   - **Blocker**: None (UX enhancement)
   - **User demand**: 0 reactions

### Low-Impact Gaps (Polish)

9. **#53: Agent-Initiated Mode Changes**
   - **Impact**: React when agent changes mode
   - **Complexity**: LOW (event handling, UI update)
   - **User demand**: 0 reactions

10. **#52: Display Agent Info**
    - **Impact**: Show agent metadata/capabilities
    - **Complexity**: LOW (UI display)
    - **User demand**: 0 reactions

11. **#51: Handle Different Stop Reasons**
    - **Impact**: Show why response stopped
    - **Complexity**: LOW (message display)
    - **User demand**: 0 reactions

12. **#58: Model Selection UI**
    - **Impact**: Improve existing dropdown
    - **Complexity**: LOW (UI polish)
    - **User demand**: 0 reactions

13. **#54: Slash Command Input Hints**
    - **Impact**: Show command descriptions
    - **Complexity**: LOW (tooltip/hint display)
    - **User demand**: 0 reactions

14. **#46: Audio Content Support**
    - **Impact**: Audio attachments
    - **Complexity**: MEDIUM (audio encoding, playback)
    - **User demand**: 0 reactions (rare use case)

### Fix Issues (From Review Feedback)

15. **#78: Permission UI Critical Issues**
    - **Impact**: Memory leaks, timeouts, cleanup
    - **Complexity**: MEDIUM (debugging, refactoring)
    - **Priority**: HIGH (quality/stability)

16. **#79: Diff Display Improvements**
    - **Impact**: Performance, terminal handling, validation
    - **Complexity**: MEDIUM (optimization, edge cases)
    - **Priority**: MEDIUM (quality)

17. **#80: Diff Display Accessibility**
    - **Impact**: WCAG compliance, keyboard nav
    - **Complexity**: MEDIUM (accessibility testing, fixes)
    - **Priority**: MEDIUM (accessibility)

---

## Final Prioritized Roadmap

### Phase 1: Critical Fixes (Week 1)

**Goal**: Fix quality issues from review feedback

- [ ] **#78**: Permission UI Critical Issues
  - **Why**: Memory leaks and timeouts affect stability
  - **Complexity**: MEDIUM
  - **Branch**: `fix/permission-ui-critical-issues` (already created)
  - **Dependencies**: None
  - **Estimated effort**: 2-3 days

- [ ] **#79**: Diff Display Improvements
  - **Why**: Performance and edge case handling
  - **Complexity**: MEDIUM
  - **Branch**: `fix/diff-display-improvements` (already created)
  - **Dependencies**: None
  - **Estimated effort**: 2-3 days

- [ ] **#80**: Diff Display Accessibility
  - **Why**: WCAG compliance, keyboard navigation
  - **Complexity**: MEDIUM
  - **Branch**: `fix/diff-display-accessibility` (already created)
  - **Dependencies**: None
  - **Estimated effort**: 2-3 days

### Phase 2: High-Impact Features (Weeks 2-3)

**Goal**: Unlock major functionality and ecosystem

- [ ] **#55**: MCP Server Configuration
  - **Why**: Unlocks entire MCP ecosystem (biggest impact)
  - **Complexity**: HIGH
  - **Branch**: `feat/mcp-server-config-55`
  - **Dependencies**: None
  - **Estimated effort**: 5-7 days
  - **Deliverables**:
    - MCP server config UI
    - Server lifecycle management
    - Tool/resource/prompt integration
    - Config persistence

- [ ] **#42**: Session Loading
  - **Why**: Resume work, maintain context (high user value)
  - **Complexity**: MEDIUM
  - **Branch**: `feat/session-loading-42`
  - **Dependencies**: None
  - **Estimated effort**: 3-4 days
  - **Deliverables**:
    - Session persistence (messages, state)
    - Load session UI
    - Session list/search
    - State restoration

- [ ] **#56**: Resource Links in Prompts
  - **Why**: Enables file/web references in prompts
  - **Complexity**: MEDIUM
  - **Branch**: `feat/resource-links-56`
  - **Dependencies**: None
  - **Estimated effort**: 2-3 days
  - **Deliverables**:
    - `resource://` URI parsing
    - File resource resolution
    - Web resource fetching
    - Display in chat

### Phase 3: Protocol Completeness (Weeks 4-5)

**Goal**: Full ACP spec compliance

- [ ] **#48**: Authentication Flow
  - **Why**: Required for some agents
  - **Complexity**: MEDIUM
  - **Branch**: `feat/authentication-flow-48`
  - **Dependencies**: None
  - **Estimated effort**: 3-4 days
  - **Deliverables**:
    - Auth request handling
    - Secure credential storage
    - Auth UI flow
    - Token management

- [ ] **#41**: Image Content Support
  - **Why**: Multimodal agent support
  - **Complexity**: MEDIUM
  - **Branch**: `feat/image-content-41`
  - **Dependencies**: None
  - **Estimated effort**: 2-3 days
  - **Deliverables**:
    - Image encoding/decoding
    - Image display in chat
    - Size limit handling
    - Format support (PNG, JPEG, etc.)

- [ ] **#47**: Embedded Resource Context
  - **Why**: Inline content in prompts
  - **Complexity**: MEDIUM
  - **Branch**: `feat/embedded-resources-47`
  - **Dependencies**: #56 (resource links)
  - **Estimated effort**: 2-3 days

- [ ] **#57**: Protocol Version Negotiation
  - **Why**: Graceful version mismatch handling
  - **Complexity**: LOW
  - **Branch**: `feat/protocol-negotiation-57`
  - **Dependencies**: None
  - **Estimated effort**: 1-2 days

### Phase 4: UX Enhancements (Week 6+)

**Goal**: Polish and discoverability

- [ ] **#44**: Tool Call Location Tracking
  - **Why**: "Follow along" - show where tools operate
  - **Complexity**: MEDIUM
  - **Branch**: `feat/location-tracking-44`
  - **Dependencies**: None
  - **Estimated effort**: 2-3 days

- [ ] **#53**: Agent-Initiated Mode Changes
  - **Why**: React when agent changes mode
  - **Complexity**: LOW
  - **Branch**: `feat/mode-change-handling-53`
  - **Dependencies**: None
  - **Estimated effort**: 1 day

- [ ] **#52**: Display Agent Info
  - **Why**: Show agent metadata/capabilities
  - **Complexity**: LOW
  - **Branch**: `feat/agent-info-display-52`
  - **Dependencies**: None
  - **Estimated effort**: 1 day

- [ ] **#51**: Handle Different Stop Reasons
  - **Why**: Show why response stopped
  - **Complexity**: LOW
  - **Branch**: `feat/stop-reasons-51`
  - **Dependencies**: None
  - **Estimated effort**: 1 day

- [ ] **#58**: Model Selection UI Polish
  - **Why**: Improve existing dropdown
  - **Complexity**: LOW
  - **Branch**: `feat/model-selection-ui-58`
  - **Dependencies**: None
  - **Estimated effort**: 1 day

- [ ] **#54**: Slash Command Input Hints
  - **Why**: Discoverability
  - **Complexity**: LOW
  - **Branch**: `feat/command-hints-54`
  - **Dependencies**: None
  - **Estimated effort**: 1 day

### Phase 5: Advanced/Optional (Future)

**Goal**: Nice-to-have features

- [ ] **#46**: Audio Content Support
  - **Why**: Audio attachments (rare use case)
  - **Complexity**: MEDIUM
  - **Branch**: `feat/audio-content-46`
  - **Dependencies**: None
  - **Estimated effort**: 2-3 days

---

## Implementation Strategy

### Immediate Actions (This Session)

1. ✅ Sync with remote (git pull --rebase)
2. Merge dependency PRs (#70, #68) - low risk, automated
3. Create implementation plan for Phase 1 fixes (#78, #79, #80)
4. Start work on highest priority fix (#78)

### Branch Strategy

Each feature gets its own branch and PR:

```
fix/permission-ui-critical-issues    → Issue #78 (CREATED)
fix/diff-display-improvements        → Issue #79 (CREATED)
fix/diff-display-accessibility       → Issue #80 (CREATED)
feat/mcp-server-config-55            → Issue #55
feat/session-loading-42              → Issue #42
feat/resource-links-56               → Issue #56
feat/authentication-flow-48          → Issue #48
feat/image-content-41                → Issue #41
feat/embedded-resources-47           → Issue #47
feat/protocol-negotiation-57         → Issue #57
feat/location-tracking-44            → Issue #44
feat/mode-change-handling-53         → Issue #53
feat/agent-info-display-52           → Issue #52
feat/stop-reasons-51                 → Issue #51
feat/model-selection-ui-58           → Issue #58
feat/command-hints-54                → Issue #54
feat/audio-content-46                → Issue #46
```

### Parallel Development Opportunities

**Can work in parallel** (no file conflicts):

- Phase 1 fixes (#78, #79, #80) - different files
- Phase 2 features (#55, #42, #56) - different subsystems

**Must be sequential**:

- #47 depends on #56 (embedded resources need resource link foundation)

---

## Key Findings Summary

### ✅ What Works

- OpenCode's core tools (bash, read, write, edit, grep, glob, patch) work with current vscode-acp
- All baseline ACP protocol methods implemented
- Full fs and terminal capabilities

### ❌ What's Missing

- **High Priority**: MCP config (#55), session loading (#42), resource links (#56)
- **Medium Priority**: Auth (#48), images (#41), embedded resources (#47), protocol negotiation (#57)
- **Low Priority**: UX polish (#44, #53, #52, #51, #58, #54, #46)
- **Quality**: 3 fix issues from review feedback (#78, #79, #80)

### 🎯 Recommended Focus

1. **Week 1**: Fix quality issues (#78, #79, #80)
2. **Weeks 2-3**: Implement MCP config (#55), session loading (#42), resource links (#56)
3. **Weeks 4-5**: Protocol completeness (#48, #41, #47, #57)
4. **Week 6+**: UX polish (#44, #53, #52, #51, #58, #54)

---

## Analysis Complete

**Status**: ✅ COMPLETE  
**Date**: 2026-01-25  
**Next Action**: Begin Phase 1 implementation (fixes #78, #79, #80)
