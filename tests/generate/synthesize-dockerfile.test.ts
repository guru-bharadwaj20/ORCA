/**
 * PHASE E tests — the generic multi-stage Dockerfile synthesizer. Pure BuildRecipe →
 * string, so assertions are on the emitted Dockerfile text. Covers compiled (multi-
 * stage) vs interpreted (single-stage), placeholder substitution, system packages,
 * and EXPOSE.
 */
import { describe, expect, it } from 'vitest';

import { defaultRecipeRegistry } from '../../src/model/recipes/index.js';
import type { BuildRecipe, MatchFacts } from '../../src/model/recipe.js';
import { synthesizeDockerfile } from '../../src/generate/synthesizeDockerfile.js';

const registry = defaultRecipeRegistry();
const recipeFor = (facts: MatchFacts): BuildRecipe => {
  const r = registry.match(facts);
  if (!r) throw new Error('no recipe matched');
  return r;
};

describe('synthesizeDockerfile', () => {
  it('emits a multi-stage build for a compiled runtime (Rust)', () => {
    const df = synthesizeDockerfile(
      recipeFor({ runtime: 'rust', dependencies: [], files: ['Cargo.toml'] }),
      { artifactName: 'myapp' }
    );
    expect(df).toContain('AS builder');
    expect(df).toContain('cargo build --release');
    expect(df).toContain('COPY --from=builder');
    // The {{binary}} placeholder is resolved from artifactName.
    expect(df).toContain('CMD ./target/release/myapp');
    expect(df).not.toContain('{{binary}}');
  });

  it('emits a single stage for an interpreted runtime (no build commands)', () => {
    const recipe: BuildRecipe = {
      id: 'python-flask',
      runtime: 'python',
      packageManager: 'pip',
      dependencyFiles: ['requirements.txt'],
      installCommands: ['pip install -r requirements.txt'],
      startCommand: 'python app.py',
      defaultPorts: [5000],
      baseImages: { build: 'python:3.12-slim', runtime: 'python:3.12-slim' },
    };
    const df = synthesizeDockerfile(recipe);
    expect(df).not.toContain('AS builder');
    expect(df).not.toContain('COPY --from=builder');
    expect(df).toContain('pip install -r requirements.txt');
    expect(df).toContain('EXPOSE 5000');
    expect(df).toContain('CMD python app.py');
  });

  it('includes an apt-get block when the recipe declares system packages', () => {
    const df = synthesizeDockerfile({
      id: 'x',
      runtime: 'python',
      dependencyFiles: ['requirements.txt'],
      installCommands: ['pip install -r requirements.txt'],
      startCommand: 'python app.py',
      defaultPorts: [8000],
      baseImages: { build: 'python:3.12-slim', runtime: 'python:3.12-slim' },
      systemPackages: ['libpq-dev', 'gcc'],
    });
    expect(df).toContain('apt-get install -y --no-install-recommends libpq-dev gcc');
  });

  it('resolves the Maven jar placeholder and keeps the multi-stage shape', () => {
    const df = synthesizeDockerfile(
      recipeFor({ runtime: 'jvm', dependencies: [], files: ['pom.xml'] }),
      { artifactName: 'app.jar' }
    );
    expect(df).toContain('mvn -B package -DskipTests');
    expect(df).toContain('java -jar target/app.jar');
  });

  it('omits EXPOSE when the recipe declares no ports', () => {
    const df = synthesizeDockerfile({
      id: 'cli',
      runtime: 'go',
      dependencyFiles: ['go.mod'],
      installCommands: ['go mod download'],
      buildCommands: ['go build -o /app/tool ./...'],
      startCommand: '/app/tool',
      defaultPorts: [],
      baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
    });
    expect(df).not.toContain('EXPOSE');
    expect(df).toContain('AS builder');
  });
});
