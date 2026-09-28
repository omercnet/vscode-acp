# Changelog

## [1.6.0](https://github.com/omercnet/vscode-acp/compare/v1.5.0...v1.6.0) (2026-09-19)


### Features

* **attachments:** support rich prompt content ([#121](https://github.com/omercnet/vscode-acp/issues/121)) ([1fe9afb](https://github.com/omercnet/vscode-acp/commit/1fe9afb280432faf7b5966400ff813defe9dc1d4))
* **chat:** add editor selections to prompts ([#124](https://github.com/omercnet/vscode-acp/issues/124)) ([e72aa04](https://github.com/omercnet/vscode-acp/commit/e72aa043050f385aac2c616423e61004a82cedc0))
* **chat:** default ACP view to secondary sidebar ([#119](https://github.com/omercnet/vscode-acp/issues/119)) ([ae7023d](https://github.com/omercnet/vscode-acp/commit/ae7023d2c4bd12f1c10db26fd86f17ba27195425))
* **diagnostics:** add secret-safe ACP traffic tracing ([#128](https://github.com/omercnet/vscode-acp/issues/128)) ([cf01459](https://github.com/omercnet/vscode-acp/commit/cf014599936b576a8ec8ee481546ac7580ab0f5e))
* **mcp:** load trusted project configuration ([#123](https://github.com/omercnet/vscode-acp/issues/123)) ([6dec1a2](https://github.com/omercnet/vscode-acp/commit/6dec1a24a769ee5c2490a5ee1609f30858e08a7a))
* **session:** render ACP configuration options ([#126](https://github.com/omercnet/vscode-acp/issues/126)) ([5bc4874](https://github.com/omercnet/vscode-acp/commit/5bc4874114657c5d3f9bfcdda2a886dba083f16a))
* **sessions:** browse agent-owned sessions ([#125](https://github.com/omercnet/vscode-acp/issues/125)) ([3b362d9](https://github.com/omercnet/vscode-acp/commit/3b362d9c3a88227dae6874a68c65b8b7a5b07767))
* surface ACP protocol metadata ([#120](https://github.com/omercnet/vscode-acp/issues/120)) ([7046f0d](https://github.com/omercnet/vscode-acp/commit/7046f0d800980207d83aa374b0ddb5fd69bebe7f))


### Bug Fixes

* **acp:** preserve dirty editor changes ([#122](https://github.com/omercnet/vscode-acp/issues/122)) ([4c351ab](https://github.com/omercnet/vscode-acp/commit/4c351ab8f2f0f904495db196cb779bcff8eabdb9))
* **ci:** harden extension publication ([#115](https://github.com/omercnet/vscode-acp/issues/115)) ([4b55bc5](https://github.com/omercnet/vscode-acp/commit/4b55bc597f6903a407f06049e50ee608aaa946a1))
* **commands:** clarify agent-advertised slash commands ([#118](https://github.com/omercnet/vscode-acp/issues/118)) ([4b40c75](https://github.com/omercnet/vscode-acp/commit/4b40c75cc0196e82ec480c7aecd72e5041d38224))
* **sessions:** preserve bounded restoration metadata ([#127](https://github.com/omercnet/vscode-acp/issues/127)) ([e2d633e](https://github.com/omercnet/vscode-acp/commit/e2d633e5ea93befed68f945b8ee1a9316897b526))

## [1.5.0](https://github.com/omercnet/vscode-acp/compare/v1.4.0...v1.5.0) (2026-09-14)


### Features

* **acp:** add authentication handoff ([#105](https://github.com/omercnet/vscode-acp/issues/105)) ([e2705dc](https://github.com/omercnet/vscode-acp/commit/e2705dc3b349dd278f55c05c6afd7e26c07d9707))
* **acp:** classify structured protocol errors ([#101](https://github.com/omercnet/vscode-acp/issues/101)) ([db9e7df](https://github.com/omercnet/vscode-acp/commit/db9e7dfb1714635b82a0e23e5dc72853861fa448))
* **acp:** upgrade SDK to 1.4.0 ([#98](https://github.com/omercnet/vscode-acp/issues/98)) ([db08554](https://github.com/omercnet/vscode-acp/commit/db085543418bdf5fac23b075baecb89736a4e302))
* **chat:** add permission request UI for agent actions ([#84](https://github.com/omercnet/vscode-acp/issues/84)) ([5ee4fab](https://github.com/omercnet/vscode-acp/commit/5ee4fabaced581cd0c77369b163d183a7b4ee2f4))
* **chat:** add ResourceLink file attachments ([#107](https://github.com/omercnet/vscode-acp/issues/107)) ([64ee2e6](https://github.com/omercnet/vscode-acp/commit/64ee2e67b515c7729d0f7fa5ea565bb542f489b7))
* configure MCP servers for ACP sessions ([#106](https://github.com/omercnet/vscode-acp/issues/106)) ([eb82ede](https://github.com/omercnet/vscode-acp/commit/eb82ede5edd831e21282fd697ff360f48615643f))
* **session:** restore persisted ACP conversations ([#103](https://github.com/omercnet/vscode-acp/issues/103)) ([477ef03](https://github.com/omercnet/vscode-acp/commit/477ef03755fa9e3c308b6a7101617476b2ff1e6e))


### Bug Fixes

* **acp:** contain ACP filesystem access inside trusted workspace roots ([#108](https://github.com/omercnet/vscode-acp/issues/108)) ([fb51286](https://github.com/omercnet/vscode-acp/commit/fb51286ac96d77826f9a4accad1eb0cf636cfef8))
* **chat:** serialize session transitions ([#104](https://github.com/omercnet/vscode-acp/issues/104)) ([2f63f22](https://github.com/omercnet/vscode-acp/commit/2f63f22668eb95fd849b3b8cdbac7a2b15e6d025))
* **security:** gate ACP terminal execution behind honest session-scoped grants ([#109](https://github.com/omercnet/vscode-acp/issues/109)) ([316892e](https://github.com/omercnet/vscode-acp/commit/316892e1cef58e6c03ebe11b2593507f1f8f5696))
* **security:** prevent Windows agent PATH hijacking ([#110](https://github.com/omercnet/vscode-acp/issues/110)) ([dc34904](https://github.com/omercnet/vscode-acp/commit/dc349042e09325b041ab1574c9bcec90c7803a21))
* **webview:** render streamed assistant replies once ([#102](https://github.com/omercnet/vscode-acp/issues/102)) ([5dd0fcf](https://github.com/omercnet/vscode-acp/commit/5dd0fcf5c64d33fe9e46e05ae1eb4ca2e5485405))

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
