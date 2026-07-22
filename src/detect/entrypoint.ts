import { join } from 'node:path';

import { readFileIfExists } from '../utils/fs.js';
import { readPackageJson } from './manifest.js';
import { detectPackageManager } from './packageManager.js';
import type { Entrypoint, ComponentRole } from './types.js';

const START_SCRIPTS = ['dev', 'start', 'serve'] as const;

function runScriptCommand(manager: string, script: string): string {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'pnpm') return `pnpm run ${script}`;
  return `npm run ${script}`;
}

export async function detectEntrypoint(
  componentPath: string,
  role: ComponentRole
): Promise<Entrypoint | null> {
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

  const procfile = await readFileIfExists(join(componentPath, 'Procfile'));
  const webLine = procfile === null ? null : /^web:\s*(.+)$/m.exec(procfile);
  if (webLine?.[1]) {
    return { role, command: webLine[1].trim(), workingDir: '.', source: 'procfile' };
  }

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
