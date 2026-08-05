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

import {
  bestClaim,
  claimsOfKind,
  combineConfidence,
  reasoning,
  type Evidence,
} from '../model/claim.js';
import type { RepoContext } from '../model/detector.js';
import type { Runtime } from '../model/recipe.js';
import { BARE_RUNTIME_RECIPE_IDS, defaultRecipeRegistry } from '../model/recipes/index.js';
import { activeFsReadScope, DEFAULT_WALK_IGNORE, readFileIfExists } from '../utils/fs.js';
import { withFsCache } from '../utils/fsCache.js';
import { OrcaError } from '../utils/errors.js';
import { analyzeAzurePipelines } from './azurePipelines.js';
import { recoverBuild } from './buildRecovery.js';
import { recoverRuntimes, type RuntimeVersionSignal } from './runtimeRecovery.js';
import { DEFAULT_SOURCE_WEIGHTS } from './signalSources.js';
import { analyzeCi } from './ci.js';
import { analyzeCircleCi } from './circleci.js';
import { detectComponentRole } from './componentRole.js';
import { analyzeDockerfiles, runtimeFromBaseImage, hasContainerFile } from './dockerfile.js';
import { analyzeGitlabCi } from './gitlabCi.js';
import { defaultDetectorRegistry } from './detectors/index.js';
import type { RuntimeFact } from './detectors/facts.js';
import { detectEntrypoint } from './entrypoint.js';
import { detectBackendFramework, detectFrontendFramework } from './framework.js';
import { matchFrameworks } from './frameworkSignatures.js';
import { detectLanguages } from './language.js';
import { readAllDependencies } from './manifest.js';
import {
  readDotnetDependencies,
  readGoDependencies,
  readJvmDependencies,
  readPhpDependencies,
  readRubyDependencies,
  readRustDependencies,
} from './manifestExt.js';
import { detectMonorepo, type MonorepoInfo } from './monorepo.js';
import { detectPackageManager } from './packageManager.js';
import { declaredPorts, detectPorts } from './ports.js';
import { analyzeReadme } from './readme.js';
import { detectServices } from './services.js';
import { analyzeShellScripts } from './shellScript.js';
import { recoverTasks } from './taskRunners.js';
import { expandWorkspaceGlobs } from './workspaceGlobs.js';
import { MANIFEST_FILES } from './types.js';
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
  RunnableRole,
} from './types.js';

export type { DetectionResult } from './types.js';

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
  return hasDotnetProject(dir);
}

/** .NET project/solution files have arbitrary names, so a candidate root is found by extension. */
async function hasDotnetProject(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && (e.name.endsWith('.csproj') || e.name.endsWith('.sln')));
}

async function hasDockerfile(dir: string): Promise<boolean> {
  // Delegates rather than re-deriving the name pattern: `nestedComponentDirs` asks the
  // same question when scoping a port scan, and the two answers must never diverge.
  return hasContainerFile(dir);
}

