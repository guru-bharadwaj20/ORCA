/**
 * PHASE F integration tests — learned heal overrides through the REAL pipeline. Docker is
 * mocked (as in pipeline.test) and the self-heal AI is injected, but detection, planning,
 * config generation, the override store, and its on-disk JSON file are all real, against a
 * temp `ORCA_HOME`. Covers the four required behaviors:
 *   (a) a fresh repo with no override goes through normal self-heal and LEARNS one,
 *   (b) a repo with a matching stored override applies it and does NOT re-heal,
 *   (c) a repo whose detected recipe shape changed does NOT blindly apply a stale override,
 *   (d) the override persists to disk and reloads in a separate pipeline run.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HealOverrideStore } from '../../src/build/healStore.js';
import { normalizeRepoId, signatureFor } from '../../src/build/repoSignature.js';
import {
  createRunContext,
  DEFAULT_RUN_OPTIONS,
  type Logger,
  type RunContext,
} from '../../src/core/context.js';
import { runPipeline } from '../../src/core/pipeline.js';

const docker = vi.hoisted(() => ({
  assertDockerAvailable: vi.fn(),
  composeBuild: vi.fn(),
  composeUp: vi.fn(),
  composeDown: vi.fn(),
  composeLogs: vi.fn(),
}));
vi.mock('../../src/build/docker.js', () => docker);

const dockerOk = { exitCode: 0, stdout: '', stderr: '' };
const buildFail = { exitCode: 1, stdout: '', stderr: 'npm ERR! missing script: dev' };

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const HEALED_COMPOSE = 'name: healed-by-orca\nservices: {}\n';

/** A self-heal AI facade that always patches docker-compose.yml with the healed marker. */
function healingAi() {
  return vi.fn().mockResolvedValue({
    explanation: 'The start command pointed at a script the repo does not define.',
    fix: 'Rewrote docker-compose.yml with a working command.',
    patches: [{ file: 'docker-compose.yml', contents: HEALED_COMPOSE }],
  });
}

function collectLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string) => void lines.push(`${level} ${message}`);
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

/** Set docker to fail the first build then succeed (forces one heal), or always succeed. */
function setDocker(mode: 'fail-once' | 'always-ok'): void {
  docker.assertDockerAvailable.mockResolvedValue(undefined);
  docker.composeUp.mockResolvedValue(dockerOk);
  docker.composeDown.mockResolvedValue(dockerOk);
  docker.composeLogs.mockResolvedValue(dockerOk);
  docker.composeBuild.mockReset();
  if (mode === 'fail-once') {
    docker.composeBuild.mockResolvedValueOnce(buildFail).mockResolvedValue(dockerOk);
  } else {
    docker.composeBuild.mockResolvedValue(dockerOk);
  }
}

const workspaces: string[] = [];
let orcaHome: string;
const savedOrcaHome = process.env['ORCA_HOME'];
const savedKeys = {
  qwen: process.env['QWEN_API_KEY'],
  anthropic: process.env['ANTHROPIC_API_KEY'],
};

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env['QWEN_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
  orcaHome = await mkdtemp(join(tmpdir(), 'orca-home-'));
  process.env['ORCA_HOME'] = orcaHome;
});

afterEach(async () => {
  await rm(orcaHome, { recursive: true, force: true });
  for (const ws of workspaces.splice(0)) {
    await rm(dirname(ws), { recursive: true, force: true });
  }
  if (savedOrcaHome !== undefined) process.env['ORCA_HOME'] = savedOrcaHome;
  else delete process.env['ORCA_HOME'];
  if (savedKeys.qwen !== undefined) process.env['QWEN_API_KEY'] = savedKeys.qwen;
  if (savedKeys.anthropic !== undefined) process.env['ANTHROPIC_API_KEY'] = savedKeys.anthropic;
});

/** Run the pipeline once against a fresh clone; returns the ctx (workspace tracked for cleanup). */
async function runOnceThroughPipeline(
  repoUrl: string,
  ai?: RunContext['ai']
): Promise<{ ctx: RunContext; lines: string[] }> {
  const { logger, lines } = collectLogger();
  const ctx = createRunContext({
    repoUrl,
    workspaceDir: '',
    logger,
    options: { ...DEFAULT_RUN_OPTIONS, autoApprove: true, maxHealAttempts: 2 },
  });
  if (ai !== undefined) ctx.ai = ai;
  const output = new PassThrough();
  output.resume();
  await runPipeline(ctx, { output });
  if (ctx.workspaceDir !== '') workspaces.push(ctx.workspaceDir);
  return { ctx, lines };
}

