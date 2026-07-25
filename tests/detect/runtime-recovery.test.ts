/**
 * §P2 "RepoInsights shape pressure": `ciRuntimeVersions` was the last dead-end parallel
 * array — four providers' pins, merged flat, provenance-less, read only by `logInsights`.
 * It is now folded into a ranked, provenance-carrying `Claim` the `buildRecovery` way.
 *
 * These tests pin the fold directly and end-to-end, and — critically — assert the AC that
 * providers are DATA: a pin's `provider` label rides into the claim's origins/evidence,
 * never a branch, so a new provider contributes with no consumer edit.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { recoverRuntimes, type RuntimeVersionSignal } from '../../src/detect/runtimeRecovery.js';

describe('recoverRuntimes (fold)', () => {
  it('returns null when nothing pinned a version', () => {
    expect(recoverRuntimes([])).toBeNull();
  });

  it('normalizes one provider pin into a claim carrying its provenance', () => {
    const claim = recoverRuntimes([{ runtime: 'node', version: '20', provider: 'gitlab' }]);
    expect(claim).not.toBeNull();
    expect(claim!.value.versions).toEqual([
      { runtime: 'node', version: '20', origins: ['gitlab'] },
    ]);
    expect(claim!.value.origins).toEqual(['gitlab']);
    expect(claim!.confidence).toBeGreaterThan(0);
  });

  it('records every provider that agrees on the same pin (cross-source agreement)', () => {
    const signals: RuntimeVersionSignal[] = [
      { runtime: 'node', version: '20', provider: 'github-actions' },
      { runtime: 'node', version: '20', provider: 'circleci' },
    ];
    const claim = recoverRuntimes(signals)!;
    expect(claim.value.versions).toEqual([
      { runtime: 'node', version: '20', origins: ['github-actions', 'circleci'] },
    ]);
    // Two independent providers agreeing is stronger than one alone.
    const single = recoverRuntimes([signals[0]!])!;
    expect(claim.confidence).toBeGreaterThan(single.confidence);
  });

  it('keeps a genuine cross-source disagreement as two entries', () => {
    const claim = recoverRuntimes([
      { runtime: 'node', version: '18', provider: 'github-actions' },
      { runtime: 'node', version: '20', provider: 'gitlab' },
    ])!;
    expect(claim.value.versions).toEqual([
      { runtime: 'node', version: '18', origins: ['github-actions'] },
      { runtime: 'node', version: '20', origins: ['gitlab'] },
    ]);
  });

  it('treats the provider as data — a never-before-seen provider needs no code change', () => {
    const claim = recoverRuntimes([{ runtime: 'go', version: '1.23', provider: 'buildkite' }])!;
    expect(claim.value.versions[0]!.origins).toEqual(['buildkite']);
    expect(claim.value.origins).toEqual(['buildkite']);
  });
});

describe('detectStack: recoveredRuntimes end-to-end', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-runtime-recovery-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('folds GitHub Actions + GitLab pins into one claim with provider provenance', async () => {
    const wf = join(repo, '.github', 'workflows');
    await mkdir(wf, { recursive: true });
    await writeFile(
      join(wf, 'ci.yml'),
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '        with:',
        "          node-version: '18'",
      ].join('\n')
    );
    await writeFile(
      join(repo, '.gitlab-ci.yml'),
      ['test_job:', '  image: node:20', '  script:', '    - npm test'].join('\n')
    );

    const { recoveredRuntimes, ciRuntimeVersions } = (await detectStack(repo)).insights;

    expect(recoveredRuntimes).not.toBeNull();
    expect(recoveredRuntimes!.versions).toEqual([
      { runtime: 'node', version: '18', origins: ['github-actions'] },
      { runtime: 'node', version: '20', origins: ['gitlab'] },
    ]);
    expect(recoveredRuntimes!.origins).toEqual(['github-actions', 'gitlab']);
    expect(recoveredRuntimes!.confidence).toBeGreaterThan(0);
    // The raw array stays available as the fold's input, byte-identical to before.
    expect(ciRuntimeVersions).toEqual([
      { runtime: 'node', version: '18' },
      { runtime: 'node', version: '20' },
    ]);
  });

  it('is null for a repo with no CI runtime pins', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4' } })
    );
    expect((await detectStack(repo)).insights.recoveredRuntimes).toBeNull();
  });
});
