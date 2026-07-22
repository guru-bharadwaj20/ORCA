import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toRunOptions } from '../../src/cli/commands/run.js';
import { buildCli, main } from '../../src/cli/index.js';
import { DEFAULT_RUN_OPTIONS } from '../../src/core/context.js';

const mernFixture = fileURLToPath(new URL('../fixtures/mern-repo', import.meta.url));

const savedEnv = {
  qwen: process.env['QWEN_API_KEY'],
  anthropic: process.env['ANTHROPIC_API_KEY'],
};
const savedExitCode = process.exitCode;

let stdout = '';
let stderr = '';

beforeEach(() => {
  delete process.env['QWEN_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

afterAll(() => {
  if (savedEnv.qwen !== undefined) process.env['QWEN_API_KEY'] = savedEnv.qwen;
  if (savedEnv.anthropic !== undefined) process.env['ANTHROPIC_API_KEY'] = savedEnv.anthropic;
});

describe('toRunOptions', () => {
  it('returns the defaults for empty flags and a clean environment', () => {
    expect(toRunOptions({}, {})).toEqual(DEFAULT_RUN_OPTIONS);
  });

  it('applies ORCA_* env overrides, and explicit flags beat them', () => {
    const env = { ORCA_COST_CAP_USD: '0.5', ORCA_MAX_HEAL_ATTEMPTS: '7' };

    const fromEnv = toRunOptions({}, env);
    expect(fromEnv.costCapUsd).toBe(0.5);
    expect(fromEnv.maxHealAttempts).toBe(7);

    const fromFlag = toRunOptions({ costCap: 2 }, env);
    expect(fromFlag.costCapUsd).toBe(2);
    expect(fromFlag.maxHealAttempts).toBe(7);
  });

  it('maps every flag onto RunOptions', () => {
    expect(
      toRunOptions(
        {
          dryRun: true,
          autoApprove: true,
          model: 'claude-opus-4-8',
          maxHealAttempts: 5,
          costCap: 0.25,
          verbose: true,
        },
        {}
      )
    ).toEqual({
      dryRun: true,
      autoApprove: true,
      model: 'claude-opus-4-8',
      maxHealAttempts: 5,
      costCapUsd: 0.25,
      verbose: true,
    });
  });
});

describe('buildCli', () => {
  it('exposes an orca program with a run subcommand', () => {
    const program = buildCli();
    expect(program.name()).toBe('orca');
    expect(program.commands.map((c) => c.name())).toContain('run');
  });
});

describe('main', () => {
  it('greets bare `orca` on a non-TTY with help and exit 0', async () => {
    await main(['node', 'orca']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('Usage: orca');
  });

  it('completes a keyless --dry-run --auto-approve run with exit code 0', async () => {
    await main(['node', 'orca', 'run', mernFixture, '--dry-run', '--auto-approve']);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout).toContain('flowchart LR');
    expect(stdout).toContain('Dry run complete');
    expect(stderr).toContain('using template defaults');
  });

  it('exits with code 2 when the gate rejects (non-TTY without --auto-approve)', async () => {
    await main(['node', 'orca', 'run', mernFixture, '--dry-run']);

    expect(process.exitCode).toBe(2);
    expect(stderr).toContain('error [PLAN_REJECTED]');
    expect(stderr).toContain('non-interactive session');
  });
});
