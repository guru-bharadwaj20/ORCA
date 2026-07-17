#!/usr/bin/env node
/**
 * CLI bin entry. Parses argv with commander and dispatches to a command handler.
 *
 * STAGE: 7 (cli) — REAL code (walking skeleton).
 * Inputs: process.argv (and AI API keys from env, both optional).
 * Outputs: process exit code; delegates real work to command handlers.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { OrcaError } from '../utils/errors.js';
import { registerRunCommand } from './commands/run.js';

/** The version from package.json (two levels up from src/cli and dist/cli alike). */
function packageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Assemble the commander program: name, version, and every subcommand. */
export function buildCli(): Command {
  const program = new Command('orca')
    .description(
      'Clone a messy repo, detect its stack, and containerize it — with a reviewable ' +
        'plan before anything is built or run.'
    )
    .version(packageVersion());
  registerRunCommand(program);
  return program;
}

/**
 * Construct the CLI and invoke it; map thrown `OrcaError`s to exit codes
 * (2 = plan rejected at the gate, 1 = everything else). Unknown errors propagate.
 */
export async function main(argv: string[]): Promise<void> {
  const program = buildCli();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof OrcaError) {
      process.stderr.write(`error [${err.code}]: ${err.message}\n`);
      process.exitCode = err.code === 'PLAN_REJECTED' ? 2 : 1;
      return;
    }
    throw err;
  }
}

/**
 * Run only when this file is the executed bin (never on import by tests/embedders).
 * argv[1] is realpath'd because npm installs the bin as a symlink while Node loads
 * the ESM entry through its real path.
 */
function invokedDirectly(): boolean {
  const argvPath = process.argv[1];
  if (argvPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(argvPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void main(process.argv);
}
