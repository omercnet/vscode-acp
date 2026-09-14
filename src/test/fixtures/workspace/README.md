# Integration test workspace

`.vscode-test.mjs` opens this folder as the single workspace root so the
extension's workspace-dependent behaviour (workspace trust, terminal cwd
containment, approved terminal execution) is exercised instead of skipped.
