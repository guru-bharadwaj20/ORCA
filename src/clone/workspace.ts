import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { simpleGit } from 'simple-git';

import { OrcaError } from '../utils/errors.js';

export interface Workspace {
  dir: string;
  repoDir: string;
  source: string;
}

const COPY_EXCLUDE = new Set(['node_modules', '.git']);

function checkoutNameFor(source: string): string {
  const base = basename(source.replace(/\/+$/, ''))
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return base === '' ? 'repo' : base;
}

export async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-'));
  return { dir, repoDir: join(dir, 'repo'), source: '' };
}

async function isLocalDirectory(source: string): Promise<boolean> {
  try {
    return (await stat(source)).isDirectory();
  } catch {
    return false;
  }
}

export async function cloneRepo(
  repoUrl: string,
  workspace: Workspace,
  signal?: AbortSignal
): Promise<string> {
  workspace.repoDir = join(workspace.dir, checkoutNameFor(repoUrl));
  try {
    signal?.throwIfAborted();
    if (await isLocalDirectory(repoUrl)) {
      await cp(repoUrl, workspace.repoDir, {
        recursive: true,
        filter: (src) => !COPY_EXCLUDE.has(basename(src)),
      });
    } else {
      await simpleGit(signal !== undefined ? { abort: signal } : {}).clone(
        repoUrl,
        workspace.repoDir,
        ['--depth', '1']
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OrcaError(`Failed to clone '${repoUrl}': ${message}`, 'CLONE_FAILED');
  }
  workspace.source = repoUrl;
  return workspace.repoDir;
}

export async function cleanupWorkspace(workspace: Workspace): Promise<void> {
  await rm(workspace.dir, { recursive: true, force: true });
}
