/**
 * PHASE F unit tests — the repo signature/shape and the JSON-file override store, in
 * isolation from the pipeline. Signature normalization must be stable and identity-only;
 * the store must round-trip records to disk, honor the schema version, and evict.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HealOverrideStore,
  overrideMatchesShape,
  resolveOrcaHome,
  type HealOverrideRecord,
} from '../../src/build/healStore.js';
import {
  normalizeRepoId,
  recipeFingerprint,
  repoShapeFrom,
  signatureFor,
} from '../../src/build/repoSignature.js';
import { createRunContext, type Logger } from '../../src/core/context.js';
import type { DetectedComponent, DetectionResult } from '../../src/detect/types.js';
import type { ServicePlan } from '../../src/plan/types.js';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const record = (over: Partial<HealOverrideRecord> = {}): HealOverrideRecord => ({
  version: 1,
  signature: 'sig-1',
  repoId: 'github.com/acme/app',
  languages: ['javascript'],
  frameworks: ['express'],
  recipeFingerprint: ['node-express'],
  files: [{ path: 'docker-compose.yml', kind: 'compose', original: 'a', healed: 'b' }],
  changedSteps: ['docker-compose.yml'],
  explanation: 'fixed the start command',
  createdAt: '2026-01-01T00:00:00.000Z',
  orcaVersion: '0.1.0',
  ...over,
});

describe('normalizeRepoId', () => {
  it('collapses git URL forms of the same repo to one identity', () => {
    const https = normalizeRepoId('https://github.com/Acme/App.git');
    const ssh = normalizeRepoId('git@github.com:Acme/App.git');
    const creds = normalizeRepoId('https://token@github.com/acme/app/');
    expect(https).toBe('github.com/acme/app');
    expect(ssh).toBe('github.com/acme/app');
    expect(creds).toBe('github.com/acme/app');
  });

  it('keeps a local path stable across runs (trailing slash aside)', () => {
    expect(normalizeRepoId('/Users/me/dev/MyRepo/')).toBe('/Users/me/dev/MyRepo');
    expect(normalizeRepoId('/Users/me/dev/MyRepo')).toBe('/Users/me/dev/MyRepo');
  });

  it('signatureFor is a deterministic hex digest keyed on identity alone', () => {
    const a = signatureFor(normalizeRepoId('https://github.com/acme/app.git'));
    const b = signatureFor(normalizeRepoId('git@github.com:acme/app.git'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b); // same repo, different URL form → same signature
    expect(a).not.toBe(signatureFor('github.com/acme/other'));
  });
});

describe('recipeFingerprint (recipe-agnostic)', () => {
  const detection = (over: Partial<DetectionResult> = {}): DetectionResult =>
    ({
      repoPath: '/x',
      languages: ['javascript'],
      packageManagers: ['npm'],
      // recipeFingerprint now looks up a seed node's OWN component via componentRootDir
      // (not the singular .backend compat field), so this needs a real rootDir - kept in
      // sync with the ServiceNode fixtures below, which all use componentRootDir: '.'.
      components: [{ role: 'backend', rootDir: '.', framework: 'express' } as DetectedComponent],
      frontend: null,
      backend: { framework: 'express' },
      databases: [],
      isSupported: true,
      confidence: 0.9,
      reasoning: [],
      insights: {
        frameworks: [],
        runtimes: [],
        monorepoTools: [],
        ciCommands: [],
        ciRuntimeVersions: [],
        taskCommands: [],
        ecosystemComponents: [],
      },
      warnings: [],
      ...over,
    }) as DetectionResult;

  const plan = (services: ServicePlan['services']): ServicePlan => ({
    projectName: 'orca-x',
    services,
    networks: ['orca-net'],
    volumes: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'template',
  });

  it('uses a synthetic seed:<kind>:<framework> token for a seed template node', () => {
    const ctx = createRunContext({ repoUrl: 'x', workspaceDir: '/x', logger: silent });
    ctx.detection = detection();
    ctx.plan = plan([
      {
        id: 'backend',
        name: 'backend',
        kind: 'backend',
        componentRootDir: '.',
        source: { type: 'build', context: '.', dockerfile: 'Dockerfile' },
        ports: [],
        environment: {},
        dependsOn: [],
        volumes: [],
      },
    ]);
    expect(recipeFingerprint(ctx)).toEqual(['seed:backend:.:express']);
  });

  it('uses the recipeId verbatim for an ecosystem/inferred node (any future recipe)', () => {
    const ctx = createRunContext({ repoUrl: 'x', workspaceDir: '/x', logger: silent });
    ctx.detection = detection({ backend: null, components: [] });
    ctx.plan = plan([
      {
        id: 'app',
        name: 'app',
        kind: 'service',
        source: {
          type: 'build',
          context: '.',
          dockerfile: 'Dockerfile',
          recipeId: 'some-future-recipe',
        },
        ports: [],
        environment: {},
        dependsOn: [],
        volumes: [],
      },
    ]);
    expect(recipeFingerprint(ctx)).toEqual(['some-future-recipe']);
  });

  it('shape captures identity, languages, frameworks, and a sorted fingerprint', () => {
    const ctx = createRunContext({
      repoUrl: 'https://github.com/acme/app.git',
      workspaceDir: '/x',
      logger: silent,
    });
    ctx.detection = detection({ languages: ['typescript', 'javascript'] });
    ctx.plan = plan([
      {
        id: 'backend',
        name: 'backend',
        kind: 'backend',
        componentRootDir: '.',
        source: { type: 'build', context: '.', dockerfile: 'Dockerfile' },
        ports: [],
        environment: {},
        dependsOn: [],
        volumes: [],
      },
    ]);
    const shape = repoShapeFrom(ctx);
    expect(shape.repoId).toBe('github.com/acme/app');
    expect(shape.languages).toEqual(['javascript', 'typescript']); // sorted
    expect(shape.frameworks).toEqual(['express']);
    expect(shape.recipeFingerprint).toEqual(['seed:backend:.:express']);
  });
});

describe('overrideMatchesShape (staleness guard)', () => {
  it('matches when the recipe fingerprint is unchanged', () => {
    expect(
      overrideMatchesShape(record({ recipeFingerprint: ['node-express'] }), {
        repoId: 'github.com/acme/app',
        languages: ['javascript'],
        frameworks: ['express'],
        recipeFingerprint: ['node-express'],
      })
    ).toBe(true);
  });

  it('does NOT match when the detected recipe changed (repo changed shape)', () => {
    expect(
      overrideMatchesShape(record({ recipeFingerprint: ['node-express'] }), {
        repoId: 'github.com/acme/app',
        languages: ['python'],
        frameworks: ['fastapi'],
        recipeFingerprint: ['python-fastapi'],
      })
    ).toBe(false);
  });
});

describe('HealOverrideStore (JSON persistence)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a record to disk and back through a fresh store instance', async () => {
    await new HealOverrideStore(dir).save(record({ signature: 'sig-A' }));

    // A brand-new instance reads from disk — this is the cross-run persistence path.
    const reloaded = await new HealOverrideStore(dir).lookup('sig-A');
    expect(reloaded?.repoId).toBe('github.com/acme/app');
    expect(reloaded?.files[0]?.healed).toBe('b');

    const raw = JSON.parse(await readFile(join(dir, 'heal-overrides.json'), 'utf8')) as {
      version: number;
    };
    expect(raw.version).toBe(1);
  });

  it('returns null for an unknown signature and for an empty store', async () => {
    expect(await new HealOverrideStore(dir).lookup('missing')).toBeNull();
  });

  it('evicts a record', async () => {
    const store = new HealOverrideStore(dir);
    await store.save(record({ signature: 'sig-B' }));
    await store.evict('sig-B');
    expect(await store.lookup('sig-B')).toBeNull();
  });

  it('ignores a corrupt or version-mismatched store file rather than throwing', async () => {
    await writeFile(join(dir, 'heal-overrides.json'), '{ not valid json', 'utf8');
    expect(await new HealOverrideStore(dir).lookup('anything')).toBeNull();

    await writeFile(
      join(dir, 'heal-overrides.json'),
      JSON.stringify({ version: 999, records: { x: record() } }),
      'utf8'
    );
    expect(await new HealOverrideStore(dir).lookup('x')).toBeNull();
  });
});

describe('resolveOrcaHome', () => {
  it('prefers ORCA_HOME when set, else falls back to ~/.orca', () => {
    expect(resolveOrcaHome({ ORCA_HOME: '/tmp/orca-test' })).toBe('/tmp/orca-test');
    expect(resolveOrcaHome({})).toMatch(/\.orca$/);
  });
});
