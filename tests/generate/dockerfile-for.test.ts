/**
 * PHASE E tests — the `dockerfileFor` decision seam. A template-sourced component must
 * produce byte-identical output to the direct template render (behavior preservation);
 * a recipe-sourced component must route to the synthesizer.
 */
import { describe, expect, it } from 'vitest';

import { dockerfileFor } from '../../src/generate/dockerfileFor.js';
import type { BuildRecipe } from '../../src/model/recipe.js';
import { renderDockerfile } from '../../src/templates/render.js';
import { synthesizeDockerfile } from '../../src/generate/synthesizeDockerfile.js';
import type { DockerfileVars } from '../../src/templates/types.js';

const vars: DockerfileVars = {
  baseImage: 'node:20-slim',
  workdir: '/app',
  packageManager: 'npm',
  dependencyFiles: ['package.json'],
  installCommand: 'npm install',
  startCommand: 'npm run dev',
  port: 3000,
};

const recipe: BuildRecipe = {
  id: 'rust-cargo',
  runtime: 'rust',
  dependencyFiles: ['Cargo.toml'],
  installCommands: ['cargo fetch'],
  buildCommands: ['cargo build --release'],
  startCommand: './target/release/{{binary}}',
  defaultPorts: [8080],
  baseImages: { build: 'rust:1-slim', runtime: 'debian:bookworm-slim' },
};

describe('dockerfileFor', () => {
  it('template source is byte-identical to a direct template render', () => {
    expect(dockerfileFor({ kind: 'template', vars })).toBe(renderDockerfile(vars));
  });

  it('recipe source routes to the synthesizer', () => {
    expect(dockerfileFor({ kind: 'recipe', recipe })).toBe(synthesizeDockerfile(recipe, {}));
  });

  it('passes synthesis options through', () => {
    const withArtifact = dockerfileFor({
      kind: 'recipe',
      recipe,
      options: { artifactName: 'server' },
    });
    expect(withArtifact).toContain('CMD ./target/release/server');
  });
});
