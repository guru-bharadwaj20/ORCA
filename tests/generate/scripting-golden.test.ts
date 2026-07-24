/**
 * End-to-end golden tests for the PHP/Ruby ecosystems, mirroring the Rust `detect.test`
 * path: run the REAL `detectStack` over a fixture repo, assert the ecosystem component
 * surfaced (runtime + matched recipe id), then synthesize that recipe's Dockerfile and
 * compare byte-for-byte against the checked-in golden. This proves the whole chain —
 * new detector → manifest reader → recipe match → synthesizer — not just a unit of it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { synthesizeDockerfile } from '../../src/generate/synthesizeDockerfile.js';
import type { Runtime } from '../../src/model/recipe.js';
import { ALL_RECIPES } from '../../src/model/recipes/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** Same normalization the other golden tests use. */
function normalize(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '') + '\n'
  );
}

interface Case {
  repo: string;
  runtime: Runtime;
  recipeId: string;
}

const CASES: readonly Case[] = [
  { repo: 'php-laravel-repo', runtime: 'php', recipeId: 'php-laravel' },
  { repo: 'php-plain-repo', runtime: 'php', recipeId: 'php-composer' },
  { repo: 'rails-repo', runtime: 'ruby', recipeId: 'ruby-rails' },
  { repo: 'sinatra-repo', runtime: 'ruby', recipeId: 'ruby-sinatra' },
  { repo: 'rack-repo', runtime: 'ruby', recipeId: 'ruby-bundler' },
];

describe('PHP/Ruby detect + synthesize goldens', () => {
  for (const { repo, runtime, recipeId } of CASES) {
    it(`${repo}: detected as ${runtime} → ${recipeId}, Dockerfile matches golden`, async () => {
      const detection = await detectStack(fixture(repo));

      // A scripting repo has no seed frontend/backend, but IS supported via its
      // ecosystem recipe — exactly like the Rust fixture.
      expect(detection.isSupported).toBe(true);
      expect(detection.frontend).toBeNull();
      expect(detection.backend).toBeNull();
      expect(detection.insights.ecosystemComponents).toContainEqual({
        rootDir: '.',
        runtime,
        recipeId,
        role: 'backend',
      });

      const recipe = ALL_RECIPES.find((e) => e.recipe.id === recipeId)?.recipe;
      expect(recipe).toBeDefined();

      const rendered = synthesizeDockerfile(recipe!);
      const golden = await readFile(join(fixture(repo), '.orca-golden', 'Dockerfile'), 'utf8');
      expect(normalize(rendered)).toBe(normalize(golden));
    });
  }
});

describe('PHP/Ruby detection signals', () => {
  it('surfaces the language and a framework insight for a Laravel repo', async () => {
    const detection = await detectStack(fixture('php-laravel-repo'));
    expect(detection.languages).toContain('php');
    expect(detection.insights.runtimes).toContain('php');
    expect(detection.insights.frameworks).toContain('laravel');
  });

  it('surfaces the language and a framework insight for a Rails repo', async () => {
    const detection = await detectStack(fixture('rails-repo'));
    expect(detection.languages).toContain('ruby');
    expect(detection.insights.runtimes).toContain('ruby');
    expect(detection.insights.frameworks).toContain('rails');
  });
});
