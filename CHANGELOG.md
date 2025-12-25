# Changelog

All notable changes to the OpenCode ACP extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 (2025-12-25)


### Features

* testing infrastructure, UX improvements, and error handling ([#5](https://github.com/omercnet/vscode-acp/issues/5)) ([3137798](https://github.com/omercnet/vscode-acp/commit/3137798791716fb067c58716cfb64167e905671b))
* VS Code extension for Agent Client Protocol (ACP) ([7941f45](https://github.com/omercnet/vscode-acp/commit/7941f4569986b4b53a5600439c2b84c505908938))


### Bug Fixes

* rename publisher ([ce7e998](https://github.com/omercnet/vscode-acp/commit/ce7e9982a7eb6151e3ef502c6206bf2b0a734db3))

## [0.1.0] - 2025-12-25

### Added

- Initial release
- Chat interface with streaming responses
- Multi-agent support (OpenCode, Claude Code)
- Tool call visualization with expandable input/output
- Markdown rendering with syntax-highlighted code blocks
- Mode and model selection dropdowns
- Connection status indicator
- Activity bar icon and sidebar view

### Technical

- ACP client with JSON-RPC over stdio
- Agent registry with availability detection
- Webview-based chat UI
