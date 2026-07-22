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

const MANIFEST_LANGUAGE: Record<string, Exclude<Language, 'unknown'>> = {
  'package.json': 'javascript',
  'tsconfig.json': 'typescript',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'manage.py': 'python',
  'setup.py': 'python',
};

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
