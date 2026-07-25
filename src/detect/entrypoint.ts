import { join } from 'node:path';

import { claim, type Claim } from '../model/claim.js';
import { readFileIfExists } from '../utils/fs.js';
import { entrypointFact, type EntrypointFact } from './detectors/facts.js';
import { readPackageJson } from './manifest.js';
import { detectPackageManager } from './packageManager.js';
import type { Entrypoint, ComponentRole } from './types.js';

/**
 * How much each entrypoint source is worth. A `Procfile web:` line and a package script
 * are the maintainer stating the start command outright; `manage.py` is a framework
 * convention ORCA applies on the maintainer's behalf, so it is strong but inferred.
 */
const SOURCE_WEIGHT: Record<Entrypoint['source'], number> = {
  'package-json-script': 0.85,
  procfile: 0.9,
  'manage-py': 0.7,
  // Prose describing how to run the app, and a pure convention guess: both real signals,
  // both weaker than the maintainer declaring a command in a file meant to be executed.
  readme: 0.5,
  inferred: 0.3,
};

/** Human-readable justification per source, surfaced verbatim as reasoning. */
const SOURCE_SIGNAL: Record<Entrypoint['source'], string> = {
  'package-json-script': 'package.json declares a start script',
  procfile: 'Procfile declares a web: process',
  'manage-py': 'manage.py present — Django runserver convention',
  readme: 'README documents the start command',
  inferred: 'inferred from project shape (no declared start command)',
};

const START_SCRIPTS = ['dev', 'start', 'serve'] as const;

function runScriptCommand(manager: string, script: string): string {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'pnpm') return `pnpm run ${script}`;
  return `npm run ${script}`;
}

/**
 * The entrypoint for a component, with the signal that decided it.
 *
 * `Entrypoint.source` already recorded WHERE the command came from; this promotes that
 * provenance into real `Evidence` so it reaches the reasoning trail rather than staying an
 * internal tag nothing surfaced.
 */
export async function entrypointClaim(
  componentPath: string,
  role: ComponentRole
): Promise<Claim<EntrypointFact> | null> {
  const entrypoint = await detectEntrypoint(componentPath, role);
  if (entrypoint === null) return null;
  return claim(
    entrypointFact(entrypoint),
    [
      {
        detector: 'entrypoint',
        family: 'entrypoint',
        signal: `${SOURCE_SIGNAL[entrypoint.source]} (${entrypoint.command})`,
        weight: SOURCE_WEIGHT[entrypoint.source],
      },
    ],
    'deterministic'
  );
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
