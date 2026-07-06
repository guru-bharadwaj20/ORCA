/**
 * Orchestrates every stage end-to-end: clone -> detect -> fill templates (AI) ->
 * build plan -> review/approve -> generate configs -> build/run with self-heal.
 *
 * STAGE: core (drives all stages)
 * Inputs: a `RunContext` (repo URL + options + logger).
 * Outputs: a resolved `RunContext` with detection, plan, generated files, and the
 * full self-heal diagnosis populated; throws on unrecoverable failure.
 */

import type { RunContext } from './context.js';

// TODO(stage-core): call each stage in order, short-circuiting on --dry-run and on a
// rejected approval gate; keep the RunContext as the only shared state.
export async function runPipeline(_ctx: RunContext): Promise<RunContext> {
  throw new Error('not implemented');
}
