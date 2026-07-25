/**
 * Package-manager detection, on the evidence model.
 *
 * Every rule here now says WHY it fired: a lockfile is near-definitive (the manager wrote
 * it), a `[tool.poetry]` table is strong, and "there is a package.json so probably npm" is
 * a weak fallback that should not read as certainty. Before this, all three returned the
 * same bare string and the reasoning was lost, so `DetectionResult.reasoning` could not
 * explain a choice the user might disagree with — which is exactly the case where an
 * explanation matters (design requirement #6).
 *
 * `detectPackageManager` keeps its original signature so existing callers are untouched;
 * `packageManagerClaim` is the evidence-carrying form the aggregator uses.
 *
 * STAGE: 2 (detect) — REAL code. Pure signal matching, no AI.
 */

import { join } from 'node:path';

import { claim, type Claim, type Evidence } from '../model/claim.js';
import { readFileIfExists } from '../utils/fs.js';
import { packageManagerFact, type PackageManagerFact } from './detectors/facts.js';
import type { PackageManager } from './types.js';

const LOCKFILE_MANAGER: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
];

/**
 * Weights by signal strength. A lockfile is written BY the manager, so it is the strongest
 * evidence available; a declared build-system table is strong but a statement of intent;
 * a bare manifest only narrows the ecosystem and is a genuine guess.
 */
const LOCKFILE_WEIGHT = 0.95;
const DECLARED_WEIGHT = 0.8;
const MANIFEST_WEIGHT = 0.45;

async function exists(dir: string, file: string): Promise<boolean> {
  return (await readFileIfExists(join(dir, file))) !== null;
}

/** Build the single-signal evidence list for a package-manager decision. */
function ev(signal: string, weight: number): Evidence[] {
  return [{ detector: 'packageManager', family: 'packageManager', signal, weight }];
}

/**
 * The package manager for a component, with the signal that decided it. Returns null when
 * nothing indicates one — the caller's `'unknown'`, but without inventing evidence for a
 * non-answer.
 */
export async function packageManagerClaim(
  componentPath: string
): Promise<Claim<PackageManagerFact> | null> {
  const build = (manager: PackageManager, signal: string, weight: number) =>
    claim(packageManagerFact(manager), ev(signal, weight), 'deterministic');

  for (const [lockfile, manager] of LOCKFILE_MANAGER) {
    if (await exists(componentPath, lockfile)) {
      return build(manager, `${lockfile} present`, LOCKFILE_WEIGHT);
    }
  }

  const pyproject = await readFileIfExists(join(componentPath, 'pyproject.toml'));
  if (pyproject !== null && pyproject.includes('[tool.poetry]')) {
    return build('poetry', 'pyproject.toml declares [tool.poetry]', DECLARED_WEIGHT);
  }
  if (pyproject !== null && pyproject.includes('[tool.uv]')) {
    return build('uv', 'pyproject.toml declares [tool.uv]', DECLARED_WEIGHT);
  }
  if (await exists(componentPath, 'Pipfile')) {
    return build('pipenv', 'Pipfile present', DECLARED_WEIGHT);
  }
  if (await exists(componentPath, 'requirements.txt')) {
    return build('pip', 'requirements.txt present (no lockfile)', MANIFEST_WEIGHT);
  }
  if (await exists(componentPath, 'package.json')) {
    return build('npm', 'package.json present with no lockfile — assuming npm', MANIFEST_WEIGHT);
  }

  return null;
}

/** The package manager for a component, or `'unknown'`. */
export async function detectPackageManager(componentPath: string): Promise<PackageManager> {
  return (await packageManagerClaim(componentPath))?.value.packageManager ?? 'unknown';
}
