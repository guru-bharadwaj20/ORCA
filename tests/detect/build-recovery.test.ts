/**
 * Build recovery — folding every source that DECLARES how a repo is built (CI across all
 * providers, task runners, README/shell scripts) into one ranked answer that reaches the
 * plan with provenance.
 *
 * The headline assertion is the acceptance criterion: a repo carrying ONLY a provider CI
 * file — no README, no Makefile, no scripts — produces a plan whose build/start commands
 * trace back to that CI file. It runs once per provider against a real fixture, through
 * the real pipeline.
 *
 * Providers are exercised through the same code path on purpose. There is no per-provider
 * branch in `buildRecovery.ts`; `ciProviders` is walked as data, so these three cases
 * differ only in which file the fixture ships.
 */
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createRunContext, DEFAULT_RUN_OPTIONS, type Logger } from '../../src/core/context.js';
import { runPipeline } from '../../src/core/pipeline.js';
import { applyRecoveredBuild, recoverBuild } from '../../src/detect/buildRecovery.js';
import { detectStack } from '../../src/detect/index.js';
import type { RepoInsights } from '../../src/detect/types.js';
import type { BuildRecipe } from '../../src/model/recipe.js';

const docker = vi.hoisted(() => ({
  assertDockerAvailable: vi.fn(),
  composeBuild: vi.fn(),
  composeUp: vi.fn(),
  composeDown: vi.fn(),
  composeLogs: vi.fn(),
}));
vi.mock('../../src/build/docker.js', () => docker);

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

function silentLogger(): Logger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/** Run the real pipeline in dry-run/auto-approve and hand back the resolved context. */
async function planFor(repo: string) {
  const output = new PassThrough();
  output.resume();
  const ctx = createRunContext({
    repoUrl: repo,
    workspaceDir: repo,
    logger: silentLogger(),
    options: { ...DEFAULT_RUN_OPTIONS, dryRun: true, autoApprove: true },
  });
  await runPipeline(ctx, { output });
  return ctx;
}

/** Minimal insights with only the fields under test populated. */
function insights(over: Partial<RepoInsights> = {}): RepoInsights {
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
    ...over,
  };
}

const goRecipe: BuildRecipe = {
  id: 'go-mod',
  runtime: 'go',
  dependencyFiles: ['go.mod'],
  installCommands: ['go mod download'],
  buildCommands: ['go build -o /app/server ./...'],
  startCommand: '/app/server',
  defaultPorts: [8080],
  baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
};

// The three providers, their fixture, and the label that must appear in provenance.
const PROVIDERS = [
  { name: 'GitLab CI', repo: 'gitlab-build-repo', origin: 'gitlab:.gitlab-ci.yml' },
  { name: 'Azure Pipelines', repo: 'azure-build-repo', origin: 'azure:azure-pipelines.yml' },
  { name: 'CircleCI', repo: 'circleci-build-repo', origin: 'circleci:config.yml' },
] as const;

describe.each(PROVIDERS)('$name — CI as the only command source', ({ repo, origin }) => {
  it('recovers the build/start commands into insights with provenance', async () => {
    const detection = await detectStack(fixture(repo));
    const recovered = detection.insights.recoveredBuild;

    expect(recovered).not.toBeNull();
    expect(recovered?.buildCommands).toEqual(['go build -o bin/apiservice ./cmd/api']);
    expect(recovered?.startCommand).toBe('./bin/apiservice --serve');
    // Provenance names the provider and the file it came from.
    expect(recovered?.origins.some((o) => o.startsWith(origin))).toBe(true);
  });

  it('ACCEPTANCE: the plan build/start commands trace back to the CI file', async () => {
    const ctx = await planFor(fixture(repo));

    const node = ctx.plan?.services.find((s) => s.kind === 'service');
    expect(node).toBeDefined();
    if (node?.source.type !== 'build') throw new Error('expected a build source');

    // The recipe the plan will synthesize from carries the CI-declared commands, not the
    // go-mod recipe's defaults (`go build -o /app/server ./...` / `/app/server`).
    expect(node.source.recipe?.buildCommands).toEqual(['go build -o bin/apiservice ./cmd/api']);
    expect(node.source.recipe?.startCommand).toBe('./bin/apiservice --serve');

    // …and they can be traced back to the file that declared them.
    expect(node.source.commandOrigins?.some((o) => o.startsWith(origin))).toBe(true);
  });

  it('carries the CI job image through to the recovered build', async () => {
    const detection = await detectStack(fixture(repo));
    expect(detection.insights.recoveredBuild?.image).toBeTruthy();
  });
});

