/**
 * Walking-skeleton tests — the full pipeline (clone -> detect -> keyless fill ->
 * plan -> gate -> dry-run preview) driven end-to-end on the bundled fixtures,
 * with scripted IO and zero API keys (hermetic: the keyless path never dials out).
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRunContext,
  DEFAULT_RUN_OPTIONS,
  type Logger,
  type RunOptions,
} from '../../src/core/context.js';
import { runPipeline } from '../../src/core/pipeline.js';

// Docker is mocked at the single shell-out boundary; everything else (clone,
// detection, plan, gate, writeConfigs, self-heal loop) runs for real.
const docker = vi.hoisted(() => ({
  assertDockerAvailable: vi.fn(),
  composeBuild: vi.fn(),
  composeUp: vi.fn(),
  composeDown: vi.fn(),
  composeLogs: vi.fn(),
}));
vi.mock('../../src/build/docker.js', () => docker);

const dockerOk = { exitCode: 0, stdout: '', stderr: '' };

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** A logger that records lines instead of printing them. */
function collectLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`);
  };
  return {
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    lines,
  };
}

/** Start a pipeline run on a fixture with scripted stdin and captured output. */
function startRun(repo: string, over: Partial<RunOptions>, answer: string | null) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk: Buffer) => (printed += chunk.toString()));

  const { logger, lines } = collectLogger();
  const ctx = createRunContext({
    repoUrl: repo,
    workspaceDir: '',
    logger,
    options: { ...DEFAULT_RUN_OPTIONS, ...over },
  });
  if (answer !== null) input.write(`${answer}\n`);
  const result = runPipeline(ctx, { input, output });
  return { ctx, result, printed: () => printed, lines };
}

const savedEnv = {
  qwen: process.env['QWEN_API_KEY'],
  anthropic: process.env['ANTHROPIC_API_KEY'],
};

beforeEach(() => {
  // Hermeticity: with no keys the pipeline must take the template-defaults path
  // and never touch the network.
  delete process.env['QWEN_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];

  vi.clearAllMocks();
  docker.assertDockerAvailable.mockResolvedValue(undefined);
  docker.composeBuild.mockResolvedValue(dockerOk);
  docker.composeUp.mockResolvedValue(dockerOk);
  docker.composeDown.mockResolvedValue(dockerOk);
  docker.composeLogs.mockResolvedValue(dockerOk);
});

afterAll(() => {
  if (savedEnv.qwen !== undefined) process.env['QWEN_API_KEY'] = savedEnv.qwen;
  if (savedEnv.anthropic !== undefined) process.env['ANTHROPIC_API_KEY'] = savedEnv.anthropic;
});

describe('runPipeline (walking skeleton)', () => {
  it('runs a keyless dry run end-to-end on the MERN fixture', async () => {
    const { ctx, result, printed, lines } = startRun(
      fixture('mern-repo'),
      { dryRun: true, autoApprove: true },
      null
    );
    await result;

    // Cloned into a temp workspace, not run in place — and cleaned up afterwards.
    expect(ctx.workspaceDir).not.toBe(fixture('mern-repo'));
    expect(ctx.workspaceDir).not.toBe('');
    expect(existsSync(ctx.workspaceDir)).toBe(false);

    expect(ctx.detection?.backend?.framework).toBe('express');
    // Named after the clone *source*, not the temp checkout directory.
    expect(ctx.plan?.projectName).toBe('orca-mern-repo');
    expect(ctx.plan?.services.map((s) => s.id)).toEqual(['db', 'backend', 'frontend']);
    expect(ctx.plan?.source).toBe('template'); // keyless -> registry defaults
    expect(ctx.approved).toBe(true);
    expect(lines.some((l) => l.includes('using template defaults'))).toBe(true);

    const out = printed();
    expect(out).toContain('flowchart LR'); // review gate showed the diagram
    expect(out).toContain('# --- docker-compose.yml (preview) ---');
    expect(out).toContain('services:');
    expect(out).toContain('# --- ./server/Dockerfile (backend, preview) ---');
    expect(out).toContain('FROM node:20-slim');
    expect(out).toContain('Dry run complete — nothing was built, run, or written to disk.');
  });

  it('gates on scripted stdin and proceeds on "y"', async () => {
    const { ctx, result, printed } = startRun(fixture('mern-repo'), { dryRun: true }, 'y');
    await result;

    expect(ctx.approved).toBe(true);
    expect(printed()).toContain('Approve this plan and continue?');
    expect(printed()).toContain('Dry run complete');
  });

  it('throws PLAN_REJECTED when the user answers "n" and still cleans up', async () => {
    const { ctx, result } = startRun(fixture('mern-repo'), { dryRun: true }, 'n');

    await expect(result).rejects.toMatchObject({ code: 'PLAN_REJECTED' });
    expect(ctx.approved).toBe(false);
    expect(ctx.workspaceDir).not.toBe('');
    expect(existsSync(ctx.workspaceDir)).toBe(false);
  });

  it('full run (docker mocked): writes configs, starts the stack, keeps the workspace', async () => {
    const { ctx, result, printed } = startRun(fixture('mern-repo'), { autoApprove: true }, null);
    await result;

    try {
      // Real files were generated into the (kept-alive) workspace.
      expect(existsSync(ctx.workspaceDir)).toBe(true);
      expect(existsSync(`${ctx.workspaceDir}/docker-compose.yml`)).toBe(true);
      expect(ctx.generatedFiles.map((f) => f.kind)).toContain('dockerfile');
      expect(docker.composeBuild).toHaveBeenCalledTimes(1);
      expect(docker.composeUp).toHaveBeenCalledTimes(1);
      expect(printed()).toContain('Stack is up');
      expect(printed()).toContain('http://localhost:3000');
    } finally {
      await rm(dirname(ctx.workspaceDir), { recursive: true, force: true });
    }
  });

  it('keyless build failure: heal unavailable, stack torn down, workspace removed', async () => {
    docker.composeBuild.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'npm ERR! missing script: dev',
    });
    const { ctx, result } = startRun(fixture('mern-repo'), { autoApprove: true }, null);

    await expect(result).rejects.toMatchObject({ code: 'HEAL_EXHAUSTED' });
    expect(docker.composeDown).toHaveBeenCalled(); // best-effort teardown
    expect(existsSync(ctx.workspaceDir)).toBe(false); // no leaked temp dirs
  });

  it('propagates MISSING_DEPENDENCY when docker is unavailable', async () => {
    docker.assertDockerAvailable.mockRejectedValue(
      Object.assign(new Error('docker not found'), { code: 'MISSING_DEPENDENCY' })
    );
    const { result } = startRun(fixture('mern-repo'), { autoApprove: true }, null);

    await expect(result).rejects.toMatchObject({ code: 'MISSING_DEPENDENCY' });
  });

  it('throws UNSUPPORTED_STACK on a repo outside ORCA scope', async () => {
    const { result } = startRun(
      fixture('unsupported-repo'),
      { dryRun: true, autoApprove: true },
      null
    );

    await expect(result).rejects.toMatchObject({ code: 'UNSUPPORTED_STACK' });
  });

  it('uses a pre-materialized workspaceDir as-is (no clone, no cleanup)', async () => {
    const repoDir = fixture('django-postgres-repo');
    const { logger } = collectLogger();
    const ctx = createRunContext({
      repoUrl: repoDir,
      workspaceDir: repoDir,
      logger,
      options: { ...DEFAULT_RUN_OPTIONS, dryRun: true, autoApprove: true },
    });
    const output = new PassThrough();
    output.resume();

    await runPipeline(ctx, { output });

    expect(ctx.workspaceDir).toBe(repoDir);
    expect(existsSync(repoDir)).toBe(true);
    expect(ctx.plan?.services.map((s) => s.id)).toContain('db');
  });
});
