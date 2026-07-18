/**
 * The interactive ORCA shell: the splash banner + arrow-key menu shown when `orca`
 * is run with no subcommand on a TTY. Each item dispatches to the same real code the
 * flag-driven CLI uses (`executeRun`, `loadSettings`) — the menu is a friendly front
 * door, not a second implementation.
 *
 * STAGE: 7 (cli) — REAL code.
 * Inputs: the process TTY + environment (API keys, ORCA_* overrides).
 * Outputs: side effects of the chosen action; returns when the user exits.
 */

import { loadSettings, ENV_KEYS } from '../config/settings.js';
import { OrcaError } from '../utils/errors.js';
import { executeRun } from './commands/run.js';
import { renderBanner } from './ui/banner.js';
import { pressEnter, select, textPrompt, type SelectRow } from './ui/select.js';
import { screen, theme } from './ui/theme.js';

/** The actions the menu can dispatch. */
type Action = 'run' | 'preview' | 'settings' | 'keys' | 'help' | 'exit';

/** The menu layout: sections + items, mirroring ORCA's real capabilities. */
const MENU: SelectRow<Action>[] = [
  { separator: 'Containerize' },
  {
    icon: '🐳',
    label: 'Run a repo',
    hint: 'detect · plan · approve · build & self-heal',
    value: 'run',
  },
  {
    icon: '👁 ',
    label: 'Preview a repo',
    hint: 'dry run — show the plan + configs, build nothing',
    value: 'preview',
  },
  { separator: 'Configuration' },
  { icon: '⚙ ', label: 'Settings & model routing', hint: 'model · cost cap · heal attempts', value: 'settings' },
  { icon: '🔑', label: 'API keys (BYOK)', hint: 'which providers are wired up', value: 'keys' },
  { separator: 'Help' },
  { icon: '📖', label: 'Help & documentation', value: 'help' },
  { icon: '🚪', label: 'Exit', value: 'exit' },
];

/** The question line printed under the banner. */
function headerFor(version: string): string {
  return [
    renderBanner(version),
    `  ${theme.teal('?')} ${theme.white.bold('What would you like to do?')} ` +
      `${theme.soft('(↑/↓ move · enter select · q quit)')}`,
    '',
  ].join('\n');
}

/** Run the containerize/preview action: prompt for a repo, then drive the pipeline. */
async function runRepo(dryRun: boolean): Promise<void> {
  const repo = await textPrompt('Path or git URL of the repo to containerize:');
  if (!repo) {
    process.stdout.write(theme.soft('No repo given — back to the menu.\n'));
    return;
  }
  process.stdout.write('\n');
  try {
    await executeRun(repo, dryRun ? { dryRun: true } : {});
  } catch (err) {
    // In the menu we never exit the process on a failed run — report and continue.
    const message = err instanceof OrcaError ? `${err.code}: ${err.message}` : String(err);
    process.stdout.write(`\n${theme.yellow('Run ended:')} ${theme.white(message)}\n`);
  }
}

/** Print the resolved settings (defaults + any ORCA_* overrides). */
function showSettings(): void {
  const s = loadSettings();
  const row = (k: string, v: string): string => `  ${theme.soft(k.padEnd(20))}${theme.white(v)}`;
  process.stdout.write(
    [
      theme.orange.bold('  Settings & model routing'),
      '',
      row('Primary provider', s.primaryProvider),
      row('Fallback provider', s.fallbackProvider ?? '(disabled)'),
      row('Anthropic model', s.model),
      row('Qwen model', s.qwenModel),
      row('Qwen base URL', s.qwenBaseUrl),
      row('Cost cap (USD)', `$${s.costCapUsd.toFixed(2)}`),
      row('Max heal attempts', String(s.maxHealAttempts)),
      '',
      theme.soft('  Override any of these with ORCA_* env vars or run flags (flag > env > default).'),
      '',
    ].join('\n') + '\n'
  );
}

/** Mask a secret to a short, safe preview. */
function maskKey(value: string | undefined): string {
  if (!value) return theme.soft('not set');
  const tail = value.slice(-4);
  return theme.green(`set ${theme.soft(`(…${tail})`)}`);
}

/** Print which API keys are present (masked) — ORCA is BYOK and keyless-capable. */
function showKeys(): void {
  process.stdout.write(
    [
      theme.orange.bold('  API keys (bring-your-own-key)'),
      '',
      `  ${theme.soft(`${ENV_KEYS.qwenApiKey}`.padEnd(22))}${maskKey(process.env[ENV_KEYS.qwenApiKey])} ${theme.soft('· primary')}`,
      `  ${theme.soft(`${ENV_KEYS.apiKey}`.padEnd(22))}${maskKey(process.env[ENV_KEYS.apiKey])} ${theme.soft('· fallback')}`,
      '',
      theme.soft('  No key? ORCA still runs — AI refinement degrades to the template defaults.'),
      '',
    ].join('\n') + '\n'
  );
}

/** Print a short feature + command reference. */
function showHelp(): void {
  process.stdout.write(
    [
      theme.orange.bold('  ORCA — what it does'),
      '',
      `  ${theme.teal('•')} ${theme.white('Approve-before-build')} ${theme.soft('— review the service-graph diagram before anything runs.')}`,
      `  ${theme.teal('•')} ${theme.white('Explainable self-heal')} ${theme.soft('— retries failed builds and explains each fix in plain English.')}`,
      `  ${theme.teal('•')} ${theme.white('Narrow & opinionated')} ${theme.soft('— React/Node, Express or Django, Postgres/Mongo/Redis.')}`,
      '',
      theme.orange.bold('  From the command line'),
      '',
      `  ${theme.white('orca run <repo>')}                 ${theme.soft('full flow (build + self-heal)')}`,
      `  ${theme.white('orca run <repo> --dry-run')}       ${theme.soft('plan + configs, nothing built')}`,
      `  ${theme.white('orca run <repo> --auto-approve')}  ${theme.soft('skip the approval gate (CI)')}`,
      `  ${theme.white('orca run --help')}                 ${theme.soft('every flag')}`,
      '',
    ].join('\n') + '\n'
  );
}

/** Dispatch a chosen action; returns true to keep the menu loop running. */
async function dispatch(action: Action): Promise<boolean> {
  process.stdout.write(screen.clearStyle + '\n');
  switch (action) {
    case 'run':
      await runRepo(false);
      break;
    case 'preview':
      await runRepo(true);
      break;
    case 'settings':
      showSettings();
      break;
    case 'keys':
      showKeys();
      break;
    case 'help':
      showHelp();
      break;
    case 'exit':
      return false;
  }
  await pressEnter();
  return true;
}

/**
 * Run the interactive menu loop until the user exits. Falls through immediately on a
 * non-TTY (select resolves null), so callers can degrade to `--help`.
 */
export async function runInteractiveMenu(version: string): Promise<void> {
  try {
    let keepGoing = true;
    while (keepGoing) {
      const choice = await select({ header: headerFor(version), items: MENU });
      if (choice === null) break;
      keepGoing = await dispatch(choice);
    }
  } finally {
    process.stdout.write(screen.clearStyle + '\n');
  }
}