describe('learned heal overrides through the pipeline', () => {
  it('(a) a fresh repo self-heals normally and learns an override', async () => {
    setDocker('fail-once');
    const ai = healingAi();

    const { ctx, lines } = await runOnceThroughPipeline(fixture('mern-repo'), { complete: ai });

    // Normal heal path ran: the AI was consulted and a diagnosis recorded.
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ctx.diagnosis.length).toBe(1);
    expect(lines.some((l) => l.includes('Saved a learned heal override'))).toBe(true);

    // The override was persisted to disk under ORCA_HOME with the healed compose content.
    const signature = signatureFor(normalizeRepoId(fixture('mern-repo')));
    const stored = await new HealOverrideStore(orcaHome).lookup(signature);
    expect(stored).not.toBeNull();
    expect(stored?.files.find((f) => f.path === 'docker-compose.yml')?.healed).toBe(HEALED_COMPOSE);
    expect(stored?.changedSteps).toContain('docker-compose.yml');
  });

  it('(b) a repo with a matching stored override applies it and does NOT re-heal', async () => {
    // Learning run (heal happens once, override saved).
    setDocker('fail-once');
    await runOnceThroughPipeline(fixture('mern-repo'), { complete: healingAi() });

    // Reuse run: build succeeds on the first attempt, so no heal is needed. The override
    // must still be applied to the freshly-generated config before that first build.
    setDocker('always-ok');
    const reuseAi = healingAi();
    const { ctx, lines } = await runOnceThroughPipeline(fixture('mern-repo'), {
      complete: reuseAi,
    });

    expect(reuseAi).not.toHaveBeenCalled(); // no fresh heal cycle
    expect(ctx.diagnosis.length).toBe(0);
    expect(lines.some((l) => l.includes('Applied a learned heal override'))).toBe(true);
    // The healed content was written over the generated compose file before the build.
    const composeOnDisk = await readFile(join(ctx.workspaceDir, 'docker-compose.yml'), 'utf8');
    expect(composeOnDisk).toBe(HEALED_COMPOSE);
  });

  it('(c) a stale override (detected recipe changed) is NOT blindly applied', async () => {
    // Learn an override, then tamper its recipe fingerprint to simulate the repo having
    // changed shape since it was stored.
    setDocker('fail-once');
    await runOnceThroughPipeline(fixture('mern-repo'), { complete: healingAi() });

    const signature = signatureFor(normalizeRepoId(fixture('mern-repo')));
    const storePath = join(orcaHome, 'heal-overrides.json');
    const store = JSON.parse(await readFile(storePath, 'utf8')) as {
      records: Record<string, { recipeFingerprint: string[] }>;
    };
    store.records[signature]!.recipeFingerprint = ['python-fastapi']; // no longer matches mern
    await writeFile(storePath, JSON.stringify(store), 'utf8');

    // Next run: the stale override must be discarded, so the build fails and the normal
    // heal cycle runs again (AI consulted).
    setDocker('fail-once');
    const freshAi = healingAi();
    const { ctx, lines } = await runOnceThroughPipeline(fixture('mern-repo'), {
      complete: freshAi,
    });

    expect(lines.some((l) => l.includes('Discarded a stale heal override'))).toBe(true);
    expect(lines.some((l) => l.includes('Applied a learned heal override'))).toBe(false);
    expect(freshAi).toHaveBeenCalledTimes(1); // it re-healed rather than trusting the stale fix
    expect(ctx.diagnosis.length).toBe(1);

    // The re-heal rewrote the override with the CURRENT (correct) fingerprint.
    const rewritten = await new HealOverrideStore(orcaHome).lookup(signature);
    expect(rewritten?.recipeFingerprint).not.toEqual(['python-fastapi']);
    // Fingerprint tokens now include the owning component's rootDir (mern's backend is
    // at 'server'), so two same-framework nodes never collapse into one token.
    expect(rewritten?.recipeFingerprint).toContain('seed:backend:server:express');
  });

  it('(d) the override persists to disk and reloads in a separate pipeline run', async () => {
    setDocker('fail-once');
    await runOnceThroughPipeline(fixture('mern-repo'), { complete: healingAi() });

    // Prove it is on disk (not merely in-memory) by reading it with a brand-new store.
    const signature = signatureFor(normalizeRepoId(fixture('mern-repo')));
    const onDisk = await new HealOverrideStore(orcaHome).lookup(signature);
    expect(onDisk).not.toBeNull();

    // A completely separate pipeline invocation (fresh ctx, fresh store built inside the
    // pipeline from ORCA_HOME) reloads and applies it without any AI heal.
    setDocker('always-ok');
    const reloadAi = healingAi();
    const { lines } = await runOnceThroughPipeline(fixture('mern-repo'), { complete: reloadAi });

    expect(reloadAi).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('Applied a learned heal override'))).toBe(true);
  });
});
