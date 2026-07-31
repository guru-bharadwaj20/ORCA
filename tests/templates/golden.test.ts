import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { recipeFromVars } from '../../src/generate/dockerfileFromVars.js';
import { synthesizeDockerfile } from '../../src/generate/synthesizeDockerfile.js';
import { SEED_RECIPES } from '../../src/model/recipe.js';
import { renderCompose } from '../../src/templates/render.js';
import type { DockerfileVars } from '../../src/templates/types.js';
import {
  djangoComposeVars,
  djangoDockerfileVars,
  mernClientDockerfileVars,
  mernComposeVars,
  mernServerDockerfileVars,
} from './sampleVars.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function normalize(text: string): string {
  return (
    text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '') + '\n'
  );
}

function readGolden(...segments: string[]): string {
  return readFileSync(join(repoRoot, 'examples', ...segments), 'utf8');
}

/** The seed recipe a given sample's vars were derived from. */
function seedRecipe(id: string): (typeof SEED_RECIPES)[number]['recipe'] {
  const entry = SEED_RECIPES.find((e) => e.recipe.id === id);
  if (entry === undefined) throw new Error(`no seed recipe ${id}`);
  return entry.recipe;
}

/**
 * Render a seed component's Dockerfile the way ORCA now does: fold the vars back onto the
 * recipe they came from and synthesize. There is no separate template render to compare
 * against any more — that WAS the second renderer.
 */
function renderSeed(id: string, vars: DockerfileVars): string {
  return synthesizeDockerfile(recipeFromVars(seedRecipe(id), vars), { workdir: vars.workdir });
}

/**
 * THESE GOLDENS WERE DELIBERATELY RE-APPROVED when the seed stacks moved onto the single
 * synthesizer (they had been template output before). The diff was reviewed instruction by
 * instruction; nothing about what the image DOES changed:
 *
 *   - the header comment now names the recipe that produced the image, matching every
 *     other golden in the repo, instead of the fixed "ORCA Stage 1 — …" banner;
 *   - blank separator lines are gone (the synthesizer emits none);
 *   - Django's two Python env vars are two `ENV` instructions instead of one continued
 *     one — same variables, same values;
 *   - Django's entrypoint installs as `/usr/local/bin/entrypoint.sh` rather than
 *     `/usr/local/bin/orca-entrypoint`, and its `EXPOSE` now precedes the `ENTRYPOINT`
 *     (EXPOSE is metadata; nothing referenced the old path — it was checked).
 *
 * Every instruction is otherwise identical, in the same order, with the same arguments.
 * Regenerating these is a deliberate act: read the diff before accepting it.
 */
describe('golden Dockerfiles render losslessly', () => {
  it('MERN client Dockerfile matches its golden file', () => {
    const rendered = renderSeed('node-react', mernClientDockerfileVars);
    const golden = readGolden('mern-sample', '.orca-golden', 'client.Dockerfile');
    expect(normalize(rendered)).toBe(normalize(golden));
  });

  it('MERN server Dockerfile matches its golden file', () => {
    const rendered = renderSeed('node-express', mernServerDockerfileVars);
    const golden = readGolden('mern-sample', '.orca-golden', 'server.Dockerfile');
    expect(normalize(rendered)).toBe(normalize(golden));
  });

  it('Django Dockerfile matches its golden file', () => {
    const rendered = renderSeed('python-django', djangoDockerfileVars);
    const golden = readGolden('django-postgres-sample', '.orca-golden', 'Dockerfile');
    expect(normalize(rendered)).toBe(normalize(golden));
  });

  it('the shipped samples match their goldens byte for byte', () => {
    // The examples are what a user actually reads, so a re-approval that updated only
    // `.orca-golden/` would leave the repo shipping stale output beside a passing test.
    for (const [sample, golden, shipped] of [
      ['mern-sample', ['.orca-golden', 'client.Dockerfile'], ['client', 'Dockerfile']],
      ['mern-sample', ['.orca-golden', 'server.Dockerfile'], ['server', 'Dockerfile']],
      ['django-postgres-sample', ['.orca-golden', 'Dockerfile'], ['Dockerfile']],
    ] as const) {
      expect(normalize(readGolden(sample, ...golden))).toBe(
        normalize(readGolden(sample, ...shipped))
      );
    }
  });
});

describe('golden docker-compose files render losslessly', () => {
  it('MERN docker-compose.yml matches its golden file', () => {
    const rendered = renderCompose(mernComposeVars);
    const golden = readGolden('mern-sample', '.orca-golden', 'docker-compose.yml');
    expect(normalize(rendered)).toBe(normalize(golden));
  });

  it('Django docker-compose.yml matches its golden file', () => {
    const rendered = renderCompose(djangoComposeVars);
    const golden = readGolden('django-postgres-sample', '.orca-golden', 'docker-compose.yml');
    expect(normalize(rendered)).toBe(normalize(golden));
  });
});
