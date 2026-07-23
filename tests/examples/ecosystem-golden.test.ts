/**
 * Golden tests for the ecosystem example repos under `examples/`. Unlike the seed
 * stacks (which render Handlebars templates — see tests/templates/golden.test.ts), the
 * Go/Rust/JVM/.NET examples are containerized by the generic SYNTHESIZER. Each case
 * resolves the recipe the example's manifest would match, synthesizes its Dockerfile,
 * and asserts it byte-for-byte against the committed `.orca-golden/Dockerfile` — so a
 * change to the synthesizer or a recipe that would alter a shipped example's image is
 * caught here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

  it('dotnet-sample synthesizes its committed Dockerfile', () => {
    const rendered = synthesizeFor(
      { runtime: 'dotnet', dependencies: [], files: ['global.json'] },
      { artifactName: 'orca-dotnet-sample.dll' }
    );
    expect(normalize(rendered)).toBe(normalize(goldenDockerfile('dotnet-sample')));
  });
});
