import { basename, extname, join } from 'node:path';

import { dockerfilePortsAt } from './dockerfile.js';
import { analyzeReadme } from './readme.js';
import { readFileIfExists, walk } from '../utils/fs.js';
import type { DetectedPort, ComponentRole } from './types.js';

const SCANNABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

const MAX_SCANNED_FILES = 200;

const CODE_PORT_PATTERNS: RegExp[] = [
  /\.listen\(\s*(\d{2,5})/,
  /(?:process\.env\.)?PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/,
  /port:\s*(\d{2,5})/,
  /runserver\s+(?:0\.0\.0\.0:)?(\d{2,5})/,
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

async function portsFromCode(componentPath: string): Promise<number[]> {
  const files = (await walk(componentPath))
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
    const isDjango =
      (await readFileIfExists(join(componentPath, 'manage.py'))) !== null ||
      (await readFileIfExists(join(componentPath, 'requirements.txt'))) !== null;
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
