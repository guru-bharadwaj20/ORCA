/**
 * Git clone + temp workspace management. Creates an isolated scratch directory,
 * shallow-clones the target repo into it, and cleans up afterwards.
 *
 * STAGE: 0/1 (clone)
 * Inputs: a repo git URL (or local path) and options.
 * Outputs: an absolute workspace path containing the cloned repo; teardown handle.
 */

/** Where and how a target repo was materialized on disk. */
export interface Workspace {
  /** Absolute path to the temp workspace root. */
  dir: string;
  /** Absolute path to the cloned repo inside the workspace. */
  repoDir: string;
  /** The source that was cloned. */
  source: string;
}

// TODO(stage-1): create a unique temp directory under the OS temp / .orca cache.
export async function createWorkspace(): Promise<Workspace> {
  throw new Error('not implemented');
}

// TODO(stage-1): shallow-clone (or copy, for local paths) the repo into the workspace.
export async function cloneRepo(_repoUrl: string, _workspace: Workspace): Promise<string> {
  throw new Error('not implemented');
}

// TODO(stage-1): remove the workspace directory tree.
export async function cleanupWorkspace(_workspace: Workspace): Promise<void> {
  throw new Error('not implemented');
}
