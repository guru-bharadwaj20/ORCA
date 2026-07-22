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

import { bestClaim, combineConfidence, type Claim, type Evidence } from '../model/claim.js';
import type { RepoContext } from '../model/detector.js';
import type { Runtime } from '../model/recipe.js';
import { DEFAULT_WALK_IGNORE, readFileIfExists } from '../utils/fs.js';
import { OrcaError } from '../utils/errors.js';
import { analyzeCi } from './ci.js';
import { defaultDetectorRegistry } from './detectors/index.js';
import { detectEntrypoint } from './entrypoint.js';
import { detectBackendFramework, detectFrontendFramework } from './framework.js';
import { matchFrameworks } from './frameworkSignatures.js';
import { detectLanguages } from './language.js';
import { readAllDependencies } from './manifest.js';
import {
  readDotnetDependencies,
  readGoDependencies,
  readJvmDependencies,
  readRustDependencies,
} from './manifestExt.js';
import { detectMonorepo, type MonorepoInfo } from './monorepo.js';
import { detectPackageManager } from './packageManager.js';
import { detectPorts } from './ports.js';
import { detectServices } from './services.js';
import { expandWorkspaceGlobs } from './workspaceGlobs.js';
import type {
  BackendFramework,
  DetectedComponent,
  DetectedDatabase,
  DetectionResult,
  DetectionWarning,
  FrontendFramework,
  Language,
  PackageManager,
  RepoInsights,
} from './types.js';

export type { DetectionResult } from './types.js';

/**
 * Any of these marks a directory as a component root worth inspecting. The seed-stack
 * manifests come first (their presence drives the supported containerize path); the
 * ecosystem manifests (Phase B) widen candidate discovery so Go/Rust/JVM/.NET
 * components surface in `insights` even though the seed path doesn't build them yet.
 */
const MANIFEST_FILES = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'manage.py',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];

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

/**
 * The repo root plus every first-level subdirectory that declares a manifest, plus any
 * `workspaceDirs` (already expanded from monorepo globs) that declare one. Nested
 * workspace packages (`services/api`) only appear when passed via `workspaceDirs`,
 * since the base scan is intentionally single-level.
 */
