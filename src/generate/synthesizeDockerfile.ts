/**
 * Generic multi-stage Dockerfile synthesizer (Phase E): turns a `BuildRecipe` — from
 * the registry (Go/Rust/JVM/.NET/…) or from AI inference — into an actual Dockerfile.
 * This is what makes an ecosystem/inferred recipe *buildable*, not merely *classified*:
 * the seed stacks keep their handwritten Handlebars templates; everything else flows
 * through here.
 *
 * Pure function `BuildRecipe → string`, no I/O, no AI — trivially testable and
 * deterministic. Emits a builder stage (deps + build) and a slim runtime stage that
 * copies the workspace, per decision #1's "prefer multi-stage builds".
 *
 * STAGE: 5 (generate) / PHASE E — REAL code.
 */

import type { BuildRecipe, Runtime } from '../model/recipe.js';

/**
 * Per-runtime fallback base images for a recipe that leaves `baseImages` blank — the
 * shape `inferBuild` returns, since AI inference proposes commands, not images. Keeps
 * inferred recipes buildable without asking the model to name (and get wrong) tags.
 * Deterministic recipes always ship their own images and never reach these.
 */
const DEFAULT_BASE_IMAGES: Record<string, { build: string; runtime: string }> = {
  node: { build: 'node:20', runtime: 'node:20-slim' },
  python: { build: 'python:3.12', runtime: 'python:3.12-slim' },
  go: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
  rust: { build: 'rust:1', runtime: 'debian:bookworm-slim' },
  jvm: { build: 'eclipse-temurin:21-jdk', runtime: 'eclipse-temurin:21-jre' },
  dotnet: {
    build: 'mcr.microsoft.com/dotnet/sdk:8.0',
    runtime: 'mcr.microsoft.com/dotnet/aspnet:8.0',
  },
  php: { build: 'php:8.3-cli', runtime: 'php:8.3-cli' },
  ruby: { build: 'ruby:3.3', runtime: 'ruby:3.3-slim' },
};

/** A generic last resort when the runtime is unknown to the fallback table. */
const GENERIC_BASE = { build: 'debian:bookworm', runtime: 'debian:bookworm-slim' };

/**
 * Resolve the build/runtime base images for a recipe, filling blanks (inferred recipes)
 * from the per-runtime defaults so synthesis never emits a bare `FROM`.
 *
 * `recipe.runtime` can originate from AI inference (`InferredBuild.runtime`), so it is
 * not guaranteed to be a member of `Runtime` at this point. `Object.hasOwn` (rather than
 * a plain `DEFAULT_BASE_IMAGES[recipe.runtime]` lookup) is required here: a value like
 * `"__proto__"` or `"toString"` would otherwise resolve to a truthy `Object.prototype`
 * member instead of `undefined`, silently skipping the `?? GENERIC_BASE` fallback and
 * producing a broken `FROM undefined` (or worse) in the emitted Dockerfile.
 */
function resolveBaseImages(recipe: BuildRecipe): { build: string; runtime: string } {
  // `Object.hasOwn` guards the prototype-pollution case above but does NOT narrow the
  // index access for the compiler (`noUncheckedIndexedAccess` still types it as possibly
  // undefined), so the `??` both satisfies the type and keeps GENERIC_BASE as the single
  // fallback for either way the lookup can fail to produce an entry.
  const fallback =
    (Object.hasOwn(DEFAULT_BASE_IMAGES, recipe.runtime)
      ? DEFAULT_BASE_IMAGES[recipe.runtime as Runtime]
      : undefined) ?? GENERIC_BASE;
  return {
    build: recipe.baseImages.build || fallback.build,
    runtime: recipe.baseImages.runtime || fallback.runtime,
  };
}

/** Options controlling synthesis; sane defaults keep the common call a one-liner. */
export interface SynthesisOptions {
  /** Working directory inside both stages. */
  workdir?: string;
  /**
   * Concrete value for a `{{binary}}` / `{{jar}}` / `{{dll}}` placeholder in the
   * recipe's `startCommand` (e.g. the crate name). Left as-is when not provided.
   */
  artifactName?: string;
}

/** Format a shell command list as one `RUN` per command (readable, layer-friendly). */
function runLines(commands: readonly string[]): string {
  return commands.map((c) => `RUN ${c}`).join('\n');
}

/**
 * Collapse any line break to a space. `recipe.id`/`recipe.runtime` can trace back to AI
 * inference over repo-controlled text (README/manifest excerpts), and `recipe.env` can
 * come from a recipe assembled at runtime from AI-refined vars — a value carrying a
 * newline would break out of its own single-line instruction and inject a real Dockerfile
 * directive after it. Every instruction that splices a recipe string into one line runs
 * through here.
 */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * One `ENV key=value` per entry, or `[]` when the recipe declares none. Emitted in EVERY
 * stage: a builder that lacks `NODE_ENV=development` installs a different dependency set
 * than the runtime stage expects, which is exactly the class of bug an image-level env is
 * there to prevent.
 */
