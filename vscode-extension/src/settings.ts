import type { RunOptions } from 'orca-agent-cli';
import type { KeyResolver } from 'orca-agent-cli/config';
import * as vscode from 'vscode';

const PRIMARY_PROVIDER_ENV = 'ORCA_PRIMARY_PROVIDER';
const FALLBACK_PROVIDER_ENV = 'ORCA_FALLBACK_PROVIDER';

function explicitValue<T>(cfg: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const info = cfg.inspect<T>(key);
  return info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
}

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

export async function createSecretKeyResolver(
  context: vscode.ExtensionContext
): Promise<KeyResolver> {
  const { ENV_KEYS } = await import('orca-agent-cli/config');
  const [qwen, anthropic] = await Promise.all([
    context.secrets.get(ENV_KEYS.qwenApiKey),
    context.secrets.get(ENV_KEYS.apiKey),
  ]);
  const stored: Record<string, string> = {};
  if (qwen) stored[ENV_KEYS.qwenApiKey] = qwen;
  if (anthropic) stored[ENV_KEYS.apiKey] = anthropic;
  return (name: string): string | undefined => stored[name] ?? process.env[name];
}

export async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const { ENV_KEYS } = await import('orca-agent-cli/config');
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
  if (value === undefined) return;

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
