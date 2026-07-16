/**
 * Shared, AI-free manifest readers for the detect stage: package.json,
 * requirements.txt, and pyproject.toml. Every detector that needs "which direct
 * dependencies does this component declare?" goes through here so the parsing
 * quirks (version specifiers, extras, comments) live in exactly one place.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute component root path.
 * Outputs: parsed manifest objects / normalized dependency-name lists.
 */

import { join } from 'node:path';

import { readFileIfExists } from '../utils/fs.js';

/** The subset of package.json the detectors care about. */
export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Read and parse `<dir>/package.json`, or null when absent/unparseable. */
export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const raw = await readFileIfExists(join(dir, 'package.json'));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    // A broken package.json is a detection signal, not a crash: callers treat it
    // as "no manifest" and the aggregator surfaces the gap via warnings.
    return null;
  }
}

/** Direct Node dependency names (dependencies + devDependencies), or []. */
export async function readNodeDependencies(dir: string): Promise<string[]> {
  const pkg = await readPackageJson(dir);
  if (pkg === null) return [];
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

/**
 * Normalize one requirement/dependency spec to a bare, lowercase package name:
 * strips extras (`uvicorn[standard]`), version pins (`django==5.0`), and
 * environment markers (`; python_version < "3.12"`).
 */
function normalizePythonSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('-')) return null;
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(trimmed);
  return match ? match[0].toLowerCase() : null;
}

/** Dependency names from `<dir>/requirements.txt`, or []. */
async function readRequirementsTxt(dir: string): Promise<string[]> {
  const raw = await readFileIfExists(join(dir, 'requirements.txt'));
  if (raw === null) return [];
  return raw
    .split('\n')
    .map(normalizePythonSpec)
    .filter((name): name is string => name !== null);
}

/**
 * Dependency names from `<dir>/pyproject.toml`, or []. Intentionally a light
 * line-based scan (no TOML dependency): it reads the `[tool.poetry.dependencies]`
 * table keys and the PEP 621 `[project]` `dependencies = [...]` strings, which
 * covers the repos in ORCA's scope.
 */
async function readPyprojectDependencies(dir: string): Promise<string[]> {
  const raw = await readFileIfExists(join(dir, 'pyproject.toml'));
  if (raw === null) return [];
  const names: string[] = [];

  // [tool.poetry.dependencies] table: one `name = "spec"` pair per line.
  const poetryTable = /\[tool\.poetry\.dependencies\]([^[]*)/.exec(raw);
  if (poetryTable?.[1]) {
    for (const line of poetryTable[1].split('\n')) {
      const pair = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
      const name = pair?.[1]?.toLowerCase();
      if (name && name !== 'python') names.push(name);
    }
  }

  // PEP 621: dependencies = ["django>=5.0", "psycopg2-binary"]
  const pep621 = /^\s*dependencies\s*=\s*\[([^\]]*)\]/m.exec(raw);
  if (pep621?.[1]) {
    for (const quoted of pep621[1].matchAll(/["']([^"']+)["']/g)) {
      const name = normalizePythonSpec(quoted[1] ?? '');
      if (name !== null) names.push(name);
    }
  }

  return names;
}

/** Direct Python dependency names (requirements.txt + pyproject.toml), or []. */
export async function readPythonDependencies(dir: string): Promise<string[]> {
  const [requirements, pyproject] = await Promise.all([
    readRequirementsTxt(dir),
    readPyprojectDependencies(dir),
  ]);
  return [...new Set([...requirements, ...pyproject])];
}

/** Every direct dependency name a component declares, across both ecosystems. */
export async function readAllDependencies(dir: string): Promise<string[]> {
  const [node, python] = await Promise.all([
    readNodeDependencies(dir),
    readPythonDependencies(dir),
  ]);
  return [...new Set([...node, ...python])];
}