function envLines(recipe: BuildRecipe): string[] {
  const entries = Object.entries(recipe.env ?? {});
  return entries.map(([key, value]) => `ENV ${singleLine(key)}=${singleLine(value)}`);
}

/** apt-get install block for a recipe's system packages, or '' when none. */
function systemPackagesBlock(recipe: BuildRecipe): string {
  if (!recipe.systemPackages || recipe.systemPackages.length === 0) return '';
  return [
    'RUN apt-get update \\',
    `    && apt-get install -y --no-install-recommends ${recipe.systemPackages.join(' ')} \\`,
    '    && rm -rf /var/lib/apt/lists/*',
    '',
  ].join('\n');
}

/** Substitute the artifact placeholder in a start command when provided. */
function resolveStart(startCommand: string, artifactName?: string): string {
  if (!artifactName) return startCommand;
  return startCommand.replace(/\{\{\s*(binary|jar|dll)\s*\}\}/g, artifactName);
}

/**
 * When a recipe declares an `entrypointScript` (e.g. a migrate-then-run wrapper), the
 * runtime stage copies it, makes it executable, and runs it as the `ENTRYPOINT`; the
 * start command becomes the `CMD` the script `exec "$@"`s. Returns the extra lines to
 * splice in before the final `CMD`, or `[]` when there's no entrypoint. Mirrors how the
 * Django seed template wires its `entrypoint.sh`, but for any synthesized recipe.
 */
function entrypointBlock(recipe: BuildRecipe): string[] {
  const script = recipe.entrypointScript;
  if (script === undefined || script === '') return [];
  return [`COPY ${script} /usr/local/bin/${script}`, `RUN chmod +x /usr/local/bin/${script}`, ''];
}

/** The final `ENTRYPOINT`/`CMD` pair for a recipe: an ENTRYPOINT wrapper when it has one. */
function launchLines(recipe: BuildRecipe, exposeLine: string, start: string): string {
  if (recipe.entrypointScript !== undefined && recipe.entrypointScript !== '') {
    return `${exposeLine}ENTRYPOINT ["/usr/local/bin/${recipe.entrypointScript}"]\nCMD ${start}`;
  }
  return `${exposeLine}CMD ${start}`;
}

/**
 * Synthesize a multi-stage Dockerfile from a recipe. When the recipe has no build
 * commands (interpreted runtimes), a single-stage image is emitted instead — a builder
 * stage would add no value. Emits one `EXPOSE` per port in the recipe's `defaultPorts`.
 */
export function synthesizeDockerfile(recipe: BuildRecipe, options: SynthesisOptions = {}): string {
  const workdir = options.workdir ?? '/app';
  const start = resolveStart(recipe.startCommand, options.artifactName);
  const exposeLine =
    recipe.defaultPorts.length > 0
      ? `${recipe.defaultPorts.map((p) => `EXPOSE ${p}`).join('\n')}\n`
      : '';
  const depFiles = recipe.dependencyFiles.length > 0 ? recipe.dependencyFiles.join(' ') : '.';
  const hasBuild = (recipe.buildCommands?.length ?? 0) > 0;
  const baseImages = resolveBaseImages(recipe);

  const header = `# syntax=docker/dockerfile:1\n# ORCA synthesized image — recipe ${singleLine(recipe.id)} (${singleLine(recipe.runtime)}).`;
  const env = envLines(recipe);

  // Interpreted runtime (no build step): a single stage is simpler and smaller.
  if (!hasBuild) {
    return [
      header,
      `FROM ${baseImages.runtime}`,
      ...env,
      `WORKDIR ${workdir}`,
      '',
      systemPackagesBlock(recipe),
      `COPY ${depFiles} ./`,
      runLines(recipe.installCommands),
      '',
      'COPY . .',
      '',
      ...entrypointBlock(recipe),
      launchLines(recipe, exposeLine, start),
      '',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  // Compiled/bundled runtime: builder stage produces the artifact, runtime stage runs it.
  return [
    header,
    `FROM ${baseImages.build} AS builder`,
    ...env,
    `WORKDIR ${workdir}`,
    '',
    systemPackagesBlock(recipe),
    `COPY ${depFiles} ./`,
    runLines(recipe.installCommands),
    '',
    'COPY . .',
    runLines(recipe.buildCommands ?? []),
    '',
    `FROM ${baseImages.runtime}`,
    ...env,
    `WORKDIR ${workdir}`,
    `COPY --from=builder ${workdir} ${workdir}`,
    '',
    ...entrypointBlock(recipe),
    launchLines(recipe, exposeLine, start),
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
