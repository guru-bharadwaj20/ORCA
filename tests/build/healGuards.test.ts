/**
 * The two code-enforced guards on self-heal, at the strength they claim.
 *
 * Both were weaker than their own documentation:
 *   - the symlink guard `lstat`ed only the LEAF, but `lstat` resolves every directory
 *     above it first, so a symlinked PARENT (`sub/` -> outside) redirected a write to
 *     `sub/Dockerfile` straight past the check that existed to stop exactly that;
 *   - the privilege scan was regexes over source text, so any YAML spelling the regex did
 *     not anticipate — anchors and aliases being the obvious one — walked through.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { containsDangerousDirective, resolveAllowedRealPath } from '../../src/build/selfHeal.js';

/** Symlink creation needs elevation on Windows; skip only the cases that require one. */
async function canSymlink(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-symcheck-'));
  try {
    await mkdir(join(dir, 'target'));
    await symlink(join(dir, 'target'), join(dir, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const symlinksAvailable = await canSymlink();

describe('the workspace escape guard covers parent directories', () => {
  it.runIf(symlinksAvailable)('rejects a write through a symlinked parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-symparent-'));
    try {
      const workspace = join(root, 'ws');
      const outside = join(root, 'outside');
      await mkdir(workspace, { recursive: true });
      await mkdir(outside, { recursive: true });
      // `ws/sub` is a symlink out of the workspace. The generated file sits inside it, so
      // the leaf `ws/sub/Dockerfile` is an ordinary file and the old leaf-only lstat
      // passed it.
      await symlink(outside, join(workspace, 'sub'), 'dir');
      await writeFile(join(outside, 'Dockerfile'), 'FROM node:20');

      const allowlist = new Set(['sub/Dockerfile']);
      expect(await resolveAllowedRealPath(workspace, 'sub/Dockerfile', allowlist)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still allows an ordinary generated file in a real subdirectory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-symok-'));
    try {
      await mkdir(join(workspace, 'server'), { recursive: true });
      const allowlist = new Set(['server/Dockerfile']);

      // The guard must not cost the feature: a genuine nested build context still works,
      // and the leaf need not exist yet (the patch may be creating it).
      expect(
        await resolveAllowedRealPath(workspace, 'server/Dockerfile', allowlist)
      ).not.toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a path whose parent directory does not exist', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-symmissing-'));
    try {
      const allowlist = new Set(['nope/Dockerfile']);
      expect(await resolveAllowedRealPath(workspace, 'nope/Dockerfile', allowlist)).toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('the privilege scan reads structure, not spelling', () => {
  it('catches the plain form', () => {
    expect(containsDangerousDirective('services:\n  web:\n    privileged: true\n')).toBe(true);
  });

  it('catches the anchor/alias bypass a regex cannot see', () => {
    // The classic evasion: nothing in this document contains the text `privileged: true`.
    const yaml = ['x-flag: &on true', 'services:', '  web:', '    privileged: *on', ''].join('\n');

    expect(yaml).not.toMatch(/privileged\s*:\s*true/);
    expect(containsDangerousDirective(yaml)).toBe(true);
  });

  it('catches flow style and quoted values', () => {
    expect(containsDangerousDirective('services: { web: { privileged: true } }')).toBe(true);
    expect(containsDangerousDirective('services:\n  web:\n    network_mode: "host"\n')).toBe(true);
    expect(containsDangerousDirective("services:\n  web:\n    pid: 'host'\n")).toBe(true);
  });

  it('catches a host-root and docker-socket bind mount', () => {
    expect(containsDangerousDirective('services:\n  web:\n    volumes:\n      - "/:/host"\n')).toBe(
      true
    );
    expect(
      containsDangerousDirective(
        'services:\n  web:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'
      )
    ).toBe(true);
  });

  it('catches cap_add and friends anywhere in the document', () => {
    for (const key of [
      'cap_add:\n      - SYS_ADMIN',
      'security_opt:\n      - seccomp:unconfined',
    ]) {
      expect(containsDangerousDirective(`services:\n  web:\n    ${key}\n`)).toBe(true);
    }
  });

  it('lets an ordinary compose fix through', () => {
    const yaml = [
      'services:',
      '  web:',
      '    build: .',
      '    ports:',
      '      - "3000:3000"',
      '    environment:',
      '      NODE_ENV: development',
      '    volumes:',
      '      - ./src:/app/src',
      '',
    ].join('\n');

    expect(containsDangerousDirective(yaml)).toBe(false);
  });

  it('lets an ordinary Dockerfile through even though it is not YAML', () => {
    // A Dockerfile does not parse as a useful YAML mapping; the regex pass is the check,
    // and a parse failure must not be read as "dangerous".
    const dockerfile = ['FROM node:20-slim', 'WORKDIR /app', 'RUN npm ci', 'CMD npm start'].join(
      '\n'
    );

    expect(containsDangerousDirective(dockerfile)).toBe(false);
  });

  it('still catches a privileged directive smuggled into a Dockerfile comment', () => {
    // The regex pass keeps its original job for non-YAML content.
    expect(containsDangerousDirective('FROM node:20\n# privileged: true\n')).toBe(true);
  });
});
