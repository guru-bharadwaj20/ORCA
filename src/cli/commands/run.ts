/**
 * The `orca run <repo-url>` command. Collects flags, builds a RunContext, and
 * invokes the core pipeline.
 *
 * STAGE: 7 (cli)
 * Inputs: repo URL/path + flags (--dry-run, --auto-approve, --model, etc.).
 * Outputs: side effects (generated configs, running containers) + terminal output.
 */

import { Command } from 'commander';
import type { RunOptions } from '../../core/context.js';

/** Flags accepted by `orca run`, before defaults are applied. */
export interface RunCommandFlags {
  dryRun?: boolean;
  autoApprove?: boolean;
  model?: string;
  maxHealAttempts?: number;
  costCap?: number;
  verbose?: boolean;
}

// TODO(stage-7): translate raw CLI flags into a fully-defaulted RunOptions.
export function toRunOptions(_flags: RunCommandFlags): RunOptions {
  throw new Error('not implemented');
}

// TODO(stage-7): build the RunContext, run the pipeline, and render results/errors.
export async function executeRun(_repoUrl: string, _flags: RunCommandFlags): Promise<void> {
  throw new Error('not implemented');
}

// TODO(stage-7): define the commander subcommand (name, args, options, action).
export function registerRunCommand(_program: Command): Command {
  throw new Error('not implemented');
}
