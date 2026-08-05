/**
 * The extension's pin on the core must be satisfiable by the core in this repo.
 *
 * `vscode-extension` depends on `orca-agent-cli` by published range. Inside the workspace npm
 * satisfies that range with a link to the root package and writes no registry entry into the
 * lockfile — so the moment the root version steps outside the range, npm must instead fetch
 * the real published core *and its entire dependency tree*, none of which is in the lock.
 * `npm ci` then fails with EUSAGE, listing a dozen packages nobody touched.
 *
 * That is what makes it worth a test: the failure surfaces at install time in CI, names
 * transitive dependencies rather than the two files actually in disagreement, and is invisible
 * to a local `npm test` because the already-installed tree keeps working. Releasing the core
 * without bumping this range has now broken `main` more than once. Same join shape as
 * [engines.test.ts] — two declarations, each correct alone, with nothing reconciling them.
 */
import { describe, expect, it } from 'vitest';

import extPkg from '../../vscode-extension/package.json' with { type: 'json' };
import rootPkg from '../../package.json' with { type: 'json' };

/** `[major, minor, patch]`, ignoring any prerelease suffix — releases here are plain triples. */
function parse(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error(`unparseable version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Caret satisfaction only, which is the single range form this pin has ever used. Anything
 * else throws rather than guessing — a silently-unrecognised range would make the assertion
 * below pass for the wrong reason, which is the one outcome worse than no test.
 */
function satisfiesCaret(version: string, range: string): boolean {
  if (!range.startsWith('^')) throw new Error(`expected a caret range, got: ${range}`);
  const [vMajor, vMinor, vPatch] = parse(version);
  const [rMajor, rMinor, rPatch] = parse(range.slice(1));

  if (vMajor !== rMajor) return false;
  // Below 1.0.0 npm treats the minor as the breaking position, so `^0.2.0` excludes 0.3.0 —
  // exactly the case that broke the 0.3.0 release.
  if (rMajor === 0 && vMinor !== rMinor) return false;
  if (vMinor !== rMinor) return vMinor > rMinor;
  return vPatch >= rPatch;
}

describe('the extension tracks the core version in this repo', () => {
  const range = extPkg.dependencies['orca-agent-cli'];

  it('pins a range the current core version satisfies', () => {
    // If this fails, bump the range in `vscode-extension/package.json` to match the new core
    // version and run `npm install` so the lockfile records a link rather than a download.
    expect(satisfiesCaret(rootPkg.version, range)).toBe(true);
  });

  it('rejects the mismatch that actually broke the build', () => {
    // Guards the guard: proves the check is capable of failing, using the real 0.2.0/0.3.0
    // pair rather than trusting a green result.
    expect(satisfiesCaret('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfiesCaret('0.2.0', '^0.2.0')).toBe(true);
    expect(satisfiesCaret('0.2.1', '^0.2.0')).toBe(true);
  });
});
