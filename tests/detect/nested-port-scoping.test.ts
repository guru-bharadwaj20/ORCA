/**
 * Port scoping at a monorepo root whose packages nest one level deeper than a manifest.
 *
 * `nestedComponentDirs` used to stop at FIRST-LEVEL subdirectories holding a manifest.
 * That is the flat `client/` + `server/` shape. A pnpm/turbo layout puts its packages at
 * `packages/api/package.json` — `packages/` itself holds no manifest, so the first-level
 * check walked straight through it, descended into `packages/api`, and handed that
 * package's ports back to the root. Every role path gates on `declaredPorts`, so the root
 * of the single most common real-world monorepo shape could never be anything but a
 * service.
 *
 * The declared workspace globs are what close it: `expandWorkspaceGlobs` already resolves
 * exactly these directories, so the exclusion is read off what the repo says about itself
 * rather than guessed at by descending further.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectComponentRole } from '../../src/detect/componentRole.js';
import { readAllDependencies } from '../../src/detect/manifest.js';
import { declaredPorts } from '../../src/detect/ports.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const PACKAGES_REPO = fixture('pnpm-packages-repo');

describe('a packages/* monorepo root', () => {
  it('declares no ports of its own', async () => {
    // Before the workspace-glob exclusion this was [4010, 4173] — the api's and the web
    // app's, inherited through the manifest-less `packages/` and `apps/` directories.
    expect(await declaredPorts(PACKAGES_REPO)).toEqual([]);
  });

  it('can therefore resolve to a role other than service', async () => {
    // The consequence, and the reason the scoping matters at all: with a port attached,
    // `detectComponentRole`'s master gate returns null for the root unconditionally.
    const detection = await detectComponentRole(PACKAGES_REPO, {
      dependencies: await readAllDependencies(PACKAGES_REPO),
      declaredPorts: (await declaredPorts(PACKAGES_REPO)).map((p) => p.port),
    });

    expect(detection?.role).toBe('library');
  });
});

describe('each nested package keeps its own ports', () => {
  it('keeps the api package on its own port', async () => {
    expect(await declaredPorts(join(PACKAGES_REPO, 'packages', 'api'))).toEqual([
      { port: 4010, protocol: 'tcp', source: 'code' },
    ]);
  });

  it('keeps the web package on its own port', async () => {
    expect(await declaredPorts(join(PACKAGES_REPO, 'apps', 'web'))).toEqual([
      { port: 4173, protocol: 'tcp', source: 'code' },
    ]);
  });
});

describe('the one-level case stays green', () => {
  it('still scopes a flat client/server workspace root', async () => {
    // The shape the original fix was written for. Excluding MORE must not stop the
    // first-level exclusion from applying — nor start applying to a repo that declares
    // no workspaces at all.
    expect(await declaredPorts(fixture('react-express-nodb-repo'))).toEqual([]);
    expect(await declaredPorts(fixture('mixed-roles-repo'))).toEqual([]);
  });

  it('leaves a single-component repo reporting its own port', async () => {
    // The guard against over-exclusion: a repo with no workspace config must be scanned
    // exactly as before, source subtrees included.
    expect(await declaredPorts(fixture('multiport-express-repo'))).not.toEqual([]);
  });
});
