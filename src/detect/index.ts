/**
 * Runs every independent detector and aggregates their output into a single
 * `DetectionResult`. This is the one place that composes the detect stage; each
 * detector stays standalone so it could later become its own agent.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute repo path.
 * Outputs: a fully-populated `DetectionResult` (the STAGE 2 contract).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_WALK_IGNORE, readFileIfExists } from '../utils/fs.js';
import { OrcaError } from '../utils/errors.js';
import { detectEntrypoint } from './entrypoint.js';
import { detectBackendFramework, detectFrontendFramework } from './framework.js';
import { detectLanguages } from './language.js';
import { readAllDependencies } from './manifest.js';
import { detectPackageManager } from './packageManager.js';
import { detectPorts } from './ports.js';
import { detectServices } from './services.js';
import type {
  BackendFramework,
  DetectedComponent,
  DetectedDatabase,
  DetectionResult,
  DetectionWarning,
  FrontendFramework,
  Language,
  PackageManager,
} from './types.js';

export type { DetectionResult } from './types.js';

/** Any of these marks a directory as a component root worth inspecting. */
const MANIFEST_FILES = ['package.json', 'requirements.txt', 'pyproject.toml', 'manage.py'];

/** Conventional directory names that disambiguate multiple candidates per role. */
const FRONTEND_DIR_HINT = /^(client|frontend|web|ui)$/i;
const BACKEND_DIR_HINT = /^(server|backend|api|service)$/i;

/** A directory that declared a manifest, plus what its manifest revealed. */
interface Candidate {
  /** Repo-relative root (`.` for the repo root itself). */
  rootDir: string;
  absDir: string;
  frontend: FrontendFramework;
  backend: BackendFramework;
}

async function hasManifest(dir: string): Promise<boolean> {
  for (const manifest of MANIFEST_FILES) {
    if ((await readFileIfExists(join(dir, manifest))) !== null) return true;
  }
  return false;
}

/** The repo root plus every first-level subdirectory that declares a manifest. */
async function findCandidateRoots(repoPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(repoPath, { withFileTypes: true });
  } catch {
    throw new OrcaError(`repo path not found or unreadable: ${repoPath}`, 'REPO_NOT_FOUND');
  }

  const roots: string[] = [];
  if (await hasManifest(repoPath)) roots.push('.');

  const subdirs = entries
    .filter((e) => e.isDirectory() && !DEFAULT_WALK_IGNORE.includes(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of subdirs) {
    if (await hasManifest(join(repoPath, name))) roots.push(name);
  }
  return roots;
}

/** Component-level language from its own manifests (repo-wide scan is separate). */
async function componentLanguage(absDir: string): Promise<Language> {
  for (const pythonMarker of ['manage.py', 'requirements.txt', 'pyproject.toml']) {
    if ((await readFileIfExists(join(absDir, pythonMarker))) !== null) return 'python';
  }
  if ((await readFileIfExists(join(absDir, 'tsconfig.json'))) !== null) return 'typescript';
  if ((await readFileIfExists(join(absDir, 'package.json'))) !== null) return 'javascript';
  return 'unknown';
}

/**
 * Pick the single candidate for a role. Multiple matches are resolved by the
 * conventional directory-name hint, then by first (alphabetical) order plus a warning.
 */
function pickCandidate(
  matches: Candidate[],
  hint: RegExp,
  role: 'frontend' | 'backend',
  warnings: DetectionWarning[]
): Candidate | null {
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;

  const hinted = matches.find((c) => hint.test(c.rootDir));
  const chosen = hinted ?? matches[0];
  warnings.push({
    code: `ambiguous-${role}`,
    message: `Multiple ${role} candidates (${matches.map((c) => c.rootDir).join(', ')}); picked '${chosen?.rootDir}'.`,
    detector: 'index',
  });
  return chosen ?? null;
}

