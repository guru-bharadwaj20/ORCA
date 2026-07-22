import { Command, InvalidArgumentError } from 'commander';

import { loadSettings } from '../../config/settings.js';
import { createRunContext, DEFAULT_RUN_OPTIONS, type RunOptions } from '../../core/context.js';
import { runPipeline } from '../../core/pipeline.js';
import { createLogger } from '../../utils/logging.js';
import { renderDiagnosisLog } from '../output.js';

export interface RunCommandFlags {
  dryRun?: boolean;
  autoApprove?: boolean;
  model?: string;
  maxHealAttempts?: number;
  costCap?: number;
  verbose?: boolean;
}

export function toRunOptions(
  flags: RunCommandFlags,
  env: NodeJS.ProcessEnv = process.env
): RunOptions {
  const settings = loadSettings(env);
  return {
    ...DEFAULT_RUN_OPTIONS,
    model: settings.model,
    maxHealAttempts: settings.maxHealAttempts,
    costCapUsd: settings.costCapUsd,
    ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
    ...(flags.autoApprove !== undefined ? { autoApprove: flags.autoApprove } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.maxHealAttempts !== undefined ? { maxHealAttempts: flags.maxHealAttempts } : {}),
    ...(flags.costCap !== undefined ? { costCapUsd: flags.costCap } : {}),
    ...(flags.verbose !== undefined ? { verbose: flags.verbose } : {}),
  };
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

function parseNonNegativeFloat(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError('expected a non-negative number');
  }
  return parsed;
}

export async function executeRun(repoUrl: string, flags: RunCommandFlags): Promise<void> {
  const options = toRunOptions(flags);
  const logger = createLogger(options.verbose ? 'debug' : 'info');
  const ctx = createRunContext({ repoUrl, workspaceDir: '', logger, options });
  try {
    await runPipeline(ctx);
  } catch (err) {
    const healLog = renderDiagnosisLog(ctx.diagnosis);
    if (healLog !== '') process.stderr.write(`\n${healLog}`);
    throw err;
  }
}

export function registerRunCommand(program: Command): Command {
  return program
    .command('run')
    .description('clone a repo, detect its stack, and (after your approval) containerize it')
    .argument('<repo>', 'git URL or local path of the repo to containerize')
    .option('--dry-run', 'show the plan + generated configs without building or running anything')
    .option('--auto-approve', 'skip the interactive approval gate (CI / scripting)')
    .option('--model <id>', 'model id override for AI stages')
    .option('--max-heal-attempts <n>', 'max self-heal attempts before giving up', parsePositiveInt)
    .option('--cost-cap <usd>', 'hard cap on LLM spend for the run, in USD', parseNonNegativeFloat)
    .option('--verbose', 'verbose debug logging')
    .action((repo: string, flags: RunCommandFlags) => executeRun(repo, flags));
}
