/**
 * Phase 1 embeddability tests: the seams the VS Code extension relies on, all driven
 * through the real pipeline with docker mocked at its single shell-out boundary and
 * zero network/API keys.
 *
 *  - approvePlan hook replaces the default reviewPlan gate (Task 1)
 *  - AbortSignal cancels a run and tears down cleanly (Task 4)
 *  - resolveKey drives the AI branch without touching process.env (Task 3)
 */
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AIFacade } from '../../src/ai/client.js';
import {
  createRunContext,
  DEFAULT_RUN_OPTIONS,
  type Logger,
  type RunContext,
  type RunOptions,
} from '../../src/core/context.js';
import { runPipeline, type PipelineIO } from '../../src/core/pipeline.js';
import type { ServicePlan } from '../../src/plan/types.js';
import type { KeyResolver } from '../../src/config/settings.js';

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

function collectLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => lines.push(`${level} ${message}`);
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

/** Build a context + start a run with injectable IO, options, resolver, and AI facade. */
function startRun(opts: {
  repo?: string;
  over?: Partial<RunOptions>;
  io?: PipelineIO;
  resolveKey?: KeyResolver;
  ai?: AIFacade;
}) {
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  const { logger, lines } = collectLogger();

  const ctx: RunContext = createRunContext({
    repoUrl: opts.repo ?? fixture('mern-repo'),
    workspaceDir: '',
    logger,
    options: { ...DEFAULT_RUN_OPTIONS, ...opts.over },
    ...(opts.resolveKey ? { resolveKey: opts.resolveKey } : {}),
  });
  if (opts.ai) ctx.ai = opts.ai;

  const io: PipelineIO = { output, ...opts.io };
  const result = runPipeline(ctx, io);
  return { ctx, result, printed: () => printed, lines };
}

const savedEnv = { qwen: process.env['QWEN_API_KEY'], anthropic: process.env['ANTHROPIC_API_KEY'] };

beforeEach(() => {
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

describe('approvePlan hook (Task 1)', () => {
  it('owns the decision, replacing the default reviewPlan gate', async () => {
    const approvePlan = vi.fn(
      (plan: ServicePlan): Promise<{ approved: boolean; plan: ServicePlan }> =>
        Promise.resolve({ approved: true, plan })
    );
    const { ctx, result, printed } = startRun({
      over: { dryRun: true }, // no autoApprove, no stdin — the hook decides
      io: { approvePlan },
    });
    await result;

    expect(approvePlan).toHaveBeenCalledTimes(1);
    expect(approvePlan.mock.calls[0]![0].services.map((s) => s.id)).toEqual([
      'db',
      'backend',
      'frontend',
    ]);
    expect(ctx.approved).toBe(true);
    // The default gate's prompt never ran — the hook replaced it.
    expect(printed()).not.toContain('Approve this plan and continue?');
    expect(printed()).toContain('Dry run complete');
  });

  it('a rejected outcome (e.g. disposed panel) takes the normal PLAN_REJECTED path', async () => {
    const approvePlan = (plan: ServicePlan) =>
      Promise.resolve({ approved: false, plan, reason: 'approval panel disposed' });
    const { ctx, result } = startRun({ over: { dryRun: true }, io: { approvePlan } });

    await expect(result).rejects.toMatchObject({
      code: 'PLAN_REJECTED',
      message: expect.stringContaining('approval panel disposed'),
    });
    expect(ctx.approved).toBe(false);
    expect(existsSync(ctx.workspaceDir)).toBe(false); // cleaned up
  });
});

describe('AbortSignal (Task 4)', () => {
  it('an already-aborted run bails before any docker work and cleans up', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = startRun({
      over: { dryRun: true, autoApprove: true, signal: controller.signal },
    });

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.assertDockerAvailable).not.toHaveBeenCalled();
  });

  it('a cancel mid-build tears the stack down and removes the workspace', async () => {
    const controller = new AbortController();
    // Simulate the user hitting cancel while the first build is running.
    docker.composeBuild.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'cancelled mid-build' });
    });
    const { ctx, result } = startRun({
      over: { autoApprove: true, signal: controller.signal },
    });

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(docker.composeDown).toHaveBeenCalled(); // best-effort teardown on abort
    expect(existsSync(ctx.workspaceDir)).toBe(false); // no leaked temp dir
  });
});

describe('resolveKey credentials seam (Task 3)', () => {
  it('drives the AI branch from the injected resolver, not process.env', async () => {
    // process.env has no keys (beforeEach), yet the injected resolver reports one,
    // so the pipeline must enter the AI-refine branch. The injected facade throws
    // (no network in tests), exercising the graceful degrade-to-defaults path.
    const resolveKey: KeyResolver = (name) => (name === 'QWEN_API_KEY' ? 'sk-test' : undefined);
    const throwingAi: AIFacade = { complete: () => Promise.reject(new Error('offline in test')) };
    const { ctx, result, lines } = startRun({
      over: { dryRun: true, autoApprove: true },
      resolveKey,
      ai: throwingAi,
    });
    await result;

    // Entered the AI branch (fill attempted + degraded), not the keyless branch.
    expect(lines.some((l) => l.includes('falling back to template defaults'))).toBe(true);
    expect(lines.some((l) => l.includes('No AI API key found'))).toBe(false);
    expect(ctx.plan?.source).toBe('template'); // degraded cleanly to defaults
  });
});
