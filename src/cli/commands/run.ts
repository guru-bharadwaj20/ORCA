/**
 * The `orca run <repo-url>` command. Collects flags, builds a RunContext, and
 * invokes the core pipeline.
 *
 * STAGE: 7 (cli) — REAL code (walking skeleton).
 * Inputs: repo URL/path + flags (--dry-run, --auto-approve, --model, etc.).
 * Outputs: side effects (generated configs, running containers) + terminal output.
 */

import { Command, InvalidArgumentError } from 'commander';

import { createRunContext, DEFAULT_RUN_OPTIONS, type RunOptions } from '../../core/context.js';
import { runPipeline } from '../../core/pipeline.js';
import { createLogger } from '../../utils/logging.js';

/** Flags accepted by `orca run`, before defaults are applied. */
export interface RunCommandFlags {
  dryRun?: boolean;
  autoApprove?: boolean;
  model?: string;
  maxHealAttempts?: number;
  costCap?: number;
  verbose?: boolean;
}

/** Merge raw CLI flags over the defaults into a fully-populated `RunOptions`. */
export function toRunOptions(flags: RunCommandFlags): RunOptions {
  return {
    ...DEFAULT_RUN_OPTIONS,
    ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun } : {}),
    ...(flags.autoApprove !== undefined ? { autoApprove: flags.autoApprove } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.maxHealAttempts !== undefined ? { maxHealAttempts: flags.maxHealAttempts } : {}),
    ...(flags.costCap !== undefined ? { costCapUsd: flags.costCap } : {}),
    ...(flags.verbose !== undefined ? { verbose: flags.verbose } : {}),
  };
}

/** Commander coercion: a strictly positive integer. */
function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return parsed;
}

/** Commander coercion: a non-negative dollar amount. */
function parseNonNegativeFloat(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError('expected a non-negative number');
  }
  return parsed;
}

/** Build the RunContext and drive the pipeline; errors propagate to `main`. */
export async function executeRun(repoUrl: string, flags: RunCommandFlags): Promise<void> {
  const options = toRunOptions(flags);
  const logger = createLogger(options.verbose ? 'debug' : 'info');
  const ctx = createRunContext({ repoUrl, workspaceDir: '', logger, options });
  await runPipeline(ctx);
}

/** Define the `run` subcommand on the given program. */
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
