/**
 * Detects the primary programming language(s) in a repo from file extensions and
 * manifest files (package.json, requirements.txt, pyproject.toml, etc.). NO AI.
 *
 * STAGE: 2 (detect)
 * Inputs: an absolute repo path.
 * Outputs: the set of `Language`s found in the repo.
 */

import type { Language } from './types.js';

// TODO(stage-2): scan the tree and classify by extension + manifest presence.
export async function detectLanguages(_repoPath: string): Promise<Language[]> {
  throw new Error('not implemented');
}
