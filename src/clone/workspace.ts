/**
 * Git clone + temp workspace management. Creates an isolated scratch directory,
 * shallow-clones the target repo into it, and cleans up afterwards.
 *
 * STAGE: 0/1 (clone) — REAL code.
 * Inputs: a repo git URL (or local path) and options.
 * Outputs: an absolute workspace path containing the cloned repo; teardown handle.
 */

import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { simpleGit } from 'simple-git';

import { OrcaError } from '../utils/errors.js';

/** Where and how a target repo was materialized on disk. */
export interface Workspace {
  /** Absolute path to the temp workspace root. */
  dir: string;
  /** Absolute path to the cloned repo inside the workspace. */
  repoDir: string;
  /** The source that was cloned (set by `cloneRepo`). */
  source: string;
}

/** Directories never worth copying from a local source repo. */
const COPY_EXCLUDE = new Set(['node_modules', '.git']);

/**
 * Checkout directory name derived from the clone source, so everything downstream
 * that is named after the repo directory (e.g. the compose project name) reflects
 * the actual repo instead of a generic 'repo'.
 */
function checkoutNameFor(source: string): string {
  const base = basename(source.replace(/\/+$/, ''))
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return base === '' ? 'repo' : base;
}

/** Create a unique temp directory under the OS temp dir. */
export async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-'));
  return { dir, repoDir: join(dir, 'repo'), source: '' };
}

/** True when `source` is a directory that exists on disk (vs a git URL). */
async function isLocalDirectory(source: string): Promise<boolean> {
  try {
    return (await stat(source)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Materialize the target repo inside the workspace: local paths are copied
 * (skipping node_modules/.git — detection ignores them and they dominate size),
 * anything else is treated as a git URL and shallow-cloned. A run-level `signal`
 * aborts an in-flight clone (simple-git's `abort`) and the local copy (`cp`).
 */
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

/** Remove the workspace directory tree (idempotent). */
export async function cleanupWorkspace(workspace: Workspace): Promise<void> {
  await rm(workspace.dir, { recursive: true, force: true });
}
