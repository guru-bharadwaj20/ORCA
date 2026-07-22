#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { OrcaError } from '../utils/errors.js';
import { registerRunCommand } from './commands/run.js';
import { runInteractiveMenu } from './menu.js';
import { packageVersion } from './version.js';

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

export async function main(argv: string[]): Promise<void> {
  const program = buildCli();

  if (argv.slice(2).length === 0) {
    if (process.stdout.isTTY ?? false) {
      await runInteractiveMenu(packageVersion());
    } else {
      program.outputHelp();
    }
    return;
  }

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
