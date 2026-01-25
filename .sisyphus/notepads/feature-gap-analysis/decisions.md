# Decisions - Feature Gap Analysis

## [2026-01-25] Strategic Decisions

### Branch Strategy

- Each feature gets its own branch: `feat/<feature>-<issue-number>`
- Enables clean tracking and incremental progress
- Allows parallel development of independent features

### Prioritization Criteria

1. OpenCode support (if OpenCode has it, we should too)
2. User demand (issue reactions, comments)
3. Implementation complexity
4. Dependencies between features

### Analysis Approach

- Compare OpenCode's built-in tools with vscode-acp client capabilities
- Identify what OpenCode expects from ACP clients
- Determine which features are critical vs nice-to-have

## [2026-01-25 11:30] Roadmap Prioritization

### Decision: Focus on Quality First, Then Ecosystem

**Rationale**:
1. Fix existing features before adding new ones (technical debt)
2. MCP integration (#55) has highest ecosystem impact
3. Session loading (#42) has highest user value (resume work)
4. Resource links (#56) enable advanced prompt patterns

### Decision: Parallel Development Strategy

**Phase 1 fixes can run in parallel**:
- #78 (permission UI) - touches src/views/webview/permission.ts
- #79 (diff display) - touches src/views/webview/diff.ts
- #80 (diff accessibility) - touches src/views/webview/diff.ts (but different concerns)

**Phase 2 features can run in parallel**:
- #55 (MCP config) - new subsystem
- #42 (session loading) - touches session management
- #56 (resource links) - touches prompt handling

### Decision: Defer Low-Priority UX

**Rationale**:
- 0 user demand signals (no reactions/comments)
- Protocol completeness more important than polish
- Can batch multiple low-priority items in single PR later

### Decision: Branch Naming Convention

- Fixes: `fix/<feature>-<issue-number>`
- Features: `feat/<feature>-<issue-number>`
- Docs: `docs/<topic>`

### Decision: One Feature Per PR

**Rationale**:
- Easier review
- Cleaner git history
- Can merge incrementally
- Reduces merge conflicts
