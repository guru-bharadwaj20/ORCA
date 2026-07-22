/**
 * Manifest dependency readers for the Phase-B ecosystems (Go, Rust, JVM, .NET) — the
 * counterparts to `manifest.ts`'s Node/Python readers. Each is a light, dependency-free
 * scan sufficient to feed the framework-signature table (which only needs dependency
 * *names*, not resolved versions). Kept separate from `manifest.ts` so the original
 * seed-stack path is untouched.
 *
 * STAGE: 2 (detect) / PHASE B — REAL code. No AI.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readFileIfExists } from '../utils/fs.js';

/**
 * Go module dependencies from `go.mod` `require` directives. Handles both the block
 * form (`require (\n  path v1.2.3\n)`) and single-line `require path v1.2.3`. Returns
 * bare module paths (no version), e.g. `github.com/gin-gonic/gin`.
 */
export async function readGoDependencies(dir: string): Promise<string[]> {
  const raw = await readFileIfExists(join(dir, 'go.mod'));
  if (raw === null) return [];
  const deps: string[] = [];
  let inBlock = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && trimmed === ')') {
      inBlock = false;
      continue;
    }
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    // In-block lines are `path v1.2.3`; single-line form is `require path v1.2.3`.
    const spec = inBlock ? trimmed : trimmed.startsWith('require ') ? trimmed.slice(8).trim() : '';
    const path = spec.split(/\s+/)[0];
    if (path && path.includes('.')) deps.push(path);
  }
  return [...new Set(deps)];
}

/**
 * Rust crate dependencies from `Cargo.toml`'s `[dependencies]` / `[dev-dependencies]`
 * tables. Light line scan: `name = "1.0"` or `name = { version = "1.0" }`.
 */
export async function readRustDependencies(dir: string): Promise<string[]> {
  const raw = await readFileIfExists(join(dir, 'Cargo.toml'));
  if (raw === null) return [];
  const deps: string[] = [];
  let inDeps = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const table = /^\[([^\]]+)\]/.exec(trimmed);
    if (table) {
      inDeps = /dependencies$/.test(table[1] ?? '');
      continue;
    }
    if (!inDeps) continue;
    const pair = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed);
    if (pair?.[1]) deps.push(pair[1]);
  }
  return [...new Set(deps)];
}

/**
 * JVM dependencies. For Maven, scan `pom.xml` `<artifactId>` elements; for Gradle,
 * scan build files for `group:artifact:version` coordinates and `implementation`
 * declarations. Returns artifact ids (Maven) and coordinate strings (Gradle) — enough
 * for the signature table's `spring-boot-starter*` markers.
 */
export async function readJvmDependencies(dir: string): Promise<string[]> {
  const deps: string[] = [];

  const pom = await readFileIfExists(join(dir, 'pom.xml'));
  if (pom !== null) {
    for (const m of pom.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
      if (m[1]) deps.push(m[1].trim());
    }
  }

  for (const gradleFile of ['build.gradle', 'build.gradle.kts']) {
    const gradle = await readFileIfExists(join(dir, gradleFile));
    if (gradle === null) continue;
    for (const m of gradle.matchAll(/['"]([\w.-]+):([\w.-]+)(?::[\w.$-]+)?['"]/g)) {
      if (m[2]) deps.push(m[2]); // artifact id
      if (m[1]) deps.push(`${m[1]}`); // group id (matches org.springframework.boot)
    }
  }

  return [...new Set(deps)];
}

/**
 * .NET package references from any `*.csproj` at the component root:
 * `<PackageReference Include="Microsoft.AspNetCore..." />`.
 */
export async function readDotnetDependencies(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.csproj'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const deps: string[] = [];
  for (const name of entries) {
    const raw = await readFileIfExists(join(dir, name));
    if (raw === null) continue;
    for (const m of raw.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
      if (m[1]) deps.push(m[1]);
    }
  }
  return [...new Set(deps)];
}
