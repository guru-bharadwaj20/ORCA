/**
 * Golden tests for the Node/Python framework recipes, following the Go/Rust pattern:
 * a fixture repo tree in, a synthesized Dockerfile out, compared byte-for-byte against
 * a checked-in golden under `tests/fixtures/<repo>/.orca-golden/Dockerfile`.
 *
 * The facts handed to the registry come from the real manifest readers and a real
 * directory listing, so these cover the whole fixture → MatchFacts → recipe →
 * Dockerfile path, not just the synthesizer in isolation. A golden diff means either
 * the recipe data or the synthesizer changed — both are worth a deliberate review.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readAllDependencies } from '../../src/detect/manifest.js';
import { synthesizeDockerfile } from '../../src/generate/synthesizeDockerfile.js';
import type { MatchFacts, Runtime } from '../../src/model/recipe.js';
import { defaultRecipeRegistry } from '../../src/model/recipes/index.js';

const registry = defaultRecipeRegistry();

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** Same normalization the seed golden tests use: line endings, trailing space, EOF. */
function normalize(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '') + '\n'
  );
}

/** Build `MatchFacts` for a fixture from its manifests and its actual file listing. */
async function factsFor(dir: string, runtime: Runtime): Promise<MatchFacts> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  return { runtime, dependencies: await readAllDependencies(dir), files };
}

interface GoldenCase {
  /** Fixture directory under tests/fixtures. */
  repo: string;
  runtime: Runtime;
  /** The recipe the fixture must resolve to. */
  recipeId: string;
}

const CASES: readonly GoldenCase[] = [
  { repo: 'nextjs-repo', runtime: 'node', recipeId: 'node-next' },
  { repo: 'nestjs-repo', runtime: 'node', recipeId: 'node-nest' },
  { repo: 'angular-repo', runtime: 'node', recipeId: 'node-angular' },
  { repo: 'vite-vue-repo', runtime: 'node', recipeId: 'node-vite' },
  { repo: 'fastapi-repo', runtime: 'python', recipeId: 'python-fastapi' },
  { repo: 'flask-repo', runtime: 'python', recipeId: 'python-flask' },
  { repo: 'fastapi-poetry-repo', runtime: 'python', recipeId: 'python-fastapi-poetry' },
  { repo: 'flask-uv-repo', runtime: 'python', recipeId: 'python-flask-uv' },
];

describe('framework recipe goldens', () => {
  for (const { repo, runtime, recipeId } of CASES) {
    it(`${repo} resolves to ${recipeId} and matches its golden Dockerfile`, async () => {
      const dir = fixture(repo);
      const recipe = registry.match(await factsFor(dir, runtime));

      expect(recipe?.id).toBe(recipeId);

      const rendered = synthesizeDockerfile(recipe!);
      const golden = await readFile(join(dir, '.orca-golden', 'Dockerfile'), 'utf8');
      expect(normalize(rendered)).toBe(normalize(golden));
    });
  }
});

describe('synthesized shape per runtime', () => {
  it('gives compiled/bundled Node frameworks a multi-stage image', async () => {
    for (const repo of ['nextjs-repo', 'nestjs-repo', 'vite-vue-repo']) {
      const recipe = registry.match(await factsFor(fixture(repo), 'node'));
      const df = synthesizeDockerfile(recipe!);
      expect(df, repo).toContain('AS builder');
      expect(df, repo).toContain('COPY --from=builder');
    }
  });

  it('keeps interpreted Python services single-stage', async () => {
    for (const repo of ['fastapi-repo', 'flask-repo', 'flask-uv-repo']) {
      const recipe = registry.match(await factsFor(fixture(repo), 'python'));
      const df = synthesizeDockerfile(recipe!);
      expect(df, repo).not.toContain('AS builder');
      expect(df, repo).not.toContain('COPY --from=builder');
    }
  });

  it('copies only the lockfile pair before installing, for layer caching', async () => {
    const recipe = registry.match(await factsFor(fixture('flask-uv-repo'), 'python'));
    const df = synthesizeDockerfile(recipe!);
    // Dependency files land before `COPY . .` so a source edit does not bust the
    // install layer.
    expect(df.indexOf('COPY pyproject.toml uv.lock ./')).toBeLessThan(df.indexOf('COPY . .'));
  });
});
