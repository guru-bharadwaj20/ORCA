/**
 * Golden tests for the ecosystem example repos under `examples/`. These and the seed
 * stacks (tests/templates/golden.test.ts) now go through the SAME synthesizer; this file
 * covers the recipes that come straight from the registry, while the seed file covers the
 * ones reached through the vars overlay. Each case
 * resolves the recipe the example's manifest would match, synthesizes its Dockerfile,
 * and asserts it byte-for-byte against the committed `.orca-golden/Dockerfile` — so a
 * change to the synthesizer or a recipe that would alter a shipped example's image is
 * caught here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { synthesizeDockerfile, type SynthesisOptions } from '../../src/generate/synthesizeDockerfile.js';
import { defaultRecipeRegistry } from '../../src/model/recipes/index.js';
import type { MatchFacts } from '../../src/model/recipe.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const registry = defaultRecipeRegistry();

function normalize(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '') + '\n'
  );
}

function goldenDockerfile(sample: string): string {
  return readFileSync(join(repoRoot, 'examples', sample, '.orca-golden', 'Dockerfile'), 'utf8');
}

/** Synthesize the Dockerfile a given example would get, via its matched recipe. */
function synthesizeFor(facts: MatchFacts, options?: SynthesisOptions): string {
  const recipe = registry.match(facts);
  expect(recipe, 'a recipe must match the example manifest').not.toBeNull();
  return synthesizeDockerfile(recipe!, options);
}

describe('ecosystem example goldens', () => {
  it('go-sample synthesizes its committed Dockerfile', () => {
    const rendered = synthesizeFor({ runtime: 'go', dependencies: [], files: ['go.mod'] });
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('go-sample')));
  });

  it('rust-sample synthesizes its committed Dockerfile', () => {
    const rendered = synthesizeFor(
      { runtime: 'rust', dependencies: [], files: ['Cargo.toml'] },
      { artifactName: 'orca-rust-sample' }
    );
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('rust-sample')));
  });

  it('jvm-maven-sample synthesizes its committed Dockerfile', () => {
    const rendered = synthesizeFor(
      { runtime: 'jvm', dependencies: [], files: ['pom.xml'] },
      { artifactName: 'orca-jvm-sample.jar' }
    );
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('jvm-maven-sample')));
  });

  it('jvm-gradle-sample synthesizes its committed Dockerfile', () => {
    const rendered = synthesizeFor(
      { runtime: 'jvm', dependencies: [], files: ['build.gradle', 'settings.gradle'] },
      { artifactName: 'orca-gradle-sample.jar' }
    );
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('jvm-gradle-sample')));
  });

  it('dotnet-sample synthesizes its committed Dockerfile', () => {
    // Matched by the project-file extension — the universal .NET signal.
    const rendered = synthesizeFor(
      { runtime: 'dotnet', dependencies: [], files: ['orca-dotnet-sample.csproj'] },
      { artifactName: 'orca-dotnet-sample.dll' }
    );
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('dotnet-sample')));
  });

  it('php-sample synthesizes its committed Dockerfile', () => {
    const rendered = synthesizeFor({ runtime: 'php', dependencies: [], files: ['composer.json'] });
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('php-sample')));
  });

  it('ruby-sample synthesizes its committed Dockerfile', () => {
    const rendered = synthesizeFor({
      runtime: 'ruby',
      dependencies: ['sinatra'],
      files: ['Gemfile'],
    });
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('ruby-sample')));
  });
});

/**
 * The golden cases above test synthesis in isolation. These run the FULL detect stage on
 * the real sample directories, so a candidate-root or matcher regression that leaves a
 * sample undetectable (as `.csproj`-only .NET repos once were) is caught — not just a
 * change to the emitted Dockerfile.
 */
describe('ecosystem examples detect end-to-end', () => {
  const cases: ReadonlyArray<readonly [sample: string, runtime: string, recipeId: string]> = [
    ['go-sample', 'go', 'go-mod'],
    ['rust-sample', 'rust', 'rust-cargo'],
    ['jvm-maven-sample', 'jvm', 'jvm-maven'],
    ['jvm-gradle-sample', 'jvm', 'jvm-gradle'],
    ['dotnet-sample', 'dotnet', 'dotnet-sdk'],
    ['php-sample', 'php', 'php-composer'],
    ['ruby-sample', 'ruby', 'ruby-sinatra'],
  ];

  for (const [sample, runtime, recipeId] of cases) {
    it(`${sample} is detected as ${recipeId}`, async () => {
      const result = await detectStack(join(repoRoot, 'examples', sample));
      expect(result.isSupported).toBe(true);
      expect(result.insights.ecosystemComponents).toContainEqual({
        rootDir: '.',
        runtime,
        recipeId,
        role: 'backend',
      });
    });
  }
});
