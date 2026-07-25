/**
 * The extension-point guarantees behind the P2 "`RepoInsights` shape pressure" item.
 *
 * These tests exist to FAIL if the growth pattern comes back. The claim they defend is
 * not "recovery works" (that is `build-recovery.test.ts`) but "adding a signal source or
 * a CI provider costs one registry entry and no consumer edit" — so every test here
 * introduces something genuinely new from the outside and asserts it flows end to end
 * without touching `recoverBuild`, `RepoInsights`, or any downstream reader.
 */

import { describe, it, expect } from 'vitest';

import { recoverBuild } from '../../src/detect/buildRecovery.js';
import {
  SignalSourceRegistry,
  defaultSignalSources,
  DEFAULT_SOURCE_WEIGHTS,
  type SignalSource,
} from '../../src/detect/signalSources.js';
import type { RepoInsights } from '../../src/detect/types.js';

function insights(overrides: Partial<RepoInsights> = {}): RepoInsights {
  return {
    frameworks: [],
    runtimes: [],
    monorepoTools: [],
    ciCommands: [],
    ciRuntimeVersions: [],
    ciProviders: [],
    dockerfiles: [],
    taskCommands: [],
    scriptSources: [],
    ecosystemComponents: [],
    recoveredBuild: null,
    ...overrides,
  };
}

describe('registering a brand-new signal source', () => {
  /**
   * A source nothing in `src/` knows about: it reads a field that already exists rather
   * than an 11th array, and is registered from outside. If this needs an edit to
   * `recoverBuild` to work, the extension point has regressed.
   */
  const devcontainer: SignalSource = {
    id: 'devcontainer',
    weight: 0.5,
    rank: 5,
    extract: (i) =>
      i.monorepoTools
        .filter((t) => t.startsWith('devcontainer:'))
        .map((t) => ({
          command: t.slice('devcontainer:'.length),
          kind: 'build',
          origin: '.devcontainer/devcontainer.json',
        })),
  };

  it('contributes commands with no edit to recoverBuild', () => {
    const sources = defaultSignalSources().register(devcontainer);

    const claim = recoverBuild(
      insights({ monorepoTools: ['devcontainer:make bootstrap'] }),
      sources
    );

    expect(claim?.value.buildCommands).toEqual(['make bootstrap']);
    expect(claim?.value.origins).toEqual(['.devcontainer/devcontainer.json']);
  });

  it('carries its own weight into the evidence trail', () => {
    const sources = defaultSignalSources().register(devcontainer);

    const claim = recoverBuild(
      insights({ monorepoTools: ['devcontainer:make bootstrap'] }),
      sources
    );

    // Weight comes off the descriptor, so a new family scores without a table edit.
    expect(claim?.evidence).toEqual([
      expect.objectContaining({ detector: 'build-recovery:devcontainer', weight: 0.5 }),
    ]);
  });

  it('loses to a better-ranked family that declares the same kind', () => {
    const sources = defaultSignalSources().register(devcontainer);

    const claim = recoverBuild(
      insights({
        ciCommands: [{ command: 'npm run build', kind: 'build' }],
        monorepoTools: ['devcontainer:make bootstrap'],
      }),
      sources
    );

    // rank 5 vs CI's rank 0 — families are exclusive, so CI takes the kind outright.
    expect(claim?.value.buildCommands).toEqual(['npm run build']);
  });

  it('is ignored entirely when it is not registered', () => {
    // Same insights, default registry: proves the fixture only works via registration
    // and is not being picked up by some pre-existing extractor.
    expect(recoverBuild(insights({ monorepoTools: ['devcontainer:make bootstrap'] }))).toBeNull();
  });
});

describe('registry ordering', () => {
  it('orders sources by rank, not registration order', () => {
    const sources = new SignalSourceRegistry()
      .register({ id: 'late', weight: 0.1, rank: 9, extract: () => [] })
      .register({ id: 'early', weight: 0.1, rank: 1, extract: () => [] });

    expect(sources.all().map((s) => s.id)).toEqual(['early', 'late']);
  });

  it('breaks rank ties on id so the fold order is total', () => {
    // Two sources at the same rank must still fold deterministically, or recovered
    // commands (and the golden output downstream) would depend on registration order.
    const sources = new SignalSourceRegistry()
      .register({ id: 'zebra', weight: 0.1, rank: 3, extract: () => [] })
      .register({ id: 'alpha', weight: 0.1, rank: 3, extract: () => [] });

    expect(sources.all().map((s) => s.id)).toEqual(['alpha', 'zebra']);
  });

  it('replaces rather than duplicates when an id is registered twice', () => {
    const sources = defaultSignalSources().register({
      id: 'ci',
      weight: 0.99,
      rank: 0,
      extract: () => [],
    });

    expect(sources.all().filter((s) => s.id === 'ci')).toHaveLength(1);
    expect(sources.weightOf('ci')).toBe(0.99);
  });

  it('reports zero weight for an unregistered family', () => {
    expect(defaultSignalSources().weightOf('nope')).toBe(0);
  });
});

describe('holding the ciProviders line', () => {
  it('recovers from a provider value the fold has never seen', () => {
    // `provider` is data in the provenance string, never a branch. A parser writing a
    // new provider name must need no edit anywhere downstream.
    const claim = recoverBuild(
      insights({
        ciProviders: [
          {
            provider: 'buildkite',
            file: '.buildkite/pipeline.yml',
            stages: ['build'],
            jobs: [
              {
                name: 'compile',
                stage: 'build',
                commands: [{ command: 'go build ./cmd/api', kind: 'build' }],
                image: 'golang:1.22',
              },
            ],
            image: null,
          },
        ],
      })
    );

    expect(claim?.value.buildCommands).toEqual(['go build ./cmd/api']);
    expect(claim?.value.origins).toEqual(['buildkite:pipeline.yml#compile']);
    expect(claim?.value.image).toBe('golang:1.22');
  });

  it('scores an unknown provider in the same ci family, not a new one', () => {
    const claim = recoverBuild(
      insights({
        ciCommands: [{ command: 'npm ci', kind: 'install' }],
        ciProviders: [
          {
            provider: 'buildkite',
            file: '.buildkite/pipeline.yml',
            stages: [],
            jobs: [
              {
                name: 'compile',
                stage: null,
                commands: [{ command: 'npm run build', kind: 'build' }],
                image: null,
              },
            ],
            image: null,
          },
        ],
      })
    );

    // One `ci` evidence entry, not two: a repo's Actions workflow and its other pipeline
    // are the same claim, so they must not double-count as corroborating opinions.
    expect(claim?.evidence.filter((e) => e.detector.startsWith('build-recovery:'))).toHaveLength(1);
  });

  it('recovers from a task runner name the fold has never seen', () => {
    const claim = recoverBuild(
      insights({
        taskCommands: [
          { source: 'rakefile', name: 'assets', command: 'rake assets:precompile', kind: 'build' },
        ],
      })
    );

    expect(claim?.value.buildCommands).toEqual(['rake assets:precompile']);
    expect(claim?.value.origins).toEqual(['rakefile:assets']);
  });
});

describe('DEFAULT_SOURCE_WEIGHTS', () => {
  it('is read off the descriptors so the two cannot drift', () => {
    const sources = defaultSignalSources();

    expect(DEFAULT_SOURCE_WEIGHTS.ci).toBe(sources.weightOf('ci'));
    expect(DEFAULT_SOURCE_WEIGHTS.task).toBe(sources.weightOf('task'));
    expect(DEFAULT_SOURCE_WEIGHTS.script).toBe(sources.weightOf('script'));
  });
});
