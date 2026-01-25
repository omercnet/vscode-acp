# Learnings - Feature Gap Analysis

## [2026-01-25] Initial Setup

### vscode-acp Current State

- ✅ Filesystem: `fs/read_text_file`, `fs/write_text_file` fully implemented
- ✅ Terminal: All 5 operations (create, output, wait_for_exit, kill, release)
- ✅ UI Features: Thought chunks, diffs, permission UI, plan display, ANSI output, tool icons
- ⚠️ Client capabilities advertised: fs (read/write) + terminal only

### Research Completed

- OpenCode ACP documentation reviewed
- ACP protocol specification reviewed
- 19 open issues analyzed and prioritized
- 4 completed issues identified for closure (#49, #45, #43, #50)
- 3 fix issues created from review feedback (#78, #79, #80)

### Key Insights

- OpenCode supports ACP via `opencode acp` command
- OpenCode has built-in tools: bash, edit, write, read, grep, glob, list, lsp, patch, skill, todowrite, todoread, webfetch, question
- ACP spec defines baseline + optional methods
- JSON-RPC 2.0 over stdio for local agents

## [2026-01-25 11:30] Feature Gap Analysis Complete

### Key Findings

**OpenCode Compatibility**: ✅ GOOD
- All OpenCode built-in tools (bash, read, write, edit, grep, glob, patch) work with current vscode-acp
- vscode-acp has full fs (read/write) and terminal (5 methods) capabilities
- No critical gaps preventing OpenCode from functioning

**Protocol Implementation**: ⚠️ PARTIAL
- Baseline methods: ✅ initialize, session/new, session/prompt
- Missing baseline: ❌ authenticate (#48)
- Missing optional: ❌ session/load (#42), ⚠️ session/set_mode (partial, #53)

**User Demand Analysis**:
- All 18 open issues have 0 reactions and 0 comments
- Prioritization based on: protocol requirements, ecosystem impact, UX value

### Critical Gaps Identified

**NONE for basic functionality** - OpenCode works with current implementation.

### High-Impact Gaps

1. **#55: MCP Server Configuration** - Unlocks MCP ecosystem
2. **#42: Session Loading** - Resume work, maintain context
3. **#56: Resource Links** - File/web references in prompts

### Recommended Implementation Order

**Phase 1** (Week 1): Quality fixes
- #78: Permission UI critical issues
- #79: Diff display improvements  
- #80: Diff display accessibility

**Phase 2** (Weeks 2-3): High-impact features
- #55: MCP server configuration
- #42: Session loading
- #56: Resource links

**Phase 3** (Weeks 4-5): Protocol completeness
- #48: Authentication
- #41: Image content
- #47: Embedded resources
- #57: Protocol negotiation

**Phase 4** (Week 6+): UX polish
- #44, #53, #52, #51, #58, #54, #46

### Technical Insights

- vscode-acp advertises capabilities correctly (src/acp/client.ts:342)
- All handlers implemented in src/views/chat.ts (lines 254-488)
- Terminal uses pseudoterminal with child_process.spawn
- FS handlers check workspace.textDocuments for unsaved buffers
