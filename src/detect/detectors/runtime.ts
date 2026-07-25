/**
 * Tier-1 (manifest) runtime detectors on the evidence model. Each is a standalone
 * `Detector` that inspects one ecosystem's manifest files and, when present, emits a
 * `Claim<Runtime>` with the signals that justify it. Registration order in the
 * registry is priority order; a repo can legitimately trigger several (a polyglot
 * monorepo), and the aggregator ranks by confidence.
 *
 * PHASE: B (widen deterministic detection) — REAL code. Adds Go, Rust, JVM (Maven/
 * Gradle), and .NET runtime detection with zero changes to control flow — the whole
 * point of the Phase A model.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { claim, type Claim, type Evidence } from '../../model/claim.js';
import type { Detector, RepoContext } from '../../model/detector.js';
import type { Runtime } from '../../model/recipe.js';
import { readFileIfExists } from '../../utils/fs.js';
import { runtimeFact, type RuntimeFact } from './facts.js';

/** True when any of the named files exists at `dir`. */
async function anyFilePresent(dir: string, files: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const f of files) {
    if ((await readFileIfExists(join(dir, f))) !== null) found.push(f);
  }
  return found;
}

/** Names of files at `dir` whose name ends with one of `suffixes` (e.g. `.csproj`). */
async function filesWithSuffix(dir: string, suffixes: readonly string[]): Promise<string[]> {
  if (suffixes.length === 0) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && suffixes.some((s) => e.name.endsWith(s)))
    .map((e) => e.name);
}

/**
 * Build a manifest-file runtime detector: it claims `runtime` when any of `files` is
 * present (exact name) or any file matches one of `suffixes` (extension, for manifests
 * with arbitrary names like `<Project>.csproj`), weighting each observed file at
 * `weight`. A dedicated builder keeps every ecosystem a one-liner of data.
 */
function manifestRuntimeDetector(opts: {
  id: string;
  runtime: Runtime;
  files?: readonly string[];
  suffixes?: readonly string[];
  weight: number;
}): Detector<RuntimeFact> {
  return {
    id: opts.id,
    tier: 1,
    async detect(ctx: RepoContext): Promise<Claim<RuntimeFact>[]> {
      const dir = ctx.scopeDir === '.' ? ctx.repoPath : join(ctx.repoPath, ctx.scopeDir);
      const found = [
        ...(await anyFilePresent(dir, opts.files ?? [])),
        ...(await filesWithSuffix(dir, opts.suffixes ?? [])),
      ];
      if (found.length === 0) return [];
      // One family for the whole ecosystem manifest set: a lockfile is GENERATED FROM its
      // manifest, so `Cargo.toml` + `Cargo.lock` is one fact observed twice, not two
      // independent corroborations. Folding them as independent would push a single
      // ordinary Rust repo to 0.98 confidence.
      const evidence: Evidence[] = found.map((f) => ({
        detector: opts.id,
        family: opts.id,
        signal: `${f} present`,
        weight: opts.weight,
      }));
      return [claim<RuntimeFact>(runtimeFact(opts.runtime), evidence, 'deterministic')];
    },
  };
}

/** Go: `go.mod` is definitive. */
export const goDetector = manifestRuntimeDetector({
  id: 'manifest:go',
  runtime: 'go',
  files: ['go.mod'],
  weight: 0.9,
});

/** Rust: `Cargo.toml` is definitive; a lockfile reinforces it. */
export const rustDetector = manifestRuntimeDetector({
  id: 'manifest:rust',
  runtime: 'rust',
  files: ['Cargo.toml', 'Cargo.lock'],
  weight: 0.85,
});

/** JVM: Maven `pom.xml` or Gradle build files. */
export const jvmDetector = manifestRuntimeDetector({
  id: 'manifest:jvm',
  runtime: 'jvm',
  files: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
  weight: 0.85,
});

/** .NET: a project or solution file (arbitrary name, matched by extension), or an SDK pin. */
export const dotnetDetector = manifestRuntimeDetector({
  id: 'manifest:dotnet',
  runtime: 'dotnet',
  files: ['Directory.Build.props', 'global.json'],
  suffixes: ['.csproj', '.sln'],
  weight: 0.8,
});

/** PHP: `composer.json` is the ecosystem's manifest. */
export const phpDetector = manifestRuntimeDetector({
  id: 'manifest:php',
  runtime: 'php',
  files: ['composer.json'],
  weight: 0.85,
});

/** Ruby: a `Gemfile` (optionally reinforced by its lockfile). */
export const rubyDetector = manifestRuntimeDetector({
  id: 'manifest:ruby',
  runtime: 'ruby',
  files: ['Gemfile', 'Gemfile.lock'],
  weight: 0.85,
});

/** Every Phase-B tier-1 runtime detector, in priority order. */
export const RUNTIME_DETECTORS: readonly Detector<RuntimeFact>[] = [
  goDetector,
  rustDetector,
  jvmDetector,
  dotnetDetector,
  phpDetector,
  rubyDetector,
];