describe('recoverBuild across sources', () => {
  it('treats every CI provider uniformly, with no per-provider branch', () => {
    const providerEntry = (provider: 'gitlab' | 'azure' | 'circleci') => ({
      provider,
      file: `/repo/${provider}.yml`,
      stages: [],
      jobs: [
        {
          name: 'b',
          stage: null,
          commands: [{ command: `${provider} build`, kind: 'build' }],
          image: `${provider}:1`,
        },
      ],
      image: null,
    });

    const claim = recoverBuild(
      insights({
        ciProviders: [providerEntry('gitlab'), providerEntry('azure'), providerEntry('circleci')],
      })
    );

    expect(claim?.value.buildCommands).toEqual(['gitlab build', 'azure build', 'circleci build']);
    expect(claim?.value.origins).toEqual([
      'gitlab:gitlab.yml#b',
      'azure:azure.yml#b',
      'circleci:circleci.yml#b',
    ]);
  });

  it('ranks CI above task runners above scripts when they disagree', () => {
    const claim = recoverBuild(
      insights({
        ciProviders: [
          {
            provider: 'gitlab',
            file: '.gitlab-ci.yml',
            stages: [],
            jobs: [
              {
                name: 'run',
                stage: null,
                commands: [{ command: 'ci start', kind: 'start' }],
                image: null,
              },
            ],
            image: null,
          },
        ],
        taskCommands: [{ source: 'makefile', name: 'run', command: 'make start', kind: 'start' }],
        scriptSources: [
          {
            source: 'readme',
            file: 'README.md',
            commands: [{ command: 'readme start', kind: 'start' }],
            ports: [],
          },
        ],
      })
    );

    expect(claim?.value.startCommand).toBe('ci start');
    // All three still contribute evidence — agreement is what raises confidence (§4).
    expect(claim?.evidence.map((e) => e.detector)).toEqual([
      'build-recovery:ci',
      'build-recovery:task',
      'build-recovery:script',
    ]);
  });

  it('returns null when nothing actionable was declared', () => {
    expect(recoverBuild(insights())).toBeNull();
    // `test`/`other` commands alone are not a build recovery.
    expect(
      recoverBuild(insights({ ciCommands: [{ command: 'npm test', kind: 'test' }] }))
    ).toBeNull();
  });
});

describe('rejecting commands that are not about the app', () => {
  // Regression: real CI files are mostly infrastructure. `docker build -t app .` is the
  // single most common "build" step in CI, and classifyCommand rightly calls it a build —
  // but copying it into the generated Dockerfile emits `RUN docker build` INSIDE the
  // image, which cannot work. This filter is what makes the feature safe on real repos.
  const ci = (commands: { command: string; kind: string }[]): RepoInsights['ciProviders'] => [
    {
      provider: 'gitlab',
      file: '.gitlab-ci.yml',
      stages: [],
      jobs: [{ name: 'j', stage: null, commands, image: null }],
      image: null,
    },
  ];

  it('drops container and deployment tooling, keeping the real app build', () => {
    const claim = recoverBuild(
      insights({
        ciProviders: ci([
          { command: 'docker build -t myapp:latest .', kind: 'build' },
          { command: 'docker push myapp:latest', kind: 'build' },
          { command: 'kubectl apply -f k8s/', kind: 'build' },
          { command: 'helm upgrade app ./chart', kind: 'build' },
          { command: 'go build -o bin/api ./cmd/api', kind: 'build' },
        ]),
      })
    );
    expect(claim?.value.buildCommands).toEqual(['go build -o bin/api ./cmd/api']);
  });

  it('drops commands referencing CI-only variables', () => {
    // `$CI_COMMIT_SHA` / `${{ github.sha }}` / `$(Build.BuildId)` expand to nothing
    // outside their runner, so the command would silently do the wrong thing.
    for (const command of [
      'make release VERSION=$CI_COMMIT_SHA',
      'go build -ldflags "-X main.sha=${{ github.sha }}"',
      'dotnet publish -p:Version=$(Build.BuildId)',
    ]) {
      expect(recoverBuild(insights({ ciProviders: ci([{ command, kind: 'build' }]) }))).toBeNull();
    }
  });

  it('takes only the highest-priority family, not a concatenation of all three', () => {
    // CI, a Makefile and a README are alternative expressions of one intent. Running all
    // three in sequence inside the image is never what the maintainer meant.
    const claim = recoverBuild(
      insights({
        ciProviders: ci([{ command: 'go build ./cmd/api', kind: 'build' }]),
        taskCommands: [{ source: 'makefile', name: 'build', command: 'make build', kind: 'build' }],
        scriptSources: [
          {
            source: 'readme',
            file: 'README.md',
            commands: [{ command: 'npm run build', kind: 'build' }],
            ports: [],
          },
        ],
      })
    );
    expect(claim?.value.buildCommands).toEqual(['go build ./cmd/api']);
  });
});

