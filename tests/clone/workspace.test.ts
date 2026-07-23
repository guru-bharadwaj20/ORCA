import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { cleanupWorkspace, cloneRepo, createWorkspace } from '../../src/clone/workspace.js';

const mernFixture = fileURLToPath(new URL('../fixtures/mern-repo', import.meta.url));

describe('clone workspace', () => {
  it('copies a local repo into an isolated workspace and cleans up', async () => {
    const workspace = await createWorkspace();
    expect(workspace.dir).toContain('orca-');

    try {
      const repoDir = await cloneRepo(mernFixture, workspace);

      expect(repoDir).toBe(workspace.repoDir);
      expect(workspace.source).toBe(mernFixture);
      expect(existsSync(join(repoDir, 'client', 'package.json'))).toBe(true);
      expect(existsSync(join(repoDir, 'server', 'index.js'))).toBe(true);
    } finally {
      await cleanupWorkspace(workspace);
    }

    expect(existsSync(workspace.dir)).toBe(false);
    await cleanupWorkspace(workspace);
  });

  it('skips node_modules and .git when copying a local repo', async () => {
    const source = await mkdtemp(join(tmpdir(), 'orca-test-src-'));
    const workspace = await createWorkspace();
    try {
      await writeFile(join(source, 'package.json'), '{"name":"x"}');
      await mkdir(join(source, 'node_modules', 'left-pad'), { recursive: true });
      await writeFile(join(source, 'node_modules', 'left-pad', 'index.js'), '');
      await mkdir(join(source, '.git'), { recursive: true });
      await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main');

      const repoDir = await cloneRepo(source, workspace);

      expect(existsSync(join(repoDir, 'package.json'))).toBe(true);
      expect(existsSync(join(repoDir, 'node_modules'))).toBe(false);
      expect(existsSync(join(repoDir, '.git'))).toBe(false);
    } finally {
      await cleanupWorkspace(workspace);
      await rm(source, { recursive: true, force: true });
    }
  });

  it('throws CLONE_FAILED for a source that is neither a directory nor a repo', async () => {
    const workspace = await createWorkspace();
    try {
      await expect(cloneRepo('/nonexistent/orca-no-such-repo', workspace)).rejects.toMatchObject({
        code: 'CLONE_FAILED',
      });
    } finally {
      await cleanupWorkspace(workspace);
    }
  });
});
