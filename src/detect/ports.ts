/**
 * Detects the port(s) a component listens on: framework defaults (React 3000,
 * Express 3000, Django 8000), `process.env.PORT` / settings, or a value grep'd from
 * source or the README. NO AI.
 *
 * STAGE: 2 (detect)
 * Inputs: an absolute component root path + its detected role.
 * Outputs: the list of `DetectedPort`s, each tagged with how it was found.
 */

import type { DetectedPort, ComponentRole } from './types.js';

// TODO(stage-2): combine framework defaults with any explicit port found in code/env.
export async function detectPorts(
  _componentPath: string,
  _role: ComponentRole
): Promise<DetectedPort[]> {
  throw new Error('not implemented');
}
