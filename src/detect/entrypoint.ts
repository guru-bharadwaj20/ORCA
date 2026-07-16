/**
 * Detects the start command for a component: package.json scripts (start/dev/serve),
 * a Procfile, or `manage.py runserver` for Django. NO AI.
 *
 * STAGE: 2 (detect) — REAL code.
 * Inputs: an absolute component root path + its detected role.
 * Outputs: an `Entrypoint` (command + working dir + source) or null.
 *
 * NOTE: `workingDir` is returned as `'.'` (the component root itself); the aggregator
 * in index.ts rewrites it to the component's repo-relative rootDir.
 */

import { join } from 'node:path';

import { readFileIfExists } from '../utils/fs.js';
import { readPackageJson } from './manifest.js';
import { detectPackageManager } from './packageManager.js';
import type { Entrypoint, ComponentRole } from './types.js';

/** Scripts that start a dev server, in preference order (dev beats start beats serve). */
const START_SCRIPTS = ['dev', 'start', 'serve'] as const;

/** How to invoke a package.json script with the component's package manager. */
function runScriptCommand(manager: string, script: string): string {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'pnpm') return `pnpm run ${script}`;
  return `npm run ${script}`;
}

/** Resolve the most likely start command and record where it came from. */
export async function detectEntrypoint(
  componentPath: string,
  role: ComponentRole
): Promise<Entrypoint | null> {
  // 1. package.json scripts — the most explicit statement of intent in Node repos.
  const pkg = await readPackageJson(componentPath);
  const scripts = pkg?.scripts ?? {};
  for (const script of START_SCRIPTS) {
    if (typeof scripts[script] === 'string' && scripts[script].trim() !== '') {
      const manager = await detectPackageManager(componentPath);
      return {
        role,
        command: runScriptCommand(manager, script),
        workingDir: '.',
        source: 'package-json-script',
      };
    }
  }

  // 2. Procfile `web:` line (Heroku-style student repos).
  const procfile = await readFileIfExists(join(componentPath, 'Procfile'));
  const webLine = procfile === null ? null : /^web:\s*(.+)$/m.exec(procfile);
  if (webLine?.[1]) {
    return { role, command: webLine[1].trim(), workingDir: '.', source: 'procfile' };
  }

  // 3. Django's manage.py — dev-mode runserver, bound so Docker can reach it.
  if ((await readFileIfExists(join(componentPath, 'manage.py'))) !== null) {
    return {
      role,
      command: 'python manage.py runserver 0.0.0.0:8000',
      workingDir: '.',
      source: 'manage-py',
    };
  }

  return null;
}