async function hasCandidateSignal(dir: string): Promise<boolean> {
  return (await hasManifest(dir)) || (await hasDockerfile(dir));
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
  if (await hasCandidateSignal(repoPath)) roots.push('.');

  const subdirs = entries
    .filter((e) => e.isDirectory() && !DEFAULT_WALK_IGNORE.includes(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of subdirs) {
    if (await hasCandidateSignal(join(repoPath, name))) roots.push(name);
  }

  // Nested workspace packages (deeper than one level) discovered via monorepo globs.
  for (const dir of workspaceDirs) {
    if (!roots.includes(dir) && (await hasCandidateSignal(join(repoPath, dir)))) roots.push(dir);
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
 * Pure hint-preference pick — no side effects, no dropping. Used only to compute the
 * `frontend`/`backend` derived-compat fields from an already-built component list; every
 * match, not just this pick, still lands in `DetectionResult.components`.
 */
function pickPrimary(
  matches: readonly DetectedComponent[],
  hint: RegExp
): DetectedComponent | null {
  if (matches.length === 0) return null;
  const hinted = matches.find((c) => hint.test(c.rootDir));
  return hinted ?? matches[0] ?? null;
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
  // One read scope for the whole pass. Detection's ~60 read sites are spread across 19
  // modules and several run once per candidate root, so the same manifests are otherwise
  // re-read many times over. The scope memoizes them without any detector taking a cache
  // argument, and is discarded when this settles.
  //
  // An enclosing scope is REUSED rather than shadowed, so a caller that wraps several
  // detection passes gets one cache across all of them (and can read its stats) instead of
  // each pass starting cold behind a scope the caller cannot see.
  if (activeFsReadScope() !== undefined) return detectStackScoped(repoPath);
  const { result } = await withFsCache(() => detectStackScoped(repoPath));
  return result;
}

async function detectStackScoped(repoPath: string): Promise<DetectionResult> {
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

  // A candidate may serve both roles (single-package repos with react + express). Every
  // match becomes a component — no picking, no dropping. A monorepo with 3 Express
  // services yields 3 backend-role entries here, not 1 (the pickCandidate bug this
  // replaces: it kept exactly one match per role and silently discarded the rest).
  const frontendMatches = candidates.filter((c) => c.frontend !== 'unknown');
  const backendMatches = candidates.filter((c) => c.backend !== 'unknown');
  const [frontendComponents, backendComponents] = await Promise.all([
    Promise.all(frontendMatches.map((c) => buildComponent('frontend', c))),
    Promise.all(backendMatches.map((c) => buildComponent('backend', c))),
  ]);
  const components = [...frontendComponents, ...backendComponents];

  // frontend/backend are a derived, deprecated compat view (see types.ts): the same
  // directory-hint preference pickCandidate used to apply, just no longer dropping the
  // rest. A single-frontend+single-backend repo resolves identically to before.
  const frontend = pickPrimary(frontendComponents, FRONTEND_DIR_HINT);
  const backend = pickPrimary(backendComponents, BACKEND_DIR_HINT);

  for (const c of candidates) {
    if (c.frontend === 'unknown' && c.backend === 'unknown') {
      warnings.push({
        code: 'unrecognized-component',
        message: `'${c.rootDir}' has a manifest but no supported framework (react/express/django).`,
        detector: 'index',
      });
    }
  }

  // Informational, non-blocking: more than one component shares a role. Nothing was
  // dropped (all of them are in `components`) — this just explains what `.frontend`/
  // `.backend` resolved to for anything still reading the singular compat fields.
  for (const [role, matches, primary] of [
    ['frontend', frontendComponents, frontend],
    ['backend', backendComponents, backend],
  ] as const) {
    if (matches.length > 1) {
      warnings.push({
        code: `multiple-${role}-components`,
        message: `${matches.length} ${role} components detected (${matches.map((c) => c.rootDir).join(', ')}); '${primary?.rootDir}' is the default .${role} — all are included in .components.`,
        detector: 'index',
      });
    }
  }

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

  // Insights (incl. matched ecosystem components) are gathered before the support
  // decision, because a placeable ecosystem component (Go/Rust/JVM/.NET with a matched
  // recipe) makes a repo containerizable even without a seed frontend/backend.
  const insights = await gatherInsights(
    repoPath,
    roots,
    monorepo,
    new Set(components.map((c) => c.rootDir))
  );
  const hasEcosystem = insights.ecosystemComponents.length > 0 || insights.dockerfiles.length > 0;

  const isSupported = components.length > 0 || hasEcosystem;
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

  // Candidate roots that NOTHING placed — no seed component, no ecosystem recipe, no
  // Dockerfile. Distinct from `unrecognized-component` above, which fires whenever the
  // SEED path can't classify a root and so is emitted even for roots the ecosystem path
  // went on to place successfully. That coarseness is why this is a separate code: it is
  // the only signal that says "this directory is in the repo and ORCA is shipping
  // nothing for it", which `assessUnderstanding` grades on.
  const placedRoots = new Set<string>([
    ...components.map((c) => c.rootDir),
    ...insights.ecosystemComponents.map((e) => e.rootDir),
    ...insights.dockerfiles.map((d) => d.rootDir),
  ]);
  //
  // A root whose ROLE says nothing there runs is excluded: `unrunnableRoots` holds the
  // directories detection deliberately placed nothing for (a workspace root, a shared
  // package), and reporting those as unplaced conflates a resolved outcome with a miss.
  // `assessUnderstanding` grades every `unplaced-component` as an incomplete stack, so a
  // monorepo ORCA understood COMPLETELY — every real component placed, the parents
  // correctly recognized as libraries — still came out `partial` with `shouldEscalate`,
  // spending a tier-3 inference call on a `{ private, workspaces }` file. They still
  // surface as `library-component`, which says what is true without claiming something
  // is missing.
  const unrunnable = new Set(insights.unrunnableRoots);
  for (const c of candidates) {
    if (placedRoots.has(c.rootDir)) continue;
    if (unrunnable.has(c.rootDir)) {
      warnings.push({
        code: 'library-component',
        message: `'${c.rootDir}' is imported rather than run (no bin, no start script, no entry module) — nothing is containerized for it.`,
        detector: 'index',
      });
      continue;
    }
    warnings.push({
      code: 'unplaced-component',
      message: `'${c.rootDir}' declares a manifest but nothing was placed for it — it will be missing from the generated stack.`,
      detector: 'index',
    });
  }

  // Confidence stays boolean-per-role (does a frontend/backend exist at all), not scaled
  // by component count — a monorepo with 3 backends isn't inherently "more confidently
  // detected" than one with 1. See docs/universal-understanding-plan.md for the rationale
  // if this is revisited.
  const evidence = confidenceEvidence(frontend, backend, databases, insights, components);

  return {
    repoPath,
    languages: await detectLanguages(repoPath),
    packageManagers,
    components,
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
  const [common, go, rust, jvm, dotnet, php, ruby] = await Promise.all([
    readAllDependencies(dir),
    readGoDependencies(dir),
    readRustDependencies(dir),
    readJvmDependencies(dir),
    readDotnetDependencies(dir),
    readPhpDependencies(dir),
    readRubyDependencies(dir),
  ]);
  return [...new Set([...common, ...go, ...rust, ...jvm, ...dotnet, ...php, ...ruby])];
}

/** True when any of the named files exists at `dir`. */
async function hasFile(dir: string, ...names: string[]): Promise<boolean> {
  // Probed together: the names are independent and a serial chain here is paid once per
  // candidate root. The run-scoped read cache collapses repeats, so a name another helper already
  // looked at costs nothing the second time.
  const found = await Promise.all(
    names.map(async (name) => (await readFileIfExists(join(dir, name))) !== null)
  );
  return found.some(Boolean);
}

/**
 * The start command a root's own manifest declares, as a spreadable partial.
 *
 * Detection already resolves this (`detectEntrypoint` reads package scripts, Procfile,
 * manage.py) — it was simply never carried to the plan for ecosystem components, so a
 * bare-fallback recipe fell back to a hardcoded guess while the real command sat one
 * function call away. Returns `{}` when nothing declared one, so the field stays absent
 * rather than empty and the recipe's own command is used unchanged.
 */
async function ownStartCommand(
  absDir: string,
  role: RunnableRole
): Promise<{ startCommand?: string }> {
  const entrypoint = await detectEntrypoint(absDir, role);
  return entrypoint === null ? {} : { startCommand: entrypoint.command };
}

/** Marker files present at a directory (mostly basenames, one nested path), for file-marker matching. */
async function filesAt(dir: string): Promise<string[]> {
  const markers = [
    'go.mod',
    'Cargo.toml',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'manage.py',
    // The Node manifest. Every Node recipe above the bare fallback matches on a
    // DEPENDENCY, so this was never needed and was absent — which silently made the
    // `node-app` fallback unreachable through this path even once it was registered
    // (its matcher keys on the manifest alone, by design: knowing the runtime and having
    // a manifest is the whole point of a bare fallback). Adding a marker only widens what
    // the matcher can see; no existing recipe keys off it, so no existing match changes.
    'package.json',
    // Python lockfiles/manifests: the FastAPI/Flask recipes select a uv/Poetry/pip
    // variant by which of these is present, so they must reach the matcher's `files`.
    'requirements.txt',
    'pyproject.toml',
    'uv.lock',
    'poetry.lock',
    'vite.config.ts',
    'vite.config.js',
    'global.json',
    'Directory.Build.props',
    'composer.json',
    'Gemfile',
    // Symfony's CLI entrypoint, one directory down — corroborates the framework-bundle
    // dependency for the php-symfony recipe's matcher. Not a basename like the rest of
    // this list, but `join(dir, m)` handles the subpath the same way.
    'bin/console',
  ];
  // Marker probes are independent; issue them together and keep `markers` order so the
  // matcher sees a stable list.
  const hits = await Promise.all(
    markers.map(async (m) => ((await readFileIfExists(join(dir, m))) !== null ? m : null))
  );
  const present: string[] = hits.filter((m): m is string => m !== null);
  // .NET project/solution files have arbitrary names, so surface them by extension —
  // the dotnet recipe matches on the `.csproj`/`.sln` suffix, not a fixed filename.
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.csproj') || entry.name.endsWith('.sln'))) {
        present.push(entry.name);
      }
    }
  } catch {
    // dir unreadable — the markers above already returned what we could see.
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
  monorepo: MonorepoInfo,
  /**
   * Roots the SEED path already placed as `DetectedComponent`s.
   *
   * This is the disjointness guard, and it replaces a hardcoded list of recipe ids
   * (`recipe.id !== 'node-react' && recipe.id !== 'node-express'`, plus `'python-django'`).
   * That list encoded the invariant indirectly and could only stay correct while exactly
   * three frameworks were nameable — the moment the taxonomies opened and the detector
   * could name `vue`, a Vue+Vite repo was placed TWICE (seed `vue` and ecosystem
   * `node-vite`). The real rule was never about ids: a root that already became a
   * component must not become a second one.
   */
  seedRoots: ReadonlySet<string> = new Set()
): Promise<RepoInsights> {
  const registry = defaultDetectorRegistry();
  const recipes = defaultRecipeRegistry();
  const runtimeSet = new Set<Runtime>();
  const frameworkSet = new Set<string>();
  const taskCommands: RepoInsights['taskCommands'] = [];
  const seenTask = new Set<string>();
  const ecosystemComponents: RepoInsights['ecosystemComponents'] = [];
  const unrunnableRoots: string[] = [];
  const dockerfiles: RepoInsights['dockerfiles'] = [];
  const seenDockerfile = new Set<string>();

  for (const rootDir of roots) {
    const absDir = rootDir === '.' ? repoPath : join(repoPath, rootDir);
    const ctx: RepoContext = { repoPath, scopeDir: rootDir };

    // These reads are independent of one another, so issue them together rather than
    // awaiting each in turn. Detection is I/O-bound and this loop already runs once per
    // candidate root, so a serial chain here multiplies latency by the number of roots in
    // a monorepo. Accumulation below stays sequential and in root order, which is what
    // keeps every dedup (`seenTask`, `seenDockerfile`) and the resulting output stable.
    const [tasks, dockerfileAnalysis, claims, dependencies, files, hasNode, hasPython] =
      await Promise.all([
        recoverTasks(absDir),
        analyzeDockerfiles(absDir),
        registry.collectAtTier(1, ctx),
        allEcosystemDependencies(absDir),
        filesAt(absDir),
        hasFile(absDir, 'package.json'),
        hasFile(absDir, 'requirements.txt', 'pyproject.toml', 'manage.py'),
      ]);

    // Maintainer-declared tasks (Makefile/Taskfile/justfile/package scripts), deduped
    // by source+name across roots.
    for (const task of tasks) {
      const key = `${task.source}:${task.name}:${task.command}`;
      if (seenTask.has(key)) continue;
      seenTask.add(key);
      taskCommands.push({
        source: task.source,
        name: task.name,
        command: task.command,
        kind: task.kind,
      });
    }

    for (const dockerfile of dockerfileAnalysis.dockerfiles) {
      const key = `${dockerfile.rootDir}:${dockerfile.file}`;
      if (seenDockerfile.has(key)) continue;
      seenDockerfile.add(key);
      dockerfiles.push(dockerfile);
      runtimeSet.add(runtimeFromBaseImage(dockerfile.baseImage));
    }

    // Runtime claims from tier-1 detectors, best (highest-confidence) first. The registry
    // may hold detectors of other kinds (roles, …), so narrow by the fact's `kind` tag
    // rather than casting — a claim of another kind is filtered out, never mis-typed.
    const runtimeClaim = bestClaim(claimsOfKind<RuntimeFact>(claims, 'runtime'));

    // Only runtimes with a genuine manifest at this root count as present. node/python
    // are inferred from their common manifests (package.json / requirements|pyproject),
    // which the seed-stack readers already parsed into `dependencies`.
    if (runtimeClaim) runtimeSet.add(runtimeClaim.value.runtime);
    if (hasNode) runtimeSet.add('node');
    if (hasPython) runtimeSet.add('python');

    // Match frameworks against whichever runtimes are actually present here. A probe
    // set is unnecessary now that runtime presence is established up front.
    const present: Runtime[] = [
      runtimeClaim?.value.runtime,
      hasNode ? 'node' : undefined,
      hasPython ? 'python' : undefined,
    ].filter((r): r is Runtime => Boolean(r));
    for (const rt of present) {
      for (const match of matchFrameworks({ runtime: rt, dependencies, files })) {
        frameworkSet.add(match.id);
      }
    }

    // Role (§2.3): default 'backend' — the pre-widening behavior — unless a detector
    // finds unambiguous evidence this root is a queue worker or a CLI. Resolved once per
    // root and shared by both placement paths below. The declared-port list deliberately
    // excludes defaults, so "listens on something real" is what gates a reclassification.
    const rootPorts = await declaredPorts(absDir);

    // A non-seed ecosystem root (Go/Rust/JVM/.NET) with a matched recipe becomes an
    // open 'service' component. Plain-react/plain-express node roots and Django python
    // roots stay on the seed frontend/backend path, so they're excluded below (by
    // runtime here, by recipe id further down) to avoid double-placing the same
    // directory.
    // A root the seed path already placed must not be placed again (see `seedRoots`).
    const alreadySeeded = seedRoots.has(rootDir);

    if (
      !alreadySeeded &&
      runtimeClaim &&
      runtimeClaim.value.runtime !== 'node' &&
      runtimeClaim.value.runtime !== 'python'
    ) {
      const recipe = recipes.match({ runtime: runtimeClaim.value.runtime, dependencies, files });
      if (recipe) {
        const detected = await detectComponentRole(absDir, {
          dependencies,
          declaredPorts: rootPorts.map((p) => p.port),
          startCommand: recipe.startCommand,
        });
        ecosystemComponents.push({
          rootDir,
          runtime: runtimeClaim.value.runtime,
          recipeId: recipe.id,
          role: detected?.role ?? 'backend',
          ...(await ownStartCommand(absDir, detected?.role ?? 'backend')),
        });
      }
    }

    // A Python root whose framework the seed backend path can't place (Django is the
    // only seed Python backend) but which matches an ecosystem recipe — FastAPI/Flask —
    // becomes an open 'service' too. Django carries a `manage.py`, so its recipe never
    // matches here; the seed backend detector owns it. This keeps the two paths disjoint.
    if (!alreadySeeded && hasPython) {
      const recipe = recipes.match({ runtime: 'python', dependencies, files });
      if (recipe) {
        const detected = await detectComponentRole(absDir, {
          dependencies,
          declaredPorts: rootPorts.map((p) => p.port),
          startCommand: recipe.startCommand,
        });
        ecosystemComponents.push({
          rootDir,
          runtime: 'python',
          recipeId: recipe.id,
          role: detected?.role ?? 'backend',
          ...(await ownStartCommand(absDir, detected?.role ?? 'backend')),
        });
      }
    }

    // A Node root whose framework the seed frontend/backend path can't place (plain
    // react/express are the only seed Node frameworks) but which matches a more
    // specific Node framework recipe — Next.js/NestJS/Angular, or a non-React Vite app
    // — becomes an open 'service' too, mirroring the Python handling above. Plain
    // react/express are excluded by id so they stay on the seed path, keeping the two
    // paths disjoint (framework.ts already defers those roots out of 'react'/'express').
    if (!alreadySeeded && hasNode) {
      const recipe = recipes.match({ runtime: 'node', dependencies, files });
      if (recipe) {
        const detected = await detectComponentRole(absDir, {
          dependencies,
          declaredPorts: rootPorts.map((p) => p.port),
          startCommand: recipe.startCommand,
        });
        // A bare fallback matched on a MANIFEST ALONE — it carries no evidence that this
        // directory runs anything. If the role detectors independently say `library`
        // ("imported, not run" — no bin, no start script, no entry module), then the only
        // two signals we have disagree, and placing a service would emit a container that
        // starts nothing. A workspace root is the common case: `{ private, workspaces }`
        // and nothing else. A FRAMEWORK recipe is different — matching one needs real
        // dependencies, so it outweighs the negative evidence and still places.
        const unrunnable = BARE_RUNTIME_RECIPE_IDS.has(recipe.id) && detected?.role === 'library';
        // Recorded, not merely skipped: placing nothing here is a DECISION backed by the
        // role, and the caller has no other way to tell it apart from a root ORCA failed
        // to understand. See `RepoInsights.unrunnableRoots`.
        if (unrunnable) unrunnableRoots.push(rootDir);
        else {
          ecosystemComponents.push({
            rootDir,
            runtime: 'node',
            recipeId: recipe.id,
            role: detected?.role ?? 'backend',
            ...(await ownStartCommand(absDir, detected?.role ?? 'backend')),
          });
        }
      }
    }
  }

  for (const dockerfile of dockerfiles) {
    const runtime = runtimeFromBaseImage(dockerfile.baseImage);
    if (runtime !== 'unknown') runtimeSet.add(runtime);
  }

  const [readme, shellScripts, ci, gitlabCi, azurePipelines, circleCi] = await Promise.all([
    analyzeReadme(repoPath),
    analyzeShellScripts(repoPath),
    analyzeCi(repoPath),
    analyzeGitlabCi(repoPath),
    analyzeAzurePipelines(repoPath),
    analyzeCircleCi(repoPath),
  ]);
  const scriptSources: RepoInsights['scriptSources'] = [];
  if (readme.found) {
    scriptSources.push({
      source: 'readme',
      file: readme.file,
      commands: readme.commands,
      ports: readme.ports,
      readmePorts: readme.detectedPorts,
    });
  }
  for (const script of shellScripts.scripts) {
    scriptSources.push({
      source: 'shell-script',
      file: script.file,
      commands: script.commands,
      ports: script.ports,
    });
  }
  const ciProviders: RepoInsights['ciProviders'] = [
    ...gitlabCi.configs.map((c) => ({ provider: 'gitlab' as const, ...c })),
    ...azurePipelines.configs.map((c) => ({ provider: 'azure' as const, ...c })),
    ...circleCi.configs.map((c) => ({ provider: 'circleci' as const, ...c })),
  ];

  // Runtime-version pins from every provider, each tagged with its provider so the fold
  // can cite WHICH one pinned it. GitHub Actions first (stable ordering), then the
  // image-derived providers — the order `recoverRuntimes` preserves when it dedupes.
  const runtimeSignals: RuntimeVersionSignal[] = [
    ...ci.runtimeVersions.map((v) => ({ ...v, provider: 'github-actions' })),
    ...gitlabCi.runtimeVersions.map((v) => ({ ...v, provider: 'gitlab' })),
    ...azurePipelines.runtimeVersions.map((v) => ({ ...v, provider: 'azure' })),
    ...circleCi.runtimeVersions.map((v) => ({ ...v, provider: 'circleci' })),
  ];
  const recoveredRuntimesClaim = recoverRuntimes(runtimeSignals);
  // The raw `ciRuntimeVersions` array is now DERIVED from the normalized claim, so there
  // is one dedup rule (in `recoverRuntimes`), not two that drift. Deduped by the full
  // runtime:version key — a genuine cross-source difference (CI pins node:18, GitLab says
  // node:20) is real information and both are kept, as before.
  const ciRuntimeVersions: RepoInsights['ciRuntimeVersions'] =
    recoveredRuntimesClaim?.value.versions.map((v) => ({
      runtime: v.runtime,
      version: v.version,
    })) ?? [];

  const insights: RepoInsights = {
    frameworks: [...frameworkSet],
    runtimes: [...runtimeSet],
    monorepoTools: monorepo.tools,
    ciCommands: ci.commands.map((c) => ({ command: c.command, kind: c.kind })),
    ciRuntimeVersions,
    ciProviders,
    dockerfiles,
    taskCommands,
    scriptSources,
    ecosystemComponents,
    unrunnableRoots,
    recoveredBuild: null,
    recoveredRuntimes:
      recoveredRuntimesClaim === null
        ? null
        : {
            ...recoveredRuntimesClaim.value,
            confidence: recoveredRuntimesClaim.confidence,
            reasoning: reasoning(recoveredRuntimesClaim),
          },
  };

  // Recovery reads the assembled insights (it spans CI, tasks, and scripts), so it runs
  // last and folds its own answer back in. Projected to plain data here — the plan reads
  // insights, not `Claim`s — keeping the claim's confidence and reasoning trail.
  const recovered = recoverBuild(insights);
  if (recovered !== null) {
    insights.recoveredBuild = {
      ...recovered.value,
      confidence: recovered.confidence,
      reasoning: reasoning(recovered),
    };
  }
  return insights;
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
/**
 * Evidence contributed by the per-component detectors that previously returned bare
 * values.
 *
 * These say WHY a component was described the way it was — "pnpm-lock.yaml present"
 * rather than a silent `'pnpm'`. Weight 0: they explain a component ORCA has already
 * decided exists, so they belong in the reasoning trail without moving the score (the
 * component's own detection is what earns confidence). This is design requirement #6
 * applied to the detectors that were previously invisible in the trail.
 */
function componentDetectorEvidence(components: readonly DetectedComponent[]): Evidence[] {
  const evidence: Evidence[] = [];
  for (const component of components) {
    const where = component.rootDir === '.' ? 'repo root' : `'${component.rootDir}'`;
    if (component.packageManager !== 'unknown') {
      evidence.push({
        detector: 'packageManager',
        family: `packageManager:${component.rootDir}`,
        signal: `${where}: package manager ${component.packageManager}`,
        weight: 0,
      });
    }
    if (component.entrypoint) {
      evidence.push({
        detector: 'entrypoint',
        family: `entrypoint:${component.rootDir}`,
        signal: `${where}: starts with '${component.entrypoint.command}' (${component.entrypoint.source})`,
        weight: 0,
      });
    }
    if (component.language !== 'unknown') {
      evidence.push({
        detector: 'language',
        family: `language:${component.rootDir}`,
        signal: `${where}: ${component.language}`,
        weight: 0,
      });
    }
  }
  return evidence;
}

function confidenceEvidence(
  frontend: DetectedComponent | null,
  backend: DetectedComponent | null,
  databases: DetectedDatabase[],
  insights: RepoInsights,
  components: readonly DetectedComponent[] = []
): Evidence[] {
  const evidence: Evidence[] = [...componentDetectorEvidence(components)];
  if (backend !== null) {
    evidence.push({
      detector: 'index',
      family: 'component:backend',
      signal: `backend component detected (${backend.framework})`,
      weight: 0.55,
    });
  }
  if (frontend !== null) {
    evidence.push({
      detector: 'index',
      family: 'component:frontend',
      signal: `frontend component detected (${frontend.framework})`,
      weight: 0.45,
    });
  }
  if (databases.length > 0) {
    evidence.push({
      detector: 'index',
      family: 'services',
      signal: `database dependency found (${databases.map((d) => d.engine).join(', ')})`,
      weight: 0.35,
    });
  }
  if (frontend?.entrypoint) {
    // Same family as the frontend component itself: an entrypoint INSIDE an already
    // detected component refines that one observation, it is not a second independent one.
    evidence.push({
      detector: 'index',
      family: 'component:frontend',
      signal: 'frontend entrypoint resolved',
      weight: 0.25,
    });
  }
  if (backend?.entrypoint) {
    evidence.push({
      detector: 'index',
      family: 'component:backend',
      signal: 'backend entrypoint resolved',
      weight: 0.25,
    });
  }
  // Ports recovered from a README are explained, not scored. `DetectedPort.source` exists
  // so the log can say WHY a port was chosen, and a README-sourced port is the one case a
  // user is most likely to want to double-check. Weight 0 keeps it in the reasoning trail
  // without moving confidence — the README already contributes through `scriptSources`.
  for (const [role, component] of [
    ['frontend', frontend],
    ['backend', backend],
  ] as const) {
    for (const port of component?.ports ?? []) {
      if (port.source !== 'readme') continue;
      evidence.push({
        detector: 'ports',
        signal: `${role} port ${port.port} read from the README`,
        weight: 0,
      });
    }
  }
  if (insights.dockerfiles.length > 0) {
    evidence.push({
      detector: 'dockerfile',
      signal: `Dockerfile parsed (${insights.dockerfiles.length} file(s))`,
      weight: 0.6,
    });
  }
  for (const eco of insights.ecosystemComponents) {
    // One family PER ROOT: separate directories with their own manifests are genuinely
    // independent observations, so matching five of them is stronger than matching one.
    evidence.push({
      detector: 'recipe',
      family: `recipe:${eco.rootDir}`,
      signal: `ecosystem component matched (${eco.runtime} → ${eco.recipeId})`,
      weight: 0.55,
    });
    // A non-default role is explained, not scored: knowing a component is a worker
    // rather than a service changes how it's PLACED (no published port), not how
    // confident ORCA is that it understood the repo. Weight 0 keeps it in the reasoning
    // trail without moving the number.
    if (eco.role !== 'backend') {
      evidence.push({
        detector: 'component-role',
        signal: `'${eco.rootDir}' classified as ${eco.role} — no published port`,
        weight: 0,
      });
    }
  }
  // CI corroboration only *reinforces* an already-detected stack (the maintainer's own
  // build recipe agreeing with detection); it never manufactures confidence on its own,
  // so a repo with CI but no recognized component still scores 0.
  const hasStack =
    frontend !== null ||
    backend !== null ||
    insights.ecosystemComponents.length > 0 ||
    insights.dockerfiles.length > 0;
  const ciBuildSignals = insights.ciCommands.filter(
    (c) => c.kind === 'build' || c.kind === 'start'
  );
  if (hasStack && ciBuildSignals.length > 0) {
    evidence.push({
      detector: 'ci',
      signal: `CI corroborates the build (${ciBuildSignals.length} build/start step(s))`,
      weight: DEFAULT_SOURCE_WEIGHTS.ci,
    });
  }
  // README/shell-script commands are the weakest deterministic signal here, so they are
  // strictly GAP-FILLING: they count only when no more authoritative source already spoke
  // (no Dockerfile, no CI), and — like CI above — only when a stack was already detected.
  // Both guards together mean this source can never promote an unsupported repo, and
  // never outranks a Dockerfile, a CI config, or a matched recipe.
  const scriptBuildSignals = insights.scriptSources.flatMap((s) =>
    s.commands.filter((c) => c.kind === 'build' || c.kind === 'start')
  );
  const authoritativeSourceSpoke =
    insights.dockerfiles.length > 0 || insights.ciCommands.length > 0;
  if (hasStack && !authoritativeSourceSpoke && scriptBuildSignals.length > 0) {
    evidence.push({
      detector: 'repo-scripts',
      signal: `README/scripts declare the build (${scriptBuildSignals.length} build/start command(s))`,
      weight: DEFAULT_SOURCE_WEIGHTS.script,
    });
  }
  return evidence;
}
