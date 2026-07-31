/**
 * ONE RENDER PATH — the acceptance criteria for finishing decision #1.
 *
 * Until this landed, ORCA had two Dockerfile renderers: seed stacks (React/Express/Django)
 * rendered `node.Dockerfile.hbs` / `python.Dockerfile.hbs` through `renderDockerfile`, and
 * everything else synthesized from a `BuildRecipe`. The data path was already unified —
 * recipes drove both — but two renderers emit different text from the same data, so every
 * synthesizer improvement reached only half the repos ORCA supports, and the seed goldens
 * and ecosystem goldens sat on separate footings.
 *
 * These tests pin the property, not the plumbing: whatever a seed component renders, it
 * renders through `synthesizeDockerfile`, and the AI-refinement surface still survives the
 * trip. The golden re-approval lives in `tests/templates/golden.test.ts`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { DetectedComponent } from '../../src/detect/types.js';
import { dockerfileFromVars, recipeFromVars } from '../../src/generate/dockerfileFromVars.js';
import { synthesizeDockerfile } from '../../src/generate/synthesizeDockerfile.js';
import type { BuildRecipe } from '../../src/model/recipe.js';
import { recipeForComponent } from '../../src/model/recipes/index.js';
import { dockerfileVarsFor } from '../../src/templates/registry.js';
import type { DockerfileVars } from '../../src/templates/types.js';

function component(overrides: Partial<DetectedComponent> = {}): DetectedComponent {
  return {
    role: 'backend',
    rootDir: '.',
    language: 'javascript',
    packageManager: 'npm',
    framework: 'express',
    dependencies: [],
    ports: [],
    entrypoint: null,
    ...overrides,
  };
}

const ecosystemRecipe: BuildRecipe = {
  id: 'rust-cargo',
  runtime: 'rust',
  dependencyFiles: ['Cargo.toml'],
  installCommands: ['cargo fetch'],
  buildCommands: ['cargo build --release'],
  startCommand: './target/release/{{binary}}',
  defaultPorts: [8080],
  baseImages: { build: 'rust:1-slim', runtime: 'debian:bookworm-slim' },
};

describe('there is only one Dockerfile renderer', () => {
  it('renders a seed component through the synthesizer', () => {
    const seed = component({ framework: 'react', role: 'frontend' });
    const vars = dockerfileVarsFor(seed);

    // Not "produces similar output" — literally the same function, on the recipe the
    // vars were derived from. This is the assertion the second renderer made impossible.
    expect(dockerfileFromVars(seed, vars)).toBe(
      synthesizeDockerfile(recipeFromVars(recipeForComponent(seed), vars), {
        workdir: vars.workdir,
      })
    );
  });

  it('gives a seed component the same header shape as an ecosystem one', () => {
    // The seed images used to announce themselves as "ORCA Stage 1 — Node service"; the
    // ecosystem ones named their recipe. One renderer, one convention.
    const seed = component({ framework: 'express' });

    expect(dockerfileFromVars(seed, dockerfileVarsFor(seed))).toContain(
      'ORCA synthesized image — recipe node-express (node)'
    );
    expect(synthesizeDockerfile(ecosystemRecipe)).toContain(
      'ORCA synthesized image — recipe rust-cargo (rust)'
    );
  });

  it('ships no Dockerfile templates for a second renderer to use', () => {
    // A structural guard: the .hbs Dockerfile templates are gone, so a future change
    // cannot quietly reintroduce a parallel path by re-importing them.
    const dir = fileURLToPath(new URL('../../src/templates/dockerfiles', import.meta.url));
    expect(existsSync(dir)).toBe(false);
  });
});

describe('the AI refinement surface survives the unification', () => {
  const base = recipeForComponent(component({ framework: 'express' }));

  const refined: DockerfileVars = {
    baseImage: 'node:22-slim',
    workdir: '/srv',
    packageManager: 'pnpm',
    dependencyFiles: ['package.json', 'pnpm-lock.yaml'],
    installCommand: 'pnpm install --frozen-lockfile',
    startCommand: 'node dist/server.js',
    port: 8080,
    ports: [8080, 9090],
    systemPackages: ['curl'],
  };

  it('carries every refined field into the rendered image', () => {
    const text = synthesizeDockerfile(recipeFromVars(base, refined), { workdir: refined.workdir });

    expect(text).toContain('FROM node:22-slim');
    expect(text).toContain('WORKDIR /srv');
    expect(text).toContain('COPY package.json pnpm-lock.yaml ./');
    expect(text).toContain('RUN pnpm install --frozen-lockfile');
    expect(text).toContain('CMD node dist/server.js');
    expect(text).toContain('EXPOSE 8080');
    expect(text).toContain('EXPOSE 9090');
    expect(text).toContain('curl');
  });

  it('keeps the recipe identity and env the vars cannot express', () => {
    const recipe = recipeFromVars(base, refined);

    // Vars have no field for either, so they must come off the base recipe — otherwise
    // a refined seed image silently loses `NODE_ENV` and reports the wrong recipe.
    expect(recipe.id).toBe('node-express');
    expect(recipe.env).toEqual({ NODE_ENV: 'development' });
    expect(synthesizeDockerfile(recipe)).toContain('ENV NODE_ENV=development');
  });

  it('drops an optional field the refined vars do not set', () => {
    // `delete` rather than `= undefined`: the synthesizer tests presence, and a key
    // holding undefined would emit an empty apt-get block / a bare ENTRYPOINT.
    const django = recipeForComponent(component({ language: 'python', framework: 'django' }));
    expect(django.entrypointScript).toBe('entrypoint.sh');

    const stripped = recipeFromVars(django, refined);
    expect('entrypointScript' in stripped).toBe(false);
    expect(synthesizeDockerfile(stripped)).not.toContain('ENTRYPOINT');
  });

  it('falls back to the primary port when vars carry no port list', () => {
    const { ports: _ports, ...noList } = refined;
    expect(recipeFromVars(base, noList).defaultPorts).toEqual([8080]);
  });
});
