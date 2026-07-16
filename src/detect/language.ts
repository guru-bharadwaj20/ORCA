/**
 * Detects the primary programming language(s) in a repo from file extensions and
 * manifest files (package.json, requirements.txt, pyproject.toml, etc.). NO AI.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute repo path.
 * Outputs: the set of `Language`s found in the repo, most-seen first.
 */

import { basename, extname } from 'node:path';

import { walk } from '../utils/fs.js';
import type { Language } from './types.js';

const EXTENSION_LANGUAGE: Record<string, Exclude<Language, 'unknown'>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

/** Manifest files that reveal a language even when no source files were found yet. */
const MANIFEST_LANGUAGE: Record<string, Exclude<Language, 'unknown'>> = {
  'package.json': 'javascript',
  'tsconfig.json': 'typescript',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'manage.py': 'python',
  'setup.py': 'python',
};

/**
 * Scan the tree and classify by extension + manifest presence. Returns the languages
 * ordered by how much evidence was seen (file counts), or `['unknown']` when nothing
 * in the tree is a language ORCA can reason about.
 */
export async function detectLanguages(repoPath: string): Promise<Language[]> {
  const counts = new Map<Exclude<Language, 'unknown'>, number>();
  const bump = (lang: Exclude<Language, 'unknown'>): void => {
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  };

  for (const file of await walk(repoPath)) {
    const byManifest = MANIFEST_LANGUAGE[basename(file)];
    if (byManifest) bump(byManifest);
    const byExtension = EXTENSION_LANGUAGE[extname(file)];
    if (byExtension) bump(byExtension);
  }

  if (counts.size === 0) return ['unknown'];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => lang);
}
