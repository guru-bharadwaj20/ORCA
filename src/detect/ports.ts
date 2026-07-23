import { basename, extname, join } from 'node:path';

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

async function portFromDockerfile(componentPath: string): Promise<number | null> {
  const raw = await readFileIfExists(join(componentPath, 'Dockerfile'));
  const match = raw === null ? null : /^\s*EXPOSE\s+(\d{2,5})/m.exec(raw);
  if (match?.[1]) {
    const port = Number(match[1]);
    if (isValidPort(port)) return port;
  }
  return null;
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

async function defaultPortFor(componentPath: string, role: ComponentRole): Promise<number> {
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
  return 3000;
}

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
