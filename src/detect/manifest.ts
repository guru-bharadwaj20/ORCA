import { join } from 'node:path';

import { readFileIfExists } from '../utils/fs.js';

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** npm's `bin` field: a string for a single binary, or a name→path map. Marks a CLI. */
  bin?: string | Record<string, string>;
}

export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const raw = await readFileIfExists(join(dir, 'package.json'));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

export async function readNodeDependencies(dir: string): Promise<string[]> {
  const pkg = await readPackageJson(dir);
  if (pkg === null) return [];
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

function normalizePythonSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('-')) return null;
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(trimmed);
  return match ? match[0].toLowerCase() : null;
}

async function readRequirementsTxt(dir: string): Promise<string[]> {
  const raw = await readFileIfExists(join(dir, 'requirements.txt'));
  if (raw === null) return [];
  return raw
    .split('\n')
    .map(normalizePythonSpec)
    .filter((name): name is string => name !== null);
}

async function readPyprojectDependencies(dir: string): Promise<string[]> {
  const raw = await readFileIfExists(join(dir, 'pyproject.toml'));
  if (raw === null) return [];
  const names: string[] = [];

  const poetryTable = /\[tool\.poetry\.dependencies\]([^[]*)/.exec(raw);
  if (poetryTable?.[1]) {
    for (const line of poetryTable[1].split('\n')) {
      const pair = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      const name = pair?.[1]?.toLowerCase();
      if (name && name !== 'python') names.push(name);
    }
  }

  const pep621 = /^\s*dependencies\s*=\s*\[([^\]]*)\]/m.exec(raw);
  if (pep621?.[1]) {
    for (const quoted of pep621[1].matchAll(/["']([^"']+)["']/g)) {
      const name = normalizePythonSpec(quoted[1] ?? '');
      if (name !== null) names.push(name);
    }
  }

  return names;
}

export async function readPythonDependencies(dir: string): Promise<string[]> {
  const [requirements, pyproject] = await Promise.all([
    readRequirementsTxt(dir),
    readPyprojectDependencies(dir),
  ]);
  return [...new Set([...requirements, ...pyproject])];
}

export async function readAllDependencies(dir: string): Promise<string[]> {
  const [node, python] = await Promise.all([
    readNodeDependencies(dir),
    readPythonDependencies(dir),
  ]);
  return [...new Set([...node, ...python])];
}
