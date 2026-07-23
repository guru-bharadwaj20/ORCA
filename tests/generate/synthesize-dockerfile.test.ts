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

  it('fills blank base images from per-runtime defaults (AI-inferred recipe shape)', () => {
    // inferBuild returns recipes with empty baseImages — synthesis must fill them so a
    // bare `FROM` never leaks into the Dockerfile.
    const inferred: BuildRecipe = {
      id: 'ai-go',
      runtime: 'go',
      dependencyFiles: [],
      installCommands: ['go mod download'],
      buildCommands: ['go build -o /app/server ./...'],
      startCommand: '/app/server',
      defaultPorts: [8080],
      baseImages: { build: '', runtime: '' },
    };
    const df = synthesizeDockerfile(inferred);
    expect(df).not.toContain('FROM  ');
    expect(df).not.toContain('FROM  AS builder');
    expect(df).toContain('FROM golang:1.23 AS builder');
    expect(df).toContain('FROM gcr.io/distroless/base-debian12');
  });

  it('falls back to a generic base image for an unknown runtime', () => {
    const inferred: BuildRecipe = {
      id: 'ai-haskell',
      runtime: 'haskell',
      dependencyFiles: [],
      installCommands: ['stack build'],
      startCommand: 'stack exec app',
      defaultPorts: [],
      baseImages: { build: '', runtime: '' },
    };
    const df = synthesizeDockerfile(inferred);
    expect(df).toContain('FROM debian:bookworm-slim');
    expect(df).not.toContain('FROM \n');
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

  it('wires an entrypoint script into an interpreted image when the recipe declares one', () => {
    const df = synthesizeDockerfile({
      id: 'py-migrate',
      runtime: 'python',
      dependencyFiles: ['requirements.txt'],
      installCommands: ['pip install -r requirements.txt'],
      startCommand: 'python app.py',
      defaultPorts: [8000],
      baseImages: { build: 'python:3.12-slim', runtime: 'python:3.12-slim' },
      entrypointScript: 'entrypoint.sh',
    });
    expect(df).toContain('COPY entrypoint.sh /usr/local/bin/entrypoint.sh');
    expect(df).toContain('RUN chmod +x /usr/local/bin/entrypoint.sh');
    expect(df).toContain('ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]');
    // CMD becomes the args the entrypoint execs.
    expect(df).toContain('CMD python app.py');
  });

  it('wires an entrypoint into the runtime stage of a compiled image', () => {
    const df = synthesizeDockerfile({
      id: 'jvm-migrate',
      runtime: 'jvm',
      dependencyFiles: ['pom.xml'],
      installCommands: ['mvn -B dependency:go-offline'],
      buildCommands: ['mvn -B package -DskipTests'],
      startCommand: 'java -jar app.jar',
      defaultPorts: [8080],
      baseImages: { build: 'maven:3.9-eclipse-temurin-21', runtime: 'eclipse-temurin:21-jre' },
      entrypointScript: 'entrypoint.sh',
    });
    // The entrypoint lands after the runtime FROM, not the builder stage.
    const runtimeIdx = df.indexOf('FROM eclipse-temurin:21-jre');
    expect(df.indexOf('ENTRYPOINT')).toBeGreaterThan(runtimeIdx);
    expect(df).toContain('ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]');
  });

  it('emits no ENTRYPOINT when the recipe declares none (unchanged default)', () => {
    const df = synthesizeDockerfile({
      id: 'plain',
      runtime: 'python',
      dependencyFiles: ['requirements.txt'],
      installCommands: ['pip install -r requirements.txt'],
      startCommand: 'python app.py',
      defaultPorts: [8000],
      baseImages: { build: 'python:3.12-slim', runtime: 'python:3.12-slim' },
    });
    expect(df).not.toContain('ENTRYPOINT');
    expect(df).toContain('CMD python app.py');
  });
});
