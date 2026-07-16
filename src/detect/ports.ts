/**
 * Detects the port(s) a component listens on: explicit values in env files, a
 * Dockerfile EXPOSE, or code (`app.listen(3000)`, `process.env.PORT || 3000`,
 * a vite config `port:`), falling back to framework defaults (Vite 5173,
 * Express/Node 3000, Django 8000). NO AI.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute component root path + its detected role.
 * Outputs: the list of `DetectedPort`s, each tagged with how it was found,
 * most-authoritative first (env > dockerfile > code > default).
 */

import { basename, extname, join } from 'node:path';

import { readFileIfExists, walk } from '../utils/fs.js';
import type { DetectedPort, ComponentRole } from './types.js';

/** Source file extensions worth scanning for port literals. */
const SCANNABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

/** Cap the scan so detection stays fast on big repos. */
const MAX_SCANNED_FILES = 200;

/** Patterns that reveal a listen port in source code. */
const CODE_PORT_PATTERNS: RegExp[] = [
  /\.listen\(\s*(\d{2,5})/, // app.listen(3000)
  /(?:process\.env\.)?PORT\s*(?:\|\||\?\?)\s*(\d{2,5})/, // process.env.PORT || 3000
  /port:\s*(\d{2,5})/, // vite/webpack dev-server config
  /runserver\s+(?:0\.0\.0\.0:)?(\d{2,5})/, // Django runserver 0.0.0.0:8000
];

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** First port found in `.env` / `.env.example` (`PORT=3000`), if any. */
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

/** First `EXPOSE <port>` in a pre-existing Dockerfile, if any. */
async function portFromDockerfile(componentPath: string): Promise<number | null> {
  const raw = await readFileIfExists(join(componentPath, 'Dockerfile'));
  const match = raw === null ? null : /^\s*EXPOSE\s+(\d{2,5})/m.exec(raw);
  if (match?.[1]) {
    const port = Number(match[1]);
    if (isValidPort(port)) return port;
  }
  return null;
}

/** Ports grep'd from source files (bounded scan), in discovery order. */
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
        if (isValidPort(port)) found.push(port);
      }
    }
  }
  return found;
}

/** The conventional dev-server port when nothing explicit was found. */
async function defaultPortFor(componentPath: string, role: ComponentRole): Promise<number> {
  if (role === 'backend') {
    // Django repos default to runserver's 8000; Node backends to 3000.
    const isDjango =
      (await readFileIfExists(join(componentPath, 'manage.py'))) !== null ||
      (await readFileIfExists(join(componentPath, 'requirements.txt'))) !== null;
    return isDjango ? 8000 : 3000;
  }
  if (role === 'frontend') {
    // Vite dev server (ORCA's supported React setup) defaults to 5173; CRA to 3000.
    const pkg = await readFileIfExists(join(componentPath, 'package.json'));
    const usesVite = pkg !== null && pkg.includes('"vite"');
    return usesVite ? 5173 : 3000;
  }
  return 3000;
}

/** Combine explicit ports found in env/dockerfile/code with the framework default. */
export async function detectPorts(
  componentPath: string,
  role: ComponentRole
): Promise<DetectedPort[]> {
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

  const fromDockerfile = await portFromDockerfile(componentPath);
  if (fromDockerfile !== null) add(fromDockerfile, 'dockerfile');

  for (const port of await portsFromCode(componentPath)) add(port, 'code');

  if (ports.length === 0) add(await defaultPortFor(componentPath, role), 'default');

  return ports;
}
