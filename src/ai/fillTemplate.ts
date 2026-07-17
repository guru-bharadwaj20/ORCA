/**
 * Uses the LLM to fill the variables a chosen template needs, using the detection
 * result + README as grounding. The template shape is fixed by us; the AI only
 * supplies values (base image tags, install/build commands, working dirs, etc.).
 *
 * STAGE: 3 (ai) — REAL code.
 * Inputs: a `DetectionResult`, the target template descriptor, and README text.
 * Outputs: validated `FilledTemplateVars` ready to render the template with.
 */

import type { DetectionResult } from '../detect/types.js';
import type { CostLedger } from '../core/context.js';
import type { TemplateDescriptor } from '../templates/registry.js';
import { ai, type AIFacade } from './client.js';
import { buildFillPrompt } from './prompts/fill.js';
import { FilledTemplateVarsSchema, type FilledTemplateVars } from './schema.js';

/** Build the fill prompt and run it through the provider router (validated). */
export async function fillTemplate(
  detection: DetectionResult,
  template: TemplateDescriptor,
  readme: string,
  ledger: CostLedger,
  client: AIFacade = ai
): Promise<FilledTemplateVars> {
  const prompt = buildFillPrompt(detection, readme);

  // Anchor the model on the chosen template + its deterministic defaults, so it
  // refines known-good values instead of inventing a config from scratch.
  const user = [
    prompt.user,
    '',
    '## Chosen template',
    template.template,
    '',
    '## Default variables (refine these; only change what the repo justifies)',
    JSON.stringify(template.defaults, null, 2),
  ].join('\n');

  return client.complete({ system: prompt.system, user }, FilledTemplateVarsSchema, ledger, {
    schemaName: 'FilledTemplateVars',
  });
}
