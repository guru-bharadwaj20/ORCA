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

import type { BuildRecipe } from '../model/recipe.js';

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
 * Synthesize a multi-stage Dockerfile from a recipe. When the recipe has no build
 * commands (interpreted runtimes), a single-stage image is emitted instead — a builder
 * stage would add no value. `EXPOSE` uses the recipe's first default port when present.
 */
export function synthesizeDockerfile(recipe: BuildRecipe, options: SynthesisOptions = {}): string {
  const workdir = options.workdir ?? '/app';
  const start = resolveStart(recipe.startCommand, options.artifactName);
  const exposeLine =
    recipe.defaultPorts[0] !== undefined ? `EXPOSE ${recipe.defaultPorts[0]}\n` : '';
  const depFiles = recipe.dependencyFiles.length > 0 ? recipe.dependencyFiles.join(' ') : '.';
  const hasBuild = (recipe.buildCommands?.length ?? 0) > 0;

  const header = `# syntax=docker/dockerfile:1\n# ORCA synthesized image — recipe ${recipe.id} (${recipe.runtime}).`;

  // Interpreted runtime (no build step): a single stage is simpler and smaller.
  if (!hasBuild) {
    return [
      header,
      `FROM ${recipe.baseImages.runtime || recipe.baseImages.build}`,
      `WORKDIR ${workdir}`,
      '',
      systemPackagesBlock(recipe),
      `COPY ${depFiles} ./`,
      runLines(recipe.installCommands),
      '',
      'COPY . .',
      '',
      exposeLine + `CMD ${start}`,
      '',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  // Compiled/bundled runtime: builder stage produces the artifact, runtime stage runs it.
  return [
    header,
    `FROM ${recipe.baseImages.build} AS builder`,
    `WORKDIR ${workdir}`,
    '',
    systemPackagesBlock(recipe),
    `COPY ${depFiles} ./`,
    runLines(recipe.installCommands),
    '',
    'COPY . .',
    runLines(recipe.buildCommands ?? []),
    '',
    `FROM ${recipe.baseImages.runtime}`,
    `WORKDIR ${workdir}`,
    `COPY --from=builder ${workdir} ${workdir}`,
    '',
    exposeLine + `CMD ${start}`,
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
