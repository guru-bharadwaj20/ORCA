/**
 * Uses the LLM to fill the variables a chosen template needs, using the detection
 * result + README as grounding. The template shape is fixed by us; the AI only
 * supplies values (base image tags, install/build commands, working dirs, etc.).
 *
 * STAGE: 3 (ai)
 * Inputs: a `DetectionResult`, the target template descriptor, and README text.
 * Outputs: validated `FilledTemplateVars` ready to render the template with.
 */

import type { DetectionResult } from '../detect/types.js';
import type { CostLedger } from '../core/context.js';
import type { TemplateDescriptor } from '../templates/registry.js';
import type { FilledTemplateVars } from './schema.js';

// TODO(stage-3): build the fill prompt, call the client, validate with the schema.
export async function fillTemplate(
  _detection: DetectionResult,
  _template: TemplateDescriptor,
  _readme: string,
  _ledger: CostLedger
): Promise<FilledTemplateVars> {
  throw new Error('not implemented');
}
