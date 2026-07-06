#!/usr/bin/env node
/**
 * CLI bin entry. Parses argv with commander and dispatches to a command handler.
 *
 * STAGE: 7 (cli)
 * Inputs: process.argv (and ANTHROPIC_API_KEY from env).
 * Outputs: process exit code; delegates real work to command handlers.
 */

import { Command } from 'commander';

// TODO(stage-7): register commands (run), wire global flags (--verbose, --model),
// set version from package.json, and parse argv.
export function buildCli(): Command {
  throw new Error('not implemented');
}

// TODO(stage-7): construct the CLI and invoke it; map thrown errors to exit codes.
export async function main(_argv: string[]): Promise<void> {
  throw new Error('not implemented');
}

// Entry invocation is intentionally left for stage 7 wiring.
