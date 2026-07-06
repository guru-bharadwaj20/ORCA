/**
 * Renders the selected templates with their filled variables and writes the final
 * Dockerfiles, docker-compose.yml, .dockerignore, and .env into the workspace.
 *
 * STAGE: generate (bridges plan -> build)
 * Inputs: a `RunContext` (plan, filled templates, inferred env, workspace dir).
 * Outputs: files written to disk; returns the list of `GeneratedFile`s.
 */

import type { RunContext } from '../core/context.js';
import type { GeneratedFile } from '../core/context.js';

// TODO(stage-5): render each template, write Dockerfiles + compose + env to the
// workspace, and return what was written (also recorded on ctx.generatedFiles).
export async function writeConfigs(_ctx: RunContext): Promise<GeneratedFile[]> {
  throw new Error('not implemented');
}
