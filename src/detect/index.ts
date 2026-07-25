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
import { defaultRecipeRegistry } from '../model/recipes/index.js';
import { DEFAULT_WALK_IGNORE, readFileIfExists } from '../utils/fs.js';
import { OrcaError } from '../utils/errors.js';
import { analyzeAzurePipelines } from './azurePipelines.js';
import { recoverBuild } from './buildRecovery.js';
import { analyzeCi } from './ci.js';
import { analyzeCircleCi } from './circleci.js';
import { detectComponentRole } from './componentRole.js';
import { analyzeDockerfiles, runtimeFromBaseImage } from './dockerfile.js';
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
 * manifests come first; the ecosystem manifests (Go/Rust/JVM/.NET) widen candidate
 * discovery so those components surface, match a `BuildRecipe`, and containerize via
 * the open-role 'service' path.
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
  'composer.json',
  'Gemfile',
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
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && /^(?:dockerfile|containerfile)(?:\..+)?$/i.test(entry.name)) {
      return true;
    }
  }
  return false;
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
function pickPrimary(matches: readonly DetectedComponent[], hint: RegExp): DetectedComponent | null {
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
  const insights = await gatherInsights(repoPath, roots, monorepo);
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

  // Confidence stays boolean-per-role (does a frontend/backend exist at all), not scaled
  // by component count — a monorepo with 3 backends isn't inherently "more confidently
  // detected" than one with 1. See docs/universal-understanding-plan.md for the rationale
  // if this is revisited.
  const evidence = confidenceEvidence(frontend, backend, databases, insights);

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
  for (const name of names) {
    if ((await readFileIfExists(join(dir, name))) !== null) return true;
  }
  return false;
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
  const present: string[] = [];
  for (const m of markers) {
    if ((await readFileIfExists(join(dir, m))) !== null) present.push(m);
  }
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
  monorepo: MonorepoInfo
): Promise<RepoInsights> {
  const registry = defaultDetectorRegistry();
  const recipes = defaultRecipeRegistry();
  const runtimeSet = new Set<Runtime>();
  const frameworkSet = new Set<string>();
  const taskCommands: RepoInsights['taskCommands'] = [];
  const seenTask = new Set<string>();
  const ecosystemComponents: RepoInsights['ecosystemComponents'] = [];
  const dockerfiles: RepoInsights['dockerfiles'] = [];
  const seenDockerfile = new Set<string>();

  for (const rootDir of roots) {
    const absDir = rootDir === '.' ? repoPath : join(repoPath, rootDir);
    const ctx: RepoContext = { repoPath, scopeDir: rootDir };

    // Maintainer-declared tasks (Makefile/Taskfile/justfile/package scripts), deduped
    // by source+name across roots.
    for (const task of await recoverTasks(absDir)) {
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

    const dockerfileAnalysis = await analyzeDockerfiles(absDir);
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
    const claims = await registry.collectAtTier(1, ctx);
    const runtimeClaim = bestClaim(claimsOfKind<RuntimeFact>(claims, 'runtime'));
    const dependencies = await allEcosystemDependencies(absDir);
    const files = await filesAt(absDir);

    // Only runtimes with a genuine manifest at this root count as present. node/python
    // are inferred from their common manifests (package.json / requirements|pyproject),
    // which the seed-stack readers already parsed into `dependencies`.
    if (runtimeClaim) runtimeSet.add(runtimeClaim.value.runtime);
    const hasNode = await hasFile(absDir, 'package.json');
    const hasPython = await hasFile(absDir, 'requirements.txt', 'pyproject.toml', 'manage.py');
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
    if (
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
        });
      }
    }

    // A Python root whose framework the seed backend path can't place (Django is the
    // only seed Python backend) but which matches an ecosystem recipe — FastAPI/Flask —
    // becomes an open 'service' too. Django carries a `manage.py`, so its recipe never
    // matches here; the seed backend detector owns it. This keeps the two paths disjoint.
    if (hasPython) {
      const recipe = recipes.match({ runtime: 'python', dependencies, files });
      if (recipe && recipe.id !== 'python-django') {
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
        });
      }
    }

    // A Node root whose framework the seed frontend/backend path can't place (plain
    // react/express are the only seed Node frameworks) but which matches a more
    // specific Node framework recipe — Next.js/NestJS/Angular, or a non-React Vite app
    // — becomes an open 'service' too, mirroring the Python handling above. Plain
    // react/express are excluded by id so they stay on the seed path, keeping the two
    // paths disjoint (framework.ts already defers those roots out of 'react'/'express').
    if (hasNode) {
      const recipe = recipes.match({ runtime: 'node', dependencies, files });
      if (recipe && recipe.id !== 'node-react' && recipe.id !== 'node-express') {
        const detected = await detectComponentRole(absDir, {
          dependencies,
          declaredPorts: rootPorts.map((p) => p.port),
          startCommand: recipe.startCommand,
        });
        ecosystemComponents.push({
          rootDir,
          runtime: 'node',
          recipeId: recipe.id,
          role: detected?.role ?? 'backend',
        });
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

  // GitHub Actions first (stable ordering), then the image-derived providers. Deduped by
  // the full runtime:version key, not by runtime alone — a genuine cross-source version
  // difference (e.g. CI pins node:18, a GitLab image says node:20) is real information
  // about the repo, not noise, so both entries are kept rather than one silently winning.
  const ciRuntimeVersions: RepoInsights['ciRuntimeVersions'] = [];
  const seenCiVer = new Set<string>();
  for (const v of [
    ...ci.runtimeVersions,
    ...gitlabCi.runtimeVersions,
    ...azurePipelines.runtimeVersions,
    ...circleCi.runtimeVersions,
  ]) {
    const key = `${v.runtime}:${v.version}`;
    if (seenCiVer.has(key)) continue;
    seenCiVer.add(key);
    ciRuntimeVersions.push(v);
  }

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
    recoveredBuild: null,
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
    evidence.push({
      detector: 'recipe',
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
      weight: 0.2,
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
      weight: 0.15,
    });
  }
  return evidence;
}
