import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSelfHealLoop, resolveAllowedRealPath } from '../../src/build/selfHeal.js';
import { createRunContext, type Logger, type RunContext } from '../../src/core/context.js';
import type { AttemptResult } from '../../src/build/runner.js';

const mocks = vi.hoisted(() => ({
  runOnce: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('../../src/build/runner.js', () => ({ runOnce: mocks.runOnce }));
vi.mock('../../src/ai/client.js', () => ({ ai: { complete: mocks.complete } }));

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const failure: AttemptResult = {
  ok: false,
  phase: 'build',
  errorOutput: 'npm ERR! missing script: dev',
};
const success: AttemptResult = { ok: true, phase: 'up' };

const suggestion = (contents: string, file = 'docker-compose.yml') => ({
  explanation: 'The start command points at a script the repo does not define.',
  fix: `Rewrite ${file} with a corrected command.`,
  patches: [{ file, contents }],
});

let dir: string;
let ctx: RunContext;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), 'orca-heal-'));
  await writeFile(join(dir, 'docker-compose.yml'), 'name: before\n', 'utf8');
  ctx = createRunContext({
    repoUrl: 'test',
    workspaceDir: dir,
    logger: silentLogger,
    options: { maxHealAttempts: 2 },
  });
  ctx.generatedFiles.push({ path: 'docker-compose.yml', kind: 'compose' });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runSelfHealLoop', () => {
  it('retries up to maxHealAttempts then throws HealExhaustedError', async () => {
    mocks.runOnce.mockResolvedValue(failure);
    mocks.complete.mockResolvedValue(suggestion('name: patched\n'));

    await expect(runSelfHealLoop(ctx)).rejects.toMatchObject({ code: 'HEAL_EXHAUSTED' });

    expect(mocks.runOnce).toHaveBeenCalledTimes(3);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(await readFile(join(dir, 'docker-compose.yml'), 'utf8')).toBe('name: patched\n');
  });

  it('records one plain-English DiagnosisEntry per heal attempt', async () => {
    mocks.runOnce.mockResolvedValue(failure);
    mocks.complete.mockResolvedValue(suggestion('name: patched\n'));

    await expect(runSelfHealLoop(ctx)).rejects.toThrow();

    expect(ctx.diagnosis.map((e) => e.attempt)).toEqual([1, 2]);
    const entry = ctx.diagnosis[0]!;
    expect(entry.explanation).toContain('start command');
    expect(entry.fix).toContain('corrected command');
    expect(entry.changedFiles).toEqual(['docker-compose.yml']);
    expect(entry.errorSignature).toContain('missing script');
    expect(entry.resolved).toBe(false);
  });

  it('stops early once an attempt succeeds and marks the heal resolved', async () => {
    mocks.runOnce.mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
    mocks.complete.mockResolvedValue(suggestion('name: patched\n'));

    await expect(runSelfHealLoop(ctx)).resolves.toEqual(success);

    expect(mocks.runOnce).toHaveBeenCalledTimes(2);
    expect(ctx.diagnosis).toHaveLength(1);
    expect(ctx.diagnosis[0]?.resolved).toBe(true);
  });

  it('rejects patches outside the generated-file allowlist (code-enforced)', async () => {
    mocks.runOnce.mockResolvedValue(failure);
    mocks.complete.mockResolvedValue({
      explanation: 'The app source has a bug.',
      fix: 'Patch the application code.',
      patches: [
        { file: 'server/index.js', contents: 'hacked' },
        { file: '../outside.txt', contents: 'escape' },
        { file: '/etc/orca-test', contents: 'absolute' },
      ],
    });

    await expect(runSelfHealLoop(ctx)).rejects.toMatchObject({ code: 'HEAL_EXHAUSTED' });

    expect(existsSync(join(dir, 'server/index.js'))).toBe(false);
    expect(existsSync(join(dir, '..', 'outside.txt'))).toBe(false);
    expect(ctx.diagnosis[0]?.changedFiles).toEqual([]);
  });

  it('gives up immediately when the AI declares the failure unfixable', async () => {
    mocks.runOnce.mockResolvedValue(failure);
    mocks.complete.mockResolvedValue({
      explanation: 'The application code itself throws on startup.',
      fix: 'No config change can fix this.',
      patches: [],
    });

    await expect(runSelfHealLoop(ctx)).rejects.toMatchObject({ code: 'HEAL_EXHAUSTED' });
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
    expect(ctx.diagnosis).toHaveLength(1);
  });

  it('stops with AbortError after a cancelled attempt without spending an AI call', async () => {
    const controller = new AbortController();
    ctx.options.signal = controller.signal;
    mocks.runOnce.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(failure);
    });

    await expect(runSelfHealLoop(ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('surfaces the build error when self-heal has no AI available', async () => {
    mocks.runOnce.mockResolvedValue(failure);
    mocks.complete.mockRejectedValue(new Error('No API key configured'));

    await expect(runSelfHealLoop(ctx)).rejects.toMatchObject({
      code: 'HEAL_EXHAUSTED',
      message: expect.stringContaining('missing script') as string,
    });
  });
});

/**
 * Symlink creation requires elevation (or Developer Mode) on Windows. A test that the
 * platform cannot run should SKIP, not fail: a red suite that is red for environmental
 * reasons trains people to ignore red suites, and hides the failures that matter.
 */
async function canSymlink(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-symcheck-'));
  try {
    await mkdir(join(dir, 'target'));
    await symlink(join(dir, 'target'), join(dir, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const symlinksAvailable = await canSymlink();

describe('resolveAllowedRealPath symlink guard', () => {
  it.runIf(symlinksAvailable)('rejects an allowlisted path that is a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-symheal-'));
    const outside = join(dir, 'outside.txt');
    await writeFile(outside, 'original');
    const workspace = join(dir, 'ws');
    await mkdir(workspace, { recursive: true });
    // A repo shipping a symlink at a name ORCA generates would redirect the write.
    await symlink(outside, join(workspace, 'Dockerfile'));

    const allowlist = new Set(['Dockerfile']);
    await expect(resolveAllowedRealPath(workspace, 'Dockerfile', allowlist)).resolves.toBeNull();
  });

  it('allows an ordinary generated file, and one not yet written', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-symheal2-'));
    await writeFile(join(workspace, 'Dockerfile'), 'FROM node:20');
    const allowlist = new Set(['Dockerfile', 'docker-compose.yml']);

    await expect(resolveAllowedRealPath(workspace, 'Dockerfile', allowlist)).resolves.toBe(
      join(workspace, 'Dockerfile')
    );
    // Declared but not yet on disk — still allowed, the patch may be creating it.
    await expect(resolveAllowedRealPath(workspace, 'docker-compose.yml', allowlist)).resolves.toBe(
      join(workspace, 'docker-compose.yml')
    );
  });

  it('still rejects a path outside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-symheal3-'));
    await expect(
      resolveAllowedRealPath(workspace, '../escape.txt', new Set(['../escape.txt']))
    ).resolves.toBeNull();
  });
});
