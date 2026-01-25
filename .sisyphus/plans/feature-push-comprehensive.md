# vscode-acp Feature Push - Comprehensive Plan

**Generated**: 2026-01-25  
**Goal**: Merge existing PRs and push product forward
**Strategy**: Merge ready work, create branches for new features

---

## Phase 1: Cleanup & Security (IMMEDIATE)

### Task 1: Merge Security Fix

- **PR**: #70
- **Title**: Bump qs from 6.14.0 to 6.14.1
- **Type**: Security vulnerability fix
- **CI**: ✅ All passing
- **Branch**: `dependabot/npm_and_yarn/npm_and_yarn-2b901f0e0d`
- **Action**: `gh pr merge 70 --squash`
- **Rationale**: Security fixes should be merged immediately

### Task 2: Merge Dependency Pins

- **PR**: #68
- **Title**: Pin dependencies (Renovate)
- **Type**: Maintenance
- **CI**: ✅ All passing
- **Branch**: `renovate/pin-dependencies`
- **Action**: `gh pr merge 68 --squash`
- **Rationale**: Low risk, good for reproducibility

### Task 3: Close Duplicate PR

- **PR**: #61
- **Title**: Pin plan to top of chat viewport
- **Type**: Duplicate of merged #75
- **CI**: ✅ All passing
- **Action**: `gh pr close 61 --comment "Closing as duplicate - this feature was already merged in PR #75"`
- **Rationale**: Avoid confusion

---

## Phase 2: Core Capabilities (HIGH PRIORITY)

### Task 4: Merge Terminal + FS Capabilities

