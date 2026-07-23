import type { DetectionResult } from '../detect/types.js';
import type { CostLedger } from '../core/context.js';
import type { TemplateDescriptor } from '../templates/registry.js';
import { ai, type AIFacade } from './client.js';
import { buildFillPrompt } from './prompts/fill.js';
import { FilledTemplateVarsSchema, type FilledTemplateVars } from './schema.js';

export async function fillTemplate(
  detection: DetectionResult,
  template: TemplateDescriptor,
  readme: string,
  ledger: CostLedger,
  client: AIFacade = ai
): Promise<FilledTemplateVars> {
  const prompt = buildFillPrompt(detection, readme);

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
