import { readdir } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';

import { dockerfilePortsAt, hasContainerFile } from './dockerfile.js';
import { detectMonorepo } from './monorepo.js';
import { analyzeReadme } from './readme.js';
import { expandWorkspaceGlobs } from './workspaceGlobs.js';
import { DEFAULT_WALK_IGNORE, readFileIfExists, walk } from '../utils/fs.js';

import { MANIFEST_FILES, type DetectedPort, type ComponentRole } from './types.js';

const SCANNABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

const MAX_SCANNED_FILES = 200;

/**
 * Port literals in source. Each capture ends with `(?!\d)` so the pattern matches a WHOLE
 * number: without it `\d{2,5}` truncates a longer literal and reports a port the app never
 * binds — `app.listen(123456)` would yield 12345, which `isValidPort` happily accepts.
 */
const CODE_PORT_PATTERNS: RegExp[] = [
  /\.listen\(\s*(\d{2,5})(?!\d)/,
  /(?:process\.env\.)?PORT\s*(?:\|\||\?\?)\s*(\d{2,5})(?!\d)/,
  /port:\s*(\d{2,5})(?!\d)/,
  /runserver\s+(?:0\.0\.0\.0:)?(\d{2,5})(?!\d)/,
];

const KNOWN_SERVICE_PORTS = new Set([
  1433, 1521, 3306, 5432, 5672, 6379, 9200, 9300, 11211, 15672, 27017, 27018, 27019,
]);

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

async function portFromEnvFiles(componentPath: string): Promise<number | null> {
  for (const file of ['.env', '.env.example']) {
    const raw = await readFileIfExists(join(componentPath, file));
    const match = raw === null ? null : /^\s*PORT\s*=\s*(\d{2,5})\s*$/m.exec(raw);
    if (match?.[1]) {
      const port = Number(match[1]);
      if (isValidPort(port)) return port;
    }
  }
  return null;
}

async function portsFromDockerfile(componentPath: string): Promise<number[]> {
  // Honors every container-file variant the detector recognizes (Containerfile,
  // Dockerfile.prod, JSON-array/multi EXPOSE), not just a bare `Dockerfile`, and keeps
  // every exposed port — a container declaring EXPOSE 80 443 surfaces both.
  return (await dockerfilePortsAt(componentPath)).filter(isValidPort);
}

/**
 * Ports a component's own README declares — `docker run -p 8080:8080`, `--port 3000`,
 * `PORT=8000 npm start`, `http://localhost:5173`.
 *
 * Scoped to the component directory, not the repo root, so in a monorepo a package's own
 * README describes that package and the root README does not leak into every component.
 * The heavy lifting is `readme.ts`'s existing extraction: this is only the adapter that
 * turns its numbers into `DetectedPort`s.
 *
 * Known service ports are filtered out for the same reason `portsFromCode` filters them:
 * a README's `docker run -p 5432:5432 postgres` is telling you how to start the app's
 * DEPENDENCY, not the app. Without this a repo whose README documents its database would
 * publish the app on 5432 — the same trap `express-dbconfig-repo` was added to pin.
 * `insights.scriptSources` keeps the unfiltered list, since that is a raw record of what
 * the README said rather than a claim about what the component listens on.
 */
async function portsFromReadme(componentPath: string): Promise<number[]> {
  const analysis = await analyzeReadme(componentPath);
  return analysis.ports.filter((port) => isValidPort(port) && !KNOWN_SERVICE_PORTS.has(port));
}

/**
 * True when `dir` is a component in its own right — it declares a manifest, OR ships a
 * container file.
 *
 * THE DOCKERFILE HALF MATTERS. `findCandidateRoots` (`detect/index.ts`) promotes a
 * directory to a component on "manifest OR Dockerfile", so a subdirectory holding only a
 * `Dockerfile` is a separate component everywhere EXCEPT here — where a manifest-only
 * check let the parent keep scanning into it and claim its source ports as its own. Two
 * definitions of "is this a component" disagreeing is exactly the shape of the original
 * port-scoping bug, one predicate over.
 */
async function isComponentRoot(dir: string): Promise<boolean> {
  for (const manifest of MANIFEST_FILES) {
    if ((await readFileIfExists(join(dir, manifest))) !== null) return true;
  }
  return hasContainerFile(dir);
}

/** Immediate subdirectories of `componentPath` that declare their own manifest. */
async function immediateComponentDirs(componentPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(componentPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || DEFAULT_WALK_IGNORE.includes(entry.name)) continue;
    const dir = join(componentPath, entry.name);
    if (await isComponentRoot(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Package directories the repo's own workspace config declares, resolved to absolute
 * paths. These are the components a `packages/*` / `apps/*` layout nests ONE LEVEL DEEPER
 * than `immediateComponentDirs` can see: `packages/` holds no manifest itself, so the
 * first-level check walks straight through it and into `packages/api`, whose ports then
 * come back attached to the root.
 *
 * Read from `detectMonorepo` + `expandWorkspaceGlobs` rather than by descending blindly,
 * because those two already answer exactly this question and answer it from what the repo
 * DECLARES. A generic deeper walk would have to guess how far down a package may sit and
 * would start excluding ordinary source subtrees (`src/api/`) that are not components at
 * all — silencing ports the root really does own.
 */
async function workspaceComponentDirs(componentPath: string): Promise<string[]> {
  const { packageGlobs } = await detectMonorepo(componentPath);
  if (packageGlobs.length === 0) return [];

  const dirs: string[] = [];
  for (const relative of await expandWorkspaceGlobs(componentPath, packageGlobs)) {
    const dir = join(componentPath, relative);
    // A glob that resolves back to the component itself (`.`, `./`) would exclude the
    // ENTIRE scan and silently report no ports for anything. Never exclude self.
    if (dir === componentPath) continue;
    if (await isComponentRoot(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Subdirectories of `componentPath` that are components in their OWN right, as absolute
 * path prefixes to exclude from a source scan.
 *
 * A directory with its own manifest is a DIFFERENT component, so its ports belong to it.
 * Without this, a scan is recursive from the root and a monorepo root claims every child's
 * ports — `react-express-nodb-repo` reported 5173 and 5000, the client's and the server's.
 * That contaminated role detection at every parent: `detectComponentRole`'s master gate
 * ("declares a port ⇒ it is a service") and `libraryDetector`'s first check both consult
 * `declaredPorts`, so a workspace root always looked like a listening service and could
 * never be recognized as the package container it is.
 *
 * Two sources, because one level of nesting is not enough: the flat `client/` + `server/`
 * shape is caught by the immediate check, while pnpm/turbo's `packages/api` sits a level
 * below any directory holding a manifest and is only visible through the workspace globs
 * the repo declares.
 */
async function nestedComponentDirs(componentPath: string): Promise<string[]> {
  const [immediate, workspace] = await Promise.all([
    immediateComponentDirs(componentPath),
    workspaceComponentDirs(componentPath),
  ]);
  // Deduped: a workspace glob may name a first-level package both sources found.
  return [...new Set([...immediate, ...workspace])].map((dir) => dir + sep);
}

async function portsFromCode(componentPath: string): Promise<number[]> {
  const nested = await nestedComponentDirs(componentPath);
  const files = (await walk(componentPath))
    .filter((f) => !nested.some((prefix) => f.startsWith(prefix)))
    .filter((f) => SCANNABLE_EXTENSIONS.has(extname(f)) || basename(f).startsWith('vite.config'))
    .slice(0, MAX_SCANNED_FILES);

  const found: number[] = [];
  for (const file of files) {
    const raw = await readFileIfExists(file);
    if (raw === null) continue;
    for (const pattern of CODE_PORT_PATTERNS) {
      const match = pattern.exec(raw);
      if (match?.[1]) {
        const port = Number(match[1]);
        if (isValidPort(port) && !KNOWN_SERVICE_PORTS.has(port)) found.push(port);
      }
    }
  }
  return found;
}

/**
 * The port to assume when nothing in the repo declares one — or null when the role does
 * not listen at all. A worker, CLI, library, or job has no port to guess at, and
 * inventing 3000 for one would put a bogus published port in the plan. Only the roles in
 * `LISTENING_ROLES` get a default; frontend/backend behavior is unchanged.
 */
async function defaultPortFor(componentPath: string, role: ComponentRole): Promise<number | null> {
  if (role === 'backend') {
    // Only manage.py marks Django (port 8000). A bare requirements.txt is far too broad —
    // Flask, FastAPI, and generic Python backends ship one too and don't listen on 8000.
    const isDjango = (await readFileIfExists(join(componentPath, 'manage.py'))) !== null;
    return isDjango ? 8000 : 3000;
  }
  if (role === 'frontend') {
    const pkg = await readFileIfExists(join(componentPath, 'package.json'));
    const usesVite = pkg !== null && pkg.includes('"vite"');
    return usesVite ? 5173 : 3000;
  }
  return null;
}

/**
 * The ports a component GENUINELY declares — from a `.env`, a Dockerfile `EXPOSE`, or
 * the source itself. No default is ever invented here.
 *
 * Split out from `detectPorts` because "does this component actually listen?" is the
 * question role detection asks (`componentRole.ts`): a fabricated fallback port would
 * make every component look like a server and no repo would ever resolve to a worker.
 */
export async function declaredPorts(componentPath: string): Promise<DetectedPort[]> {
  const ports: DetectedPort[] = [];
  const seen = new Set<number>();
  const add = (port: number, source: DetectedPort['source']): void => {
    if (!seen.has(port)) {
      seen.add(port);
      ports.push({ port, protocol: 'tcp', source });
    }
  };

  const fromEnv = await portFromEnvFiles(componentPath);
  if (fromEnv !== null) add(fromEnv, 'env');

  for (const port of await portsFromDockerfile(componentPath)) add(port, 'dockerfile');

  for (const port of await portsFromCode(componentPath)) add(port, 'code');

  // README last, because it is the weakest of the declaring sources. No precedence rule
  // is needed for that: `add` already keeps the FIRST source to claim a port number, so a
  // port that a Dockerfile `EXPOSE` or the source itself also declares is recorded with
  // that stronger origin and the README simply corroborates it silently.
  for (const port of await portsFromReadme(componentPath)) add(port, 'readme');

  return ports;
}

export async function detectPorts(
  componentPath: string,
  role: ComponentRole
): Promise<DetectedPort[]> {
  const ports = await declaredPorts(componentPath);
  if (ports.length > 0) return ports;

  const fallback = await defaultPortFor(componentPath, role);
  return fallback === null ? [] : [{ port: fallback, protocol: 'tcp', source: 'default' }];
}
