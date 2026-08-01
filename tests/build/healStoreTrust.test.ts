/**
 * The heal-override store as a TRUST BOUNDARY.
 *
 * `~/.orca/heal-overrides.json` is a file on the user's disk that ORCA later writes
 * straight into a Dockerfile it then builds. Two things were wrong with treating it as
 * trusted:
 *
 *   1. It was parsed with `JSON.parse(...) as StoreFile` — an assertion, not a check — so
 *      a hand-edited or half-written file produced a record whose `recipeFingerprint` was
 *      undefined. `overrideMatchesShape` then read `.length` off it and threw, killing a
 *      run whose stack had ALREADY been built successfully.
 *   2. Live heal patches are scanned for privilege-escalating directives before being
 *      written; replayed overrides were not, purely because the text came from disk.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HealOverrideStore,
  applyLearnedOverride,
  overrideMatchesShape,
  type HealOverrideRecord,
} from '../../src/build/healStore.js';
import type { RunContext } from '../../src/core/context.js';

let home: string;
let workspace: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-store-'));
  workspace = await mkdtemp(join(tmpdir(), 'orca-ws-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

/** Write a raw store file, bypassing the store's own writer. */
async function writeStore(contents: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'heal-overrides.json'), contents, 'utf8');
}

function record(overrides: Partial<HealOverrideRecord> = {}): HealOverrideRecord {
  return {
    version: 1,
    signature: 'sig',
    repoId: 'github.com/x/y',
    languages: ['javascript'],
    frameworks: ['express'],
    recipeFingerprint: ['node-express'],
    files: [
      { path: 'Dockerfile', kind: 'dockerfile', original: 'FROM node:20', healed: 'FROM node:22' },
    ],
    changedSteps: ['Dockerfile'],
    explanation: 'bumped the base image',
    createdAt: '2026-08-01T00:00:00.000Z',
    orcaVersion: '0.1.0',
    ...overrides,
  };
}

function ctx(): RunContext {
  const warnings: string[] = [];
  return {
    workspaceDir: workspace,
    generatedFiles: [{ path: 'Dockerfile', kind: 'dockerfile' }],
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
    },
    // Only the fields `applyLearnedOverride` touches matter here.
    warnings,
  } as unknown as RunContext & { warnings: string[] };
}

describe('a malformed store never breaks a build', () => {
  it('drops a record missing the field the shape guard reads', async () => {
    // The exact crash: `overrideMatchesShape` -> `sameStrings(undefined, [...])` -> TypeError,
    // AFTER the stack had already built.
    const broken = record();
    delete (broken as Partial<HealOverrideRecord>).recipeFingerprint;
    await writeStore(JSON.stringify({ version: 1, records: { sig: broken } }));

    expect(await new HealOverrideStore(home).lookup('sig')).toBeNull();
  });

  it('drops a record whose files are not the shape the applier consumes', async () => {
    await writeStore(
      JSON.stringify({
        version: 1,
        records: { sig: record({ files: [{ path: 'Dockerfile' }] as never }) },
      })
    );

    expect(await new HealOverrideStore(home).lookup('sig')).toBeNull();
  });

  it('survives a records value that is an array, a null, or a scalar', async () => {
    for (const records of ['[]', 'null', '42', '"text"']) {
      await writeStore(`{"version":1,"records":${records}}`);
      await expect(new HealOverrideStore(home).lookup('sig')).resolves.toBeNull();
    }
  });

  it('survives a truncated file (a half-finished write)', async () => {
    await writeStore('{"version":1,"records":{"sig":{"signat');
    await expect(new HealOverrideStore(home).lookup('sig')).resolves.toBeNull();
  });

  it('still returns a well-formed record, and it still passes the shape guard', async () => {
    // The guard must not be so strict that it throws the feature away.
    await writeStore(JSON.stringify({ version: 1, records: { sig: record() } }));

    const stored = await new HealOverrideStore(home).lookup('sig');
    expect(stored).not.toBeNull();
    expect(
      overrideMatchesShape(stored!, {
        repoId: 'github.com/x/y',
        languages: ['javascript'],
        frameworks: ['express'],
        recipeFingerprint: ['node-express'],
      })
    ).toBe(true);
  });
});

describe('a replayed override is held to the live-patch content bar', () => {
  it('refuses to write a stored override carrying a privilege-escalating directive', async () => {
    const c = ctx();
    const applied = await applyLearnedOverride(
      c,
      record({
        files: [
          {
            path: 'Dockerfile',
            kind: 'dockerfile',
            original: 'FROM node:20',
            healed: 'FROM node:20\n# privileged: true\n',
          },
        ],
      })
    );

    expect(applied).toEqual([]);
    expect((c as unknown as { warnings: string[] }).warnings.join(' ')).toContain(
      'privilege-escalating'
    );
  });

  it('still applies an ordinary stored override', async () => {
    const applied = await applyLearnedOverride(ctx(), record());
    expect(applied).toEqual(['Dockerfile']);
  });
});
