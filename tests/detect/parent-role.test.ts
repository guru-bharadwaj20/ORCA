/**
 * Role resolution at a MONOREPO PARENT, and for every quiet role sitting beside a
 * listening one.
 *
 * This is the test that was missing when the bug it guards was live. All three role paths
 * gate on `declaredPorts` — `detectComponentRole`'s master gate ("declares a port ⇒ it is
 * a service"), `jobDetector`, and `libraryDetector` — and `portsFromCode` used to walk
 * recursively, so a parent directory inherited its children's ports and could never
 * resolve to `worker`/`cli`/`library`/`job`. The scan is scoped to the component now, but
 * nothing asserted a role at a parent, which is exactly why the bug survived a full test
 * suite.
 *
 * So the facts here are read FROM DISK rather than hand-passed: `declaredPorts` is the
 * value under test as much as the role is, and a test that supplies `declaredPorts: []`
 * by hand would have passed throughout the entire period the bug was live.
 *
 * `mixed-roles-repo` puts a worker, a cli, and a library beside a listening service under
 * one workspace root, so each rule is exercised with the others present to contaminate it.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectComponentRole } from '../../src/detect/componentRole.js';
import { readAllDependencies } from '../../src/detect/manifest.js';
import { declaredPorts } from '../../src/detect/ports.js';

const REPO = fileURLToPath(new URL('../fixtures/mixed-roles-repo', import.meta.url));

/** Resolve a component's role from what is genuinely on disk at that directory. */
async function roleAt(...segments: string[]): Promise<string | null> {
  const dir = join(REPO, ...segments);
  const detection = await detectComponentRole(dir, {
    dependencies: await readAllDependencies(dir),
    declaredPorts: (await declaredPorts(dir)).map((p) => p.port),
  });
  return detection?.role ?? null;
}

describe('role detection at a monorepo parent', () => {
  it('resolves the workspace root itself, rather than inheriting a child port', async () => {
    // The regression in one assertion. The root ships `{ private, workspaces }` and
    // nothing else: no bin, no start script, no entry module. Before port scoping it
    // reported its children's ports (4300 here), the master gate read that as "this
    // listens", and the root came back null — an unclassifiable phantom service.
    expect(await declaredPorts(REPO)).toEqual([]);
    expect(await roleAt()).toBe('library');
  });

  it('names the parent role from evidence, not from a workspace special case', async () => {
    const detection = await detectComponentRole(REPO, {
      dependencies: await readAllDependencies(REPO),
      declaredPorts: (await declaredPorts(REPO)).map((p) => p.port),
    });

    // Nothing here keys off `workspaces`; the claim is the ordinary Node library rule,
    // which is what makes it hold for a Go/Rust/Python parent too.
    expect(detection?.signal).toContain('no bin, no start/dev/serve script, and no entry module');
  });
});

describe('quiet roles beside a listening sibling', () => {
  it('resolves the worker by its own start command', async () => {
    expect(await roleAt('worker')).toBe('worker');
  });

  it('resolves the cli by its own bin', async () => {
    expect(await roleAt('cli')).toBe('cli');
  });

  it('resolves the library by its own absence of an entrypoint', async () => {
    expect(await roleAt('lib')).toBe('library');
  });

  it('leaves the listening sibling a service, unaffected by any of them', async () => {
    // The control. `api` really does listen, so the master gate must decline to
    // reclassify it — and its own port must survive the scoping that silences the root.
    expect(await declaredPorts(join(REPO, 'api'))).toEqual([
      { port: 4300, protocol: 'tcp', source: 'code' },
    ]);
    expect(await roleAt('api')).toBeNull();
  });

  it('gives each sibling its own role rather than one shared verdict', async () => {
    // Four components, four different answers, from one repo — the point of the fixture.
    expect([
      await roleAt(),
      await roleAt('worker'),
      await roleAt('cli'),
      await roleAt('lib'),
      await roleAt('api'),
    ]).toEqual(['library', 'worker', 'cli', 'library', null]);
  });
});
