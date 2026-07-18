/**
 * Extension settings + secrets glue (Phase 5).
 *
 *  - Contributed `orca.*` settings map onto ORCA's RunOptions / router config. They are
 *    applied ONLY when the user set them explicitly (via `inspect`), so the precedence
 *    stays UI > env (`ORCA_*`) > ORCA default — an unset setting never masks an env var.
 *  - API keys live in `vscode.SecretStorage`, never settings.json. They are surfaced to
 *    the ESM core through its Phase 1 `KeyResolver` seam (pre-fetched into a sync lookup,
 *    since SecretStorage is async and KeyResolver is not).
 */

import type { RunOptions } from 'orca-cli';
import type { KeyResolver } from 'orca-cli/config';
import * as vscode from 'vscode';

// ORCA env-var names the provider settings shadow (kept in sync with orca-cli's
// ENV_KEYS.primaryProvider / .fallbackProvider).
const PRIMARY_PROVIDER_ENV = 'ORCA_PRIMARY_PROVIDER';
const FALLBACK_PROVIDER_ENV = 'ORCA_FALLBACK_PROVIDER';

/** The user's explicitly-set value for `orca.<key>`, or undefined if only the default. */
function explicitValue<T>(cfg: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const info = cfg.inspect<T>(key);
  return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
}

/** RunOptions overrides from explicitly-set `orca.*` settings (empty when none set). */
export function readConfiguredOptions(): Partial<RunOptions> {
  const cfg = vscode.workspace.getConfiguration('orca');
  const options: Partial<RunOptions> = {};

  const model = explicitValue<string>(cfg, 'model');
  if (typeof model === 'string' && model.trim() !== '') options.model = model.trim();

  const costCap = explicitValue<number>(cfg, 'costCapUsd');
  if (typeof costCap === 'number' && costCap > 0) options.costCapUsd = costCap;

  const heal = explicitValue<number>(cfg, 'maxHealAttempts');
  if (typeof heal === 'number' && Number.isInteger(heal) && heal >= 1)
    options.maxHealAttempts = heal;

  return options;
}

/**
 * A synthetic env fragment carrying explicitly-set provider settings, layered over
 * `process.env` when building the router so UI wins but env still shows through.
 */
export function configuredProviderEnv(): Record<string, string> {
  const cfg = vscode.workspace.getConfiguration('orca');
  const env: Record<string, string> = {};

  const primary = explicitValue<string>(cfg, 'primaryProvider');
  if (primary === 'qwen' || primary === 'anthropic') env[PRIMARY_PROVIDER_ENV] = primary;

  const fallback = explicitValue<string>(cfg, 'fallbackProvider');
  if (fallback === 'qwen' || fallback === 'anthropic' || fallback === 'none') {
    env[FALLBACK_PROVIDER_ENV] = fallback;
  }
  return env;
}

/**
 * Build a synchronous KeyResolver backed by SecretStorage. The two provider keys are
 * pre-fetched (SecretStorage is async, the seam is sync); a developer's `process.env`
 * key is used as a fallback when nothing is stored.
 */
export async function createSecretKeyResolver(
  context: vscode.ExtensionContext
): Promise<KeyResolver> {
  const { ENV_KEYS } = await import('orca-cli/config');
  const [qwen, anthropic] = await Promise.all([
    context.secrets.get(ENV_KEYS.qwenApiKey),
    context.secrets.get(ENV_KEYS.apiKey),
  ]);
  const stored: Record<string, string> = {};
  if (qwen) stored[ENV_KEYS.qwenApiKey] = qwen;
  if (anthropic) stored[ENV_KEYS.apiKey] = anthropic;
  return (name: string): string | undefined => stored[name] ?? process.env[name];
}

/** "ORCA: Set API Key" — store (or clear) a provider key in SecretStorage. */
export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const { ENV_KEYS } = await import('orca-cli/config');
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Qwen / DashScope', description: 'primary provider', key: ENV_KEYS.qwenApiKey },
      { label: 'Anthropic (Claude)', description: 'fallback provider', key: ENV_KEYS.apiKey },
    ],
    { placeHolder: 'Which ORCA API key do you want to set?' }
  );
  if (choice === undefined) return;

  const value = await vscode.window.showInputBox({
    prompt: `Enter the ${choice.label} API key (leave empty to clear it)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return; // cancelled

  if (value.trim() === '') {
    await context.secrets.delete(choice.key);
    void vscode.window.showInformationMessage(`ORCA: ${choice.label} key cleared.`);
  } else {
    await context.secrets.store(choice.key, value.trim());
    void vscode.window.showInformationMessage(
      `ORCA: ${choice.label} key saved to VS Code secret storage.`
    );
  }
}
