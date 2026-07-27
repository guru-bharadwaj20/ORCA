/**
 * Coverage and honesty guarantees for the bare-runtime fallback (P0/P1).
 *
 * Both were found by probing detection against real manifests rather than reading types,
 * so both are pinned end-to-end here rather than at the registry alone — the P0 bug was
 * only half in the registry: the recipe matched fine in isolation while `filesAt` never
 * surfaced `package.json`, so the fallback stayed unreachable through the detect path.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { declaredPorts } from '../../src/detect/ports.js';
import { detectComponentRole } from '../../src/detect/componentRole.js';
import { assessUnderstanding } from '../../src/detect/understanding.js';
import { synthesizeDockerfile } from '../../src/generate/synthesizeDockerfile.js';
import { ALL_RECIPES } from '../../src/model/recipes/index.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'bare-runtime-repo'
);

describe('bare-runtime fallback', () => {
  it('places a Node component whose framework no recipe names', async () => {
    const result = await detectStack(FIXTURE);

    // A bespoke http server on undici — no framework recipe names it. Before the fallback was registered this whole
    // repo detected as isSupported=false, confidence=0, placed=[].
    const gateway = result.insights.ecosystemComponents.find((c) => c.rootDir === 'gateway');
    expect(gateway?.recipeId).toBe('node-app');
    expect(result.isSupported).toBe(true);
  });

  it('reports the component it could not place', async () => {
    const result = await detectStack(FIXTURE);

    // `legacy` is a candidate root (manage.py is a manifest) that nothing places.
    const unplaced = result.warnings.filter((w) => w.code === 'unplaced-component');
    expect(unplaced.map((w) => w.message)).toEqual([expect.stringContaining("'legacy'")]);
  });

  it('grades the partial stack as partial, not success', async () => {
    const understanding = assessUnderstanding(await detectStack(FIXTURE));

    // The point of the pair: placing MORE (P0) must not mean claiming completeness (P1).
    expect(understanding.level).toBe('partial');
    expect(understanding.shouldEscalate).toBe(true);
    expect(understanding.gaps.some((g) => g.includes('legacy'))).toBe(true);
  });
});

describe('bare-runtime start command', () => {
  it('carries the start command the repo itself declares', async () => {
    const result = await detectStack(FIXTURE);

    // The fixture declares `start`, NOT `dev`. Detection already resolved this via
    // `detectEntrypoint`; the bug was that it never reached the plan.
    const gateway = result.insights.ecosystemComponents.find((c) => c.rootDir === 'gateway');
    expect(gateway?.startCommand).toBe('npm run start');
  });

  it('leaves the registered bare node recipe with no start command of its own', () => {
    // Empty means "unknown", which is what lets the repo's own command fill it. A
    // hardcoded `npm run dev` here emitted an image that built and then exited with
    // `Missing script: "dev"` on any repo whose only script is `start`.
    const bare = ALL_RECIPES.find((e) => e.recipe.id === 'node-app')?.recipe;

    expect(bare?.startCommand).toBe('');
    expect(synthesizeDockerfile(bare!)).not.toContain('npm run dev');
  });

  it('never lets the fallback shadow a framework recipe', () => {
    // The fallback matches on a manifest alone, so its LAST position is what keeps it
    // from swallowing every Node repo.
    const ids = ALL_RECIPES.map((e) => e.recipe.id);

    expect(ids.indexOf('node-app')).toBeGreaterThan(ids.indexOf('node-next'));
    expect(ids.indexOf('node-app')).toBeGreaterThan(ids.indexOf('node-react'));
    expect(ids.indexOf('node-app')).toBeGreaterThan(ids.indexOf('node-vite'));
  });
});

describe('bare fallback and workspace roots', () => {
  const MONOREPO = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'react-express-nodb-repo'
  );

  it('does not place a workspace root as a phantom service', async () => {
    const result = await detectStack(MONOREPO);

    // The root here is `{ "private": true, "workspaces": [...] }` — no deps, no scripts.
    // The bare fallback matches on a manifest ALONE, so without a guard it placed this
    // root as a service that would run `npm start` in a directory with nothing to start,
    // alongside the real client/server components from its own workspaces.
    expect(result.insights.ecosystemComponents).toEqual([]);
  });

  it('scopes a port scan to the component, not its children', async () => {
    // The ROOT CAUSE of the phantom. `portsFromCode` walks recursively, so the monorepo
    // root used to report [5173, 5000] — the client's port and the server's. Both
    // `detectComponentRole`'s master gate ("declares a port ⇒ it is a service") and
    // `libraryDetector`'s first check read `declaredPorts`, so a workspace root always
    // looked like a listening service and could never be recognized as a package
    // container. A directory with its own manifest is a different component.
    expect(await declaredPorts(MONOREPO)).toEqual([]);
  });

  it("leaves each real component's own ports intact", async () => {
    // The scoping fix must not cost detection: children still see their own ports.
    expect(await declaredPorts(join(MONOREPO, 'client'))).toEqual([
      { port: 5173, protocol: 'tcp', source: 'code' },
    ]);
    expect(await declaredPorts(join(MONOREPO, 'server'))).toEqual([
      { port: 5000, protocol: 'tcp', source: 'code' },
    ]);
  });

  it('suppresses the fallback by ROLE, not by a workspace special case', async () => {
    // The general rule: a bare fallback carries no evidence the directory runs anything,
    // so if the role detectors independently say `library` the two signals disagree and
    // nothing is placed. This covers Go/Rust/Python library shapes too, not just the
    // npm-workspaces spelling the first fix keyed on.
    const role = await detectComponentRole(MONOREPO, {
      dependencies: [],
      declaredPorts: [],
      startCommand: '',
    });

    expect(role?.role).toBe('library');
  });

  it('still places the real components from that monorepo', async () => {
    const result = await detectStack(MONOREPO);

    // The guard must not cost coverage — only the phantom.
    expect(result.components.map((c) => `${c.rootDir}:${c.framework}`).sort()).toEqual([
      'client:react',
      'server:express',
    ]);
  });
});
