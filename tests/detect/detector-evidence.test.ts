import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { packageManagerClaim } from '../../src/detect/packageManager.js';
import { entrypointClaim } from '../../src/detect/entrypoint.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-evidence-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

describe('packageManagerClaim', () => {
  it('explains a lockfile decision and rates it near-definitive', async () => {
    const dir = await repo({ 'package.json': '{}', 'pnpm-lock.yaml': 'lockfileVersion: 6\n' });

    const c = await packageManagerClaim(dir);

    expect(c?.value.packageManager).toBe('pnpm');
    expect(c?.evidence[0]?.signal).toBe('pnpm-lock.yaml present');
    expect(c?.confidence).toBeGreaterThan(0.9);
  });

  it('rates a bare manifest as a genuine guess, not a certainty', async () => {
    const dir = await repo({ 'package.json': '{}' });

    const c = await packageManagerClaim(dir);

    // The old code returned a bare 'npm' here, indistinguishable from a lockfile answer.
    expect(c?.value.packageManager).toBe('npm');
    expect(c?.confidence).toBeLessThan(0.6);
    expect(c?.evidence[0]?.signal).toContain('assuming npm');
  });

  it('explains a declared build system', async () => {
    const dir = await repo({ 'pyproject.toml': '[tool.poetry]\nname="x"\n' });

    const c = await packageManagerClaim(dir);

    expect(c?.value.packageManager).toBe('poetry');
    expect(c?.evidence[0]?.signal).toContain('[tool.poetry]');
  });

  it('returns null rather than inventing evidence for a non-answer', async () => {
    await expect(packageManagerClaim(await repo({ 'README.md': '# x' }))).resolves.toBeNull();
  });
});

describe('entrypointClaim', () => {
  it('promotes the entrypoint source into evidence', async () => {
    const dir = await repo({ Procfile: 'web: node server.js\n' });

    const c = await entrypointClaim(dir, 'backend');

    expect(c?.value.entrypoint.command).toBe('node server.js');
    expect(c?.evidence[0]?.signal).toContain('Procfile declares a web: process');
  });

  it('rates a convention lower than a declared command', async () => {
    const declared = await entrypointClaim(await repo({ Procfile: 'web: node s.js\n' }), 'backend');
    const convention = await entrypointClaim(await repo({ 'manage.py': '' }), 'backend');

    expect(convention?.confidence).toBeLessThan(declared?.confidence ?? 1);
  });

  it('is null when nothing declares a start command', async () => {
    await expect(
      entrypointClaim(await repo({ 'README.md': '# x' }), 'backend')
    ).resolves.toBeNull();
  });
});

describe('reasoning trail', () => {
  it('explains the per-component detectors that were previously silent', async () => {
    const dir = await repo({
      'package.json': JSON.stringify({
        name: 'api',
        scripts: { start: 'node s.js' },
        dependencies: { express: '^4' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 6\n',
      's.js': 'require("express")().listen(3000)',
    });

    const trail = (await detectStack(dir)).reasoning.join('\n');

    // Previously these produced bare values with nothing in the trail explaining them.
    expect(trail).toContain('package manager pnpm');
    expect(trail).toContain('package-json-script');
  });
});
