/**
 * Detects the start command for a component: package.json scripts (start/dev/serve),
 * a Procfile, or `manage.py runserver` for Django. NO AI.
 *
 * STAGE: 2 (detect)
 * Inputs: an absolute component root path + its detected role.
 * Outputs: an `Entrypoint` (command + working dir + source) or null.
 */

import type { Entrypoint, ComponentRole } from './types.js';

// TODO(stage-2): resolve the most likely start command and record where it came from.
export async function detectEntrypoint(
  _componentPath: string,
  _role: ComponentRole
): Promise<Entrypoint | null> {
  throw new Error('not implemented');
}
