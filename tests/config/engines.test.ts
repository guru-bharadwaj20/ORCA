/**
 * The `engines.node` floor must be a promise ORCA can actually keep.
 *
 * `engines` is declarative and dependency floors are declarative, and nothing reconciles
 * them: npm warns on a mismatch rather than failing, so a dependency that quietly raises
 * its own floor leaves `engines` advertising a runtime the install no longer runs on. That
 * is exactly the join this repo keeps getting caught by — both halves individually correct,
 * the disagreement between them unowned.
 *
 * It bit us once: upgrading execa, chalk and commander moved their floors to Node 22 while
 * `engines` still said `>=20` and the README still promised Node 20. The failure surfaced
 * as `TEXT_ENCODINGS.union is not a function` — an import-time crash in a transitive file,
 * on the one CI leg that happened to still be there. This asserts the invariant directly,
 * so the next such upgrade fails as a one-line diff instead of a stack trace.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import rootPkg from '../../package.json' with { type: 'json' };

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Read straight off disk rather than through `require`: most of these packages declare an
 * `exports` map that does not expose `./package.json`, so resolution refuses the subpath.
 */
function manifestOf(dep: string): { engines?: { node?: string } } {
  const path = join(repoRoot, 'node_modules', dep, 'package.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { engines?: { node?: string } };
}

/**
 * Lowest major a range admits. Deliberately crude: these are `engines` fields, which in
 * practice are `>=X`, `^X || ^Y`, or `>=X.Y.Z`, never anything needing a real semver solver.
 * Erring low is safe here — it can only make the test miss a violation, never invent one.
 */
function lowestMajor(range: string): number {
  const majors = [...range.matchAll(/(\d+)(?:\.\d+)*/g)].map((m) => Number(m[1]));
  return majors.length > 0 ? Math.min(...majors) : 0;
}

/** The runtime dependencies that ship to users — devDependencies cannot break an install. */
const runtimeDeps = Object.keys(rootPkg.dependencies);

describe('the declared node floor supports every runtime dependency', () => {
  const ownFloor = lowestMajor(rootPkg.engines.node);

  it.each(runtimeDeps)('is not below what %s requires', (dep) => {
    const required = manifestOf(dep).engines?.node;
    // A dependency with no `engines` makes no demand, so it cannot be violated.
    if (required === undefined) return;

    expect(lowestMajor(required)).toBeLessThanOrEqual(ownFloor);
  });

  it('reads a floor at all, rather than passing on an unparsed range', () => {
    // Guards the test itself: if `lowestMajor` ever returned 0 for our own range, every
    // assertion above would pass vacuously and the file would protect nothing.
    expect(ownFloor).toBeGreaterThan(0);
  });
});
