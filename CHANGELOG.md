# Changelog

## [1.4.0](https://github.com/omercnet/vscode-acp/compare/v1.3.0...v1.4.0) (2026-02-28)


### Features

* Add terminal output embedding with ANSI colors ([#76](https://github.com/omercnet/vscode-acp/issues/76)) ([f2ca25f](https://github.com/omercnet/vscode-acp/commit/f2ca25fb162f438468ce3f8824a6b12897aa5222))
* display agent thought chunks ([#66](https://github.com/omercnet/vscode-acp/issues/66)) ([6765218](https://github.com/omercnet/vscode-acp/commit/676521871d2286af14ae64ce445a31084cbf9091))
* display tool kind icons ([#67](https://github.com/omercnet/vscode-acp/issues/67)) ([b0e8411](https://github.com/omercnet/vscode-acp/commit/b0e8411d3acc00e456aa37ba4b6b2a6e2e43e1ac))
* implement terminal integration and file system capabilities ([#64](https://github.com/omercnet/vscode-acp/issues/64)) ([e84663e](https://github.com/omercnet/vscode-acp/commit/e84663edd74ed572f2073a4b8381d1dfaa16b953))
* **kiro-cli:** add Kiro CLI to supported agents ([#89](https://github.com/omercnet/vscode-acp/issues/89)) ([3444585](https://github.com/omercnet/vscode-acp/commit/344458528577dcb2caea1cdf0750d6fb4585162e))
* split agent response messages when tools are executed ([#38](https://github.com/omercnet/vscode-acp/issues/38)) ([f7d15f5](https://github.com/omercnet/vscode-acp/commit/f7d15f59bb35547572ccf6abe2f0382a7ca1e6c5))
* **webview:** display file diffs for tool call results ([#83](https://github.com/omercnet/vscode-acp/issues/83)) ([3eea133](https://github.com/omercnet/vscode-acp/commit/3eea13369641d9dcce71b3e56c652780464a6737))


### Bug Fixes

* persist model and mode selection across VSCode reloads ([#35](https://github.com/omercnet/vscode-acp/issues/35)) ([16f4cd3](https://github.com/omercnet/vscode-acp/commit/16f4cd3c830e517059112d2d4b397838a45ec81b))
* resolve logo displaying as gray square in VSCode sidebar ([#71](https://github.com/omercnet/vscode-acp/issues/71)) ([c8b5a54](https://github.com/omercnet/vscode-acp/commit/c8b5a54455db0c75d5c4483a55a58b334ed7cfea))
* **ui:** Pin plan view at top of chat ([#60](https://github.com/omercnet/vscode-acp/issues/60)) ([#75](https://github.com/omercnet/vscode-acp/issues/75)) ([6f629c3](https://github.com/omercnet/vscode-acp/commit/6f629c3905789b705589013e254f9e0bbb1e8efa))
* update qwen-code CLI command and ACP capabilities ([#73](https://github.com/omercnet/vscode-acp/issues/73)) ([837f509](https://github.com/omercnet/vscode-acp/commit/837f509e9cf957eb4d3936a9d212e527fb9c45cf))

## [1.3.0](https://github.com/omercnet/vscode-acp/compare/v1.2.0...v1.3.0) (2025-12-28)


### Features

* add agent plan display UI ([#27](https://github.com/omercnet/vscode-acp/issues/27)) ([b92618e](https://github.com/omercnet/vscode-acp/commit/b92618ef874ae0b2fc6296a373a31785dedbe9e7))
* add agent plan display UI ([#34](https://github.com/omercnet/vscode-acp/issues/34)) ([8e2fe65](https://github.com/omercnet/vscode-acp/commit/8e2fe65eb991d133a7d59b452b378e99eeaef4fa))
* add screenshot tests for ANSI output and plan display ([#31](https://github.com/omercnet/vscode-acp/issues/31)) ([4bacf83](https://github.com/omercnet/vscode-acp/commit/4bacf83492608a205e954194abdc95263701895d))
* add terminal output with ANSI color support ([#28](https://github.com/omercnet/vscode-acp/issues/28)) ([72c0c78](https://github.com/omercnet/vscode-acp/commit/72c0c786e1811fb30a45e4a43789723bc72d6276))

## [1.2.0](https://github.com/omercnet/vscode-acp/compare/v1.1.0...v1.2.0) (2025-12-28)


### Features

* add slash command autocomplete support ([#18](https://github.com/omercnet/vscode-acp/issues/18)) ([62d9c41](https://github.com/omercnet/vscode-acp/commit/62d9c414dba77a3215fbbaf02f800fdfcd1237ce))

## [1.1.0](https://github.com/omercnet/vscode-acp/compare/v1.0.0...v1.1.0) (2025-12-25)

### Features

- testing infrastructure, UX improvements, and error handling ([#5](https://github.com/omercnet/vscode-acp/issues/5)) ([3137798](https://github.com/omercnet/vscode-acp/commit/3137798791716fb067c58716cfb64167e905671b))
- VS Code extension for Agent Client Protocol (ACP) ([7941f45](https://github.com/omercnet/vscode-acp/commit/7941f4569986b4b53a5600439c2b84c505908938))

### Bug Fixes

- rename publisher ([ce7e998](https://github.com/omercnet/vscode-acp/commit/ce7e9982a7eb6151e3ef502c6206bf2b0a734db3))
- use xvfb-run for tests on Linux in release workflow ([#12](https://github.com/omercnet/vscode-acp/issues/12)) ([6ca490f](https://github.com/omercnet/vscode-acp/commit/6ca490f64c8a09277c9ab044358f6b5714d32590))
