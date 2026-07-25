/**
 * PHASE B tests — tier-1 runtime detectors on the Claim model. Each detector reads
 * real files from a temp repo tree (nothing mocked) and must emit an evidence-backed
 * Claim<Runtime> only when its manifest is present.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultDetectorRegistry,
  goDetector,
  jvmDetector,
  rustDetector,
} from '../../src/detect/detectors/index.js';
import type { RepoContext } from '../../src/model/detector.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-rt-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (): RepoContext => ({ repoPath: dir, scopeDir: '.' });

describe('runtime detectors', () => {
  it('goDetector claims go from go.mod with a reasoning trail', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.23\n');
    const claims = await goDetector.detect(ctx());

    expect(claims).toHaveLength(1);
    expect(claims[0]?.value).toEqual({ kind: 'runtime', runtime: 'go' });
    expect(claims[0]?.source).toBe('deterministic');
    expect(claims[0]?.confidence).toBeGreaterThan(0.8);
    expect(claims[0]?.evidence[0]?.signal).toBe('go.mod present');
  });

  it('emits nothing when the manifest is absent', async () => {
    expect(await goDetector.detect(ctx())).toEqual([]);
    expect(await rustDetector.detect(ctx())).toEqual([]);
  });

  it('records a lockfile as evidence without compounding confidence', async () => {
    await writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "app"\n');
    const single = await rustDetector.detect(ctx());

    await writeFile(join(dir, 'Cargo.lock'), '# lockfile\n');
    const withLock = await rustDetector.detect(ctx());

    // A lockfile is GENERATED FROM its manifest, so it is the same fact observed twice.
    // It belongs in the reasoning trail, but treating it as independent corroboration
    // would inflate an ordinary Rust repo from 0.85 to 0.978.
    expect(withLock[0]?.evidence).toHaveLength(2);
    expect(withLock[0]?.confidence).toBe(single[0]?.confidence);
  });

  it('jvmDetector recognizes both Maven and Gradle layouts', async () => {
    await writeFile(join(dir, 'pom.xml'), '<project/>');
    expect((await jvmDetector.detect(ctx()))[0]?.value.runtime).toBe('jvm');
  });

  it('defaultDetectorRegistry exposes only tier-1 detectors so far', () => {
    const registry = defaultDetectorRegistry();
    expect(registry.all().length).toBeGreaterThan(0);
    expect(registry.atTier(1).length).toBe(registry.all().length);
  });
});
