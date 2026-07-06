/**
 * Zod schemas for validating the LLM's structured output before it's trusted by the
 * rest of the pipeline. Keeps AI responses honest — anything that fails validation is
 * rejected rather than propagated into a plan or a Dockerfile.
 *
 * STAGE: 3 (ai)
 * Inputs: raw JSON strings/objects returned by the model.
 * Outputs: typed, validated objects (or a validation error).
 */

import { z } from 'zod';

/** Validated shape for AI-filled template variables. */
export const FilledTemplateVarsSchema = z.object({
  variables: z.record(z.string(), z.string()),
  notes: z.array(z.string()).default([]),
});
export type FilledTemplateVars = z.infer<typeof FilledTemplateVarsSchema>;

/** Validated shape for AI-inferred environment variables. */
export const InferredEnvSchema = z.object({
  variables: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      required: z.boolean().default(true),
      reason: z.string(),
    })
  ),
});
export type InferredEnv = z.infer<typeof InferredEnvSchema>;

/** Validated shape for a single self-heal suggestion from the model. */
export const HealSuggestionSchema = z.object({
  explanation: z.string(),
  fix: z.string(),
  patches: z.array(
    z.object({
      file: z.string(),
      contents: z.string(),
    })
  ),
});
export type HealSuggestion = z.infer<typeof HealSuggestionSchema>;

// TODO(stage-3): parse+validate a raw model response against the given schema,
// throwing a descriptive error on failure.
export function validateAgainst<T>(_schema: z.ZodType<T>, _raw: unknown): T {
  throw new Error('not implemented');
}