/** Run the per-component detectors and assemble a `DetectedComponent`. */
async function buildComponent(
  role: 'frontend' | 'backend',
  candidate: Candidate
): Promise<DetectedComponent> {
  const [language, packageManager, dependencies, ports, entrypoint] = await Promise.all([
    componentLanguage(candidate.absDir),
    detectPackageManager(candidate.absDir),
    readAllDependencies(candidate.absDir),
    detectPorts(candidate.absDir, role),
    detectEntrypoint(candidate.absDir, role),
  ]);

  return {
    role,
    rootDir: candidate.rootDir,
    language,
    packageManager,
    framework: role === 'frontend' ? candidate.frontend : candidate.backend,
    dependencies,
    ports,
    // The entrypoint detector only sees the component dir; anchor its workingDir
    // to the repo-relative root so later stages can `cd` from the repo root.
    entrypoint: entrypoint === null ? null : { ...entrypoint, workingDir: candidate.rootDir },
  };
}

/**
 * Locate frontend/backend component roots, run each detector, decide
 * `isSupported` + `confidence`, and collect warnings.
 */
export async function detectStack(repoPath: string): Promise<DetectionResult> {
  const warnings: DetectionWarning[] = [];

  const roots = await findCandidateRoots(repoPath);
  const candidates: Candidate[] = await Promise.all(
    roots.map(async (rootDir) => {
      const absDir = rootDir === '.' ? repoPath : join(repoPath, rootDir);
      const [frontend, backend] = await Promise.all([
        detectFrontendFramework(absDir),
        detectBackendFramework(absDir),
      ]);
      return { rootDir, absDir, frontend, backend };
    })
  );

  // A candidate may serve both roles (single-package repos with react + express).
  const frontendPick = pickCandidate(
    candidates.filter((c) => c.frontend !== 'unknown'),
    FRONTEND_DIR_HINT,
    'frontend',
    warnings
  );
  const backendPick = pickCandidate(
    candidates.filter((c) => c.backend !== 'unknown'),
    BACKEND_DIR_HINT,
    'backend',
    warnings
  );

  for (const c of candidates) {
    if (c.frontend === 'unknown' && c.backend === 'unknown') {
      warnings.push({
        code: 'unrecognized-component',
        message: `'${c.rootDir}' has a manifest but no supported framework (react/express/django).`,
        detector: 'index',
      });
    }
  }

  const [frontend, backend] = await Promise.all([
    frontendPick === null ? null : buildComponent('frontend', frontendPick),
    backendPick === null ? null : buildComponent('backend', backendPick),
  ]);

  // Databases: union across every candidate root, first-found per engine wins.
  const databases: DetectedDatabase[] = [];
  for (const c of candidates) {
    for (const db of await detectServices(c.absDir)) {
      if (!databases.some((d) => d.engine === db.engine)) databases.push(db);
    }
  }

  // Package managers seen anywhere (per candidate root), 'unknown' filtered out.
  const packageManagers: PackageManager[] = [];
  for (const c of candidates) {
    const pm = await detectPackageManager(c.absDir);
    if (pm !== 'unknown' && !packageManagers.includes(pm)) packageManagers.push(pm);
  }

  const isSupported = frontend !== null || backend !== null;
  if (!isSupported) {
    warnings.push({
      code: 'unsupported-stack',
      message:
        candidates.length === 0
          ? 'No recognizable manifest found — ORCA supports React/Express/Django repos only.'
          : 'No supported framework detected — ORCA supports React/Express/Django repos only.',
      detector: 'index',
    });
  }

  return {
    repoPath,
    languages: await detectLanguages(repoPath),
    packageManagers,
    frontend,
    backend,
    databases,
    isSupported,
    confidence: scoreConfidence(frontend, backend, databases),
    warnings,
  };
}

/**
 * Deterministic 0..1 confidence: how much of the expected shape of a supported repo
 * was actually observed. A full frontend+backend+db repo with entrypoints scores 0.95;
 * a bare unsupported repo scores 0.
 */
function scoreConfidence(
  frontend: DetectedComponent | null,
  backend: DetectedComponent | null,
  databases: DetectedDatabase[]
): number {
  let score = 0;
  if (backend !== null) score += 0.35;
  if (frontend !== null) score += 0.25;
  if (databases.length > 0) score += 0.15;
  if (frontend?.entrypoint) score += 0.1;
  if (backend?.entrypoint) score += 0.1;
  return Math.min(1, Number(score.toFixed(2)));
}