async function findCandidateRoots(
  repoPath: string,
  workspaceDirs: readonly string[] = []
): Promise<string[]> {
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

  // Nested workspace packages (deeper than one level) discovered via monorepo globs.
  for (const dir of workspaceDirs) {
    if (!roots.includes(dir) && (await hasManifest(join(repoPath, dir)))) roots.push(dir);
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

  // Monorepo topology is resolved first so its workspace globs can promote nested
  // packages to candidate roots (and is reused by gatherInsights — detected once).
  const monorepo = await detectMonorepo(repoPath);
  const workspaceDirs = await expandWorkspaceGlobs(repoPath, monorepo.packageGlobs);
  const roots = await findCandidateRoots(repoPath, workspaceDirs);
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

  const insights = await gatherInsights(repoPath, roots, monorepo);
  const evidence = confidenceEvidence(frontend, backend, databases, insights);

  return {
    repoPath,
    languages: await detectLanguages(repoPath),
    packageManagers,
    frontend,
    backend,
    databases,
    isSupported,
    confidence: combineConfidence(evidence),
    reasoning: evidence.map((e) => e.signal),
    insights,
    warnings,
  };
}

/** Read every direct dependency across all ecosystems at one component root. */
async function allEcosystemDependencies(dir: string): Promise<string[]> {
  const [common, go, rust, jvm, dotnet] = await Promise.all([
    readAllDependencies(dir),
    readGoDependencies(dir),
    readRustDependencies(dir),
    readJvmDependencies(dir),
    readDotnetDependencies(dir),
  ]);
  return [...new Set([...common, ...go, ...rust, ...jvm, ...dotnet])];
}

/** Basenames present at a directory, for file-marker matching. */
async function filesAt(dir: string): Promise<string[]> {
  const markers = [
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'manage.py',
    'vite.config.ts',
    'vite.config.js',
    'global.json',
    'Directory.Build.props',
  ];
  const present: string[] = [];
  for (const m of markers) {
    if ((await readFileIfExists(join(dir, m))) !== null) present.push(m);
  }
  return present;
}

/**
 * Gather the forward-looking Phase-B/C signals: runtime claims (via the detector
 * registry), framework matches per candidate root, monorepo topology, and CI analysis.
 * Advisory — failures here never fail detection.
 */
async function gatherInsights(
  repoPath: string,
  roots: string[],
  monorepo: MonorepoInfo
): Promise<RepoInsights> {
  const registry = defaultDetectorRegistry();
  const runtimeSet = new Set<Runtime>();
  const frameworkSet = new Set<string>();

  for (const rootDir of roots) {
    const absDir = rootDir === '.' ? repoPath : join(repoPath, rootDir);
    const ctx: RepoContext = { repoPath, scopeDir: rootDir };

    // Runtime claims from tier-1 detectors, best (highest-confidence) first.
    const claims: Claim<unknown>[] = [];
    for (const detector of registry.atTier(1)) {
      claims.push(...(await detector.detect(ctx)));
    }
    const runtimeClaim = bestClaim(claims as Claim<Runtime>[]);
    const dependencies = await allEcosystemDependencies(absDir);
    const files = await filesAt(absDir);

    // Framework matches: try the claimed runtime, plus node/python (seed ecosystems
    // whose deps live in the common manifests) so frameworks surface even when no
    // dedicated runtime manifest exists (a bare React app has no runtime detector).
    const runtimes: Runtime[] = runtimeClaim ? [runtimeClaim.value] : [];
    for (const rt of [...runtimes, 'node', 'python'] as Runtime[]) {
      if (rt) runtimeSet.add(rt);
      for (const match of matchFrameworks({ runtime: rt, dependencies, files })) {
        frameworkSet.add(match.id);
      }
    }
  }

  const ci = await analyzeCi(repoPath);

  return {
    frameworks: [...frameworkSet],
    runtimes: [...runtimeSet],
    monorepoTools: monorepo.tools,
    ciCommands: ci.commands.map((c) => ({ command: c.command, kind: c.kind })),
    ciRuntimeVersions: ci.runtimeVersions,
  };
}

/**
 * Build the evidence trail behind the detection confidence: one weighted signal per
 * observed piece of the expected shape of a supported repo. Confidence is then the
 * probabilistic-OR combination of these weights (see `combineConfidence`), so
 * independent signals agreeing drive it up. A full frontend+backend+db repo with
 * entrypoints scores ~0.9; a bare unsupported repo yields no evidence and scores 0.
 *
 * Weights are tuned to preserve the prior heuristic's decision boundaries: a full
 * stack lands well above 0.8, a backend+db service above 0.5.
 */
function confidenceEvidence(
  frontend: DetectedComponent | null,
  backend: DetectedComponent | null,
  databases: DetectedDatabase[],
  insights: RepoInsights
): Evidence[] {
  const evidence: Evidence[] = [];
  if (backend !== null) {
    evidence.push({
      detector: 'index',
      signal: `backend component detected (${backend.framework})`,
      weight: 0.55,
    });
  }
  if (frontend !== null) {
    evidence.push({
      detector: 'index',
      signal: `frontend component detected (${frontend.framework})`,
      weight: 0.45,
    });
  }
  if (databases.length > 0) {
    evidence.push({
      detector: 'index',
      signal: `database dependency found (${databases.map((d) => d.engine).join(', ')})`,
      weight: 0.35,
    });
  }
  if (frontend?.entrypoint) {
    evidence.push({ detector: 'index', signal: 'frontend entrypoint resolved', weight: 0.25 });
  }
  if (backend?.entrypoint) {
    evidence.push({ detector: 'index', signal: 'backend entrypoint resolved', weight: 0.25 });
  }
  // CI corroboration only *reinforces* an already-detected stack (the maintainer's own
  // build recipe agreeing with detection); it never manufactures confidence on its own,
  // so a repo with CI but no recognized component still scores 0.
  const hasStack = frontend !== null || backend !== null;
  const ciBuildSignals = insights.ciCommands.filter(
    (c) => c.kind === 'build' || c.kind === 'start'
  );
  if (hasStack && ciBuildSignals.length > 0) {
    evidence.push({
      detector: 'ci',
      signal: `CI corroborates the build (${ciBuildSignals.length} build/start step(s))`,
      weight: 0.2,
    });
  }
  return evidence;
}