- **PR**: #64
- **Title**: Implement terminal integration and file system capabilities
- **Type**: Feature (implements issues #39 and #40)
- **CI**: ✅ All passing
- **Branch**: `feat/terminal-integration`
- **Parallelizable**: No (blocks Task 5)
- **Action**:
  ```bash
  gh pr merge 64 --squash
  ```
- **Capabilities Added**:
  - `terminal/create`
  - `terminal/output`
  - `terminal/wait_for_exit`
  - `terminal/kill`
  - `terminal/release`
  - `fs/read_text_file`
  - `fs/write_text_file`
- **Tests**: Includes placeholder test file
- **Rationale**: Foundational capabilities needed by agents

### Task 5: Create PR to Advertise Capabilities ⚠️ CRITICAL

- **Title**: feat: advertise fs and terminal capabilities
- **Type**: Bug fix (capabilities won't work without this)
- **Branch**: `feat/advertise-client-capabilities`
- **Depends on**: Task 4 (PR #64 must be merged first)
- **Files to modify**:
  - `src/acp/client.ts` line 209
- **Change**:

  ```typescript
  // BEFORE:
  clientCapabilities: {},

  // AFTER:
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
  },
  ```

- **Tests**: Add integration tests showing agent can call capabilities
- **Action**:
  1. Create branch from main (after #64 merges)
  2. Update clientCapabilities
  3. Add tests
  4. Create PR
  5. Merge immediately
- **Rationale**: Without this, merged capabilities are useless!

### Task 6: Close Superseded PR

- **PR**: #63
- **Title**: Implement file system capabilities
- **Type**: Superseded by #64
- **Action**: `gh pr close 63 --comment "Closing - this functionality was merged as part of PR #64 which includes both filesystem AND terminal capabilities"`
- **Rationale**: PR #64 is more complete (fs + terminal)

---

## Phase 3: Permission & UX (MEDIUM PRIORITY)

### Task 7: Merge Permission Request UI

- **PR**: #62
- **Title**: Implement permission request UI
- **Type**: Feature (implements issue #49)
- **CI**: ⚠️ Partial (CodeQL only, no build tests)
- **Branch**: `feat/permission-request-ui`
- **Parallelizable**: Yes (independent of other PRs)
- **Action**:

  ```bash
  # First check why build tests didn't run
  gh pr view 62 --json statusCheckRollup

  # If CI is actually passing:
  gh pr merge 62 --squash
  ```

- **Features**:
  - Modal with Allow Once/Always, Reject
  - Keyboard navigation
  - Accessibility
- **Rationale**: Needed for safe agent operations

### Task 8: Merge Thought Chunks Display

- **PR**: #66
- **Title**: Display agent thought chunks
- **Type**: Feature (implements issue #45)
- **CI**: ✅ All passing
- **Branch**: `feat/agent-thought-chunks`
- **Parallelizable**: Yes
- **Action**: `gh pr merge 66 --squash`
- **Features**:
  - Shows agent reasoning
  - Collapsible panel
  - 💭 icon
  - 8 new tests
- **Rationale**: Great UX for understanding agent behavior

### Task 9: Merge Diff Display

- **PR**: #65
- **Title**: Add diff display for tool call results
- **Type**: Feature (implements issue #43)
- **CI**: ✅ All passing
- **Branch**: `feat/tool-call-diffs`
- **Parallelizable**: Yes
- **Action**: `gh pr merge 65 --squash`
- **Features**:
  - Visual diff (green +, red -)
  - File path headers
  - 18 new tests
- **Rationale**: Essential for code editing visibility

---

## Phase 4: Release

### Task 10: Merge Release PR

- **PR**: #36
- **Title**: Release 1.4.0
- **Type**: Automated release
- **Action**: Let release-please auto-update, then merge
- **Note**: Will include all merged features

---

## Phase 5: New Features (BRANCHED PRs)

Each of these should be a separate branch + PR:

### Task 11: Resource Links in Prompts

- **Issue**: #56
- **Priority**: Medium
- **Branch**: `feat/resource-links-56`
- **Estimate**: 1-2 days
- **Description**: Support resource links in prompts per ACP spec
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Research ACP resource link spec
  3. Implement in prompt handler
  4. Add tests
  5. Create PR

### Task 12: MCP Server Configuration

- **Issue**: #55
- **Priority**: Medium
- **Branch**: `feat/mcp-server-config-55`
- **Estimate**: 3-5 days
- **Description**: Configure MCP servers
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Design configuration schema
  3. Implement MCP server initialization
  4. Add UI for configuration
  5. Add tests
  6. Create PR

### Task 13: Image Content in Prompts

- **Issue**: #41
- **Priority**: Medium
- **Branch**: `feat/image-content-41`
- **Estimate**: 2-3 days
- **Description**: Support image content in prompts
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Research ACP image content spec
  3. Implement image handling
  4. Add image preview in UI
  5. Add tests
  6. Create PR

### Task 14: Session Loading

- **Issue**: #42
- **Priority**: Medium
- **Branch**: `feat/session-loading-42`
- **Estimate**: 2-3 days
- **Description**: Load previous sessions
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Implement session/load RPC
  3. Add session history UI
  4. Add tests
  5. Create PR

### Task 15: Authentication Flow

- **Issue**: #48
- **Priority**: Medium
- **Branch**: `feat/auth-flow-48`
- **Estimate**: 3-4 days
- **Description**: Authentication for agents requiring it
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Research ACP auth spec
  3. Implement auth flow
  4. Add credential storage
  5. Add tests
  6. Create PR

### Task 16: Embedded Resource Context

- **Issue**: #47
- **Priority**: Medium
- **Branch**: `feat/embedded-resources-47`
- **Estimate**: 2-3 days
- **Description**: Support embedded resources in prompts
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Research ACP resource embedding spec
  3. Implement resource handling
  4. Add UI rendering
  5. Add tests
  6. Create PR

### Task 17: Protocol Version Negotiation

- **Issue**: #57
- **Priority**: Low-Medium
- **Branch**: `feat/protocol-negotiation-57`
- **Estimate**: 1-2 days
- **Description**: Handle version mismatches gracefully
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Implement version checking
  3. Add fallback/upgrade logic
  4. Add error messages
  5. Add tests
  6. Create PR

### Task 18: Model Selection UI Enhancement

- **Issue**: #58
- **Priority**: Low
- **Branch**: `feat/model-selection-ui-58`
- **Estimate**: 1 day
- **Description**: Enhance existing model dropdown
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Review current implementation
  3. Add enhancements (icons, descriptions, etc.)
  4. Add tests
  5. Create PR

### Task 19: Slash Command Input Hints

- **Issue**: #54
- **Priority**: Low
- **Branch**: `feat/slash-command-hints-54`
- **Estimate**: 1 day
- **Description**: Show descriptions for slash commands
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Add hint text to command autocomplete
  3. Add CSS styling
  4. Add tests
  5. Create PR

### Task 20: Agent-Initiated Mode Changes

- **Issue**: #53
- **Priority**: Low
- **Branch**: `feat/agent-mode-changes-53`
- **Estimate**: 1-2 days
- **Description**: Handle agent changing mode
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Add mode change listener
  3. Update UI state
  4. Add notification
  5. Add tests
  6. Create PR

### Task 21: Display Agent Info

- **Issue**: #52
- **Priority**: Low
- **Branch**: `feat/agent-info-display-52`
- **Estimate**: 1 day
- **Description**: Show agent metadata
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Extract agent info from session
  3. Add info panel to UI
  4. Add tests
  5. Create PR

### Task 22: Different Stop Reasons

- **Issue**: #51
- **Priority**: Low
- **Branch**: `feat/stop-reasons-51`
- **Estimate**: 1 day
- **Description**: Display why response stopped
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Parse stop_reason from response
  3. Add UI indicator
  4. Add tests
  5. Create PR

### Task 23: Tool Call Location Tracking

- **Issue**: #44
- **Priority**: Low
- **Branch**: `feat/tool-location-tracking-44`
- **Estimate**: 2-3 days
- **Description**: "Follow along" showing where tool operates
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Parse location from tool calls
  3. Add file/line highlighting
  4. Add jump-to functionality
  5. Add tests
  6. Create PR

### Task 24: Audio Content in Prompts

- **Issue**: #46
- **Priority**: Low
- **Branch**: `feat/audio-content-46`
- **Estimate**: 2-3 days
- **Description**: Support audio in prompts (low priority)
- **Parallelizable**: Yes
- **Steps**:
  1. Create branch
  2. Research ACP audio content spec
  3. Implement audio handling
  4. Add audio player UI
  5. Add tests
  6. Create PR

---

## Execution Strategy

### Immediate (Today)

```bash
# 1. Security & cleanup
gh pr merge 70 --squash  # Security fix
gh pr merge 68 --squash  # Pin dependencies
gh pr close 61 --comment "Duplicate of #75"

# 2. Core capabilities
gh pr merge 64 --squash  # Terminal + FS

# 3. CRITICAL: Advertise capabilities
git checkout main && git pull
git checkout -b feat/advertise-client-capabilities
# ... make changes ...
git add src/acp/client.ts src/test/
git commit -m "feat: advertise fs and terminal client capabilities"
git push -u origin feat/advertise-client-capabilities
gh pr create --title "feat: advertise fs and terminal client capabilities" --body "..."

# 4. Close superseded
gh pr close 63 --comment "Superseded by #64"
```

### This Week

```bash
# Permission & UX
gh pr merge 62 --squash  # Permission UI
gh pr merge 66 --squash  # Thought chunks
gh pr merge 65 --squash  # Diff display

# Release
gh pr merge 36 --squash  # Release 1.4.0
```

### Next Week (Parallel Branches)

Create all new feature branches in parallel:

```bash
for issue in 56 55 41 42 48 47 57 58 54 53 52 51 44 46; do
  # Get issue title
  title=$(gh issue view $issue --json title --jq .title)
  # Create branch
  branch="feat/issue-$issue"
  git checkout -b $branch main
  git push -u origin $branch
  # Create draft PR
  gh pr create --draft --title "WIP: $title (#$issue)" --body "Addresses #$issue"
done
```

---

## Risk Mitigation

### Risk: PR #64 + #63 Conflict

- **Mitigation**: Merge #64 first, close #63
- **Status**: Planned in tasks

### Risk: Capabilities Not Advertised

- **Mitigation**: Task 5 immediately after Task 4
- **Status**: Explicitly called out as CRITICAL

### Risk: Permission UI Partial CI

- **Mitigation**: Check CI status before merge
- **Status**: Task 7 includes check

### Risk: Too Many Parallel PRs

- **Mitigation**: Only create drafts, work on high-priority first
- **Status**: Phase 5 is drafts only

---

## Success Metrics

### Phase 1-4 Complete When:

- ✅ All 7 feature PRs merged
- ✅ Capabilities advertised and working
- ✅ Release 1.4.0 published
- ✅ 0 duplicate/superseded PRs

### Phase 5 Complete When:

- ✅ All 14 new features have draft PRs
- ✅ High-priority features (#56, #55, #41, #42) are in review
- ✅ Test coverage remains >80%

---

## Notes

### Current State

- **Version**: 1.3.0
- **Open PRs**: 9 (7 features, 2 deps)
- **Open Issues**: 20
- **Client Capabilities**: EMPTY ❌

### After Phase 1-4

- **Version**: 1.4.0
- **Open PRs**: 14 (all new features)
- **Open Issues**: 20 → 7 (13 implemented)
- **Client Capabilities**: fs + terminal ✅

### After Phase 5

- **Version**: 1.5.0+
- **Open PRs**: 0 (all merged)
- **Open Issues**: 20 → 0 (all implemented)
- **Client Capabilities**: Complete ACP support ✅