describe('build and start move as a coupled pair', () => {
  // Regression: a recipe's build produces the artifact its start command runs. Replacing
  // one and keeping the other yields an image that builds and then dies at runtime —
  // e.g. CI's `go build ./...` writes no binary, yet `CMD /app/server` still expects one.
  const buildOnly = {
    installCommands: [],
    buildCommands: ['go build ./...'],
    startCommand: null,
    image: null,
    commands: [
      { command: 'go build ./...', kind: 'build', source: 'ci', origin: 'github-actions' },
    ],
    origins: ['github-actions'],
    confidence: 0.2,
    reasoning: ['ci declares the build'],
  };

  it('leaves a coherent recipe alone when only the build half was recovered', () => {
    const { recipe, origins } = applyRecoveredBuild(goRecipe, buildOnly);
    expect(recipe.buildCommands).toEqual(['go build -o /app/server ./...']);
    expect(recipe.startCommand).toBe('/app/server');
    expect(origins).toEqual([]);
  });

  it('still fills a genuine gap when the recipe has no build of its own', () => {
    const noBuild = { ...goRecipe, buildCommands: [] };
    const { recipe, origins } = applyRecoveredBuild(noBuild, buildOnly);
    expect(recipe.buildCommands).toEqual(['go build ./...']);
    expect(origins).toEqual(['github-actions']);
  });

  it('replaces both halves when both were recovered', () => {
    const both = {
      ...buildOnly,
      startCommand: './bin/api',
      commands: [
        ...buildOnly.commands,
        { command: './bin/api', kind: 'start', source: 'ci', origin: 'github-actions' },
      ],
    };
    const { recipe } = applyRecoveredBuild(goRecipe, both);
    expect(recipe.buildCommands).toEqual(['go build ./...']);
    expect(recipe.startCommand).toBe('./bin/api');
  });
});

describe('applyRecoveredBuild precedence', () => {
  const recovered = {
    installCommands: ['npm ci --omit=dev'],
    buildCommands: ['make release'],
    startCommand: './run.sh',
    image: 'golang:1.23',
    commands: [
      { command: 'make release', kind: 'build', source: 'ci', origin: 'gitlab:.gitlab-ci.yml#b' },
      { command: './run.sh', kind: 'start', source: 'ci', origin: 'gitlab:.gitlab-ci.yml#b' },
      {
        command: 'npm ci --omit=dev',
        kind: 'install',
        source: 'ci',
        origin: 'gitlab:.gitlab-ci.yml#b',
      },
    ],
    origins: ['gitlab:.gitlab-ci.yml#b'],
    confidence: 0.2,
    reasoning: ['ci declares the build'],
  };

  it('replaces build/start commands on a registry recipe', () => {
    const { recipe, origins } = applyRecoveredBuild(goRecipe, recovered);
    expect(recipe.buildCommands).toEqual(['make release']);
    expect(recipe.startCommand).toBe('./run.sh');
    expect(origins).toEqual(['gitlab:.gitlab-ci.yml#b']);
  });

  it('never replaces an install command the recipe already defines', () => {
    // A recipe's install step is tied to its base image and lockfile handling; a CI
    // runner's install assumes an environment ORCA's image may not have.
    const { recipe } = applyRecoveredBuild(goRecipe, recovered);
    expect(recipe.installCommands).toEqual(['go mod download']);
  });

  it('fills in an install command only when the recipe has none', () => {
    const { recipe } = applyRecoveredBuild({ ...goRecipe, installCommands: [] }, recovered);
    expect(recipe.installCommands).toEqual(['npm ci --omit=dev']);
  });

  it('leaves a Dockerfile-derived recipe completely alone', () => {
    // The Dockerfile IS the repo's declared build, from a tier-1 source. Tier-2 CI must
    // not overwrite it.
    const { recipe, origins } = applyRecoveredBuild(goRecipe, recovered, {
      fromDockerfile: true,
    });
    expect(recipe).toBe(goRecipe);
    expect(origins).toEqual([]);
  });

  it('fills a blank base image but never replaces a real one', () => {
    expect(applyRecoveredBuild(goRecipe, recovered).recipe.baseImages.build).toBe('golang:1.23');

    const blank = { ...goRecipe, baseImages: { build: '', runtime: '' } };
    expect(applyRecoveredBuild(blank, recovered).recipe.baseImages.build).toBe('golang:1.23');
  });

  it('is a no-op when there is nothing recovered', () => {
    const { recipe, origins } = applyRecoveredBuild(goRecipe, null);
    expect(recipe).toBe(goRecipe);
    expect(origins).toEqual([]);
  });
});

describe('a repo with no declaring source', () => {
  it('keeps the matched recipe defaults and records no provenance', async () => {
    // go-sample ships no CI, no Makefile, no README build block.
    const ctx = await planFor(fileURLToPath(new URL('../../examples/go-sample', import.meta.url)));
    const node = ctx.plan?.services.find((s) => s.kind === 'service');
    if (node?.source.type !== 'build') throw new Error('expected a build source');

    expect(node.source.recipe?.startCommand).toBe('/app/server');
    expect(node.source.commandOrigins).toBeUndefined();
  });
});
