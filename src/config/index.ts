/**
 * Public entry for `orca-agent-cli/config`: settings loading + the BYOK key-resolver seam.
 * The extension maps its contributed settings onto `loadSettings` values and injects
 * a `KeyResolver` backed by `vscode.SecretStorage`.
 *
 * STAGE: config (library surface) — REAL code.
 */

export * from './settings.js';
