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

import { OrcaError } from '../utils/errors.js';

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

/**
 * Strip a Markdown code fence (```json ... ```) if the model wrapped its JSON in one,
 * despite instructions not to. Returns the input unchanged otherwise.
 */
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

/**
 * Turn a raw model response into a parsed JSON value. Accepts either a JSON string
 * (optionally fenced) or an already-parsed object, which passes through unchanged.
 * Throws an `OrcaError` on malformed JSON.
 */
export function parseModelJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = stripCodeFence(raw);
  try {
    return JSON.parse(text);
  } catch {
    throw new OrcaError(
      `AI response is not valid JSON: ${text.slice(0, 200)}`,
      'AI_INVALID_RESPONSE'
    );
  }
}

/**
 * Parse + validate a raw model response against the given schema. Accepts either a
 * JSON string (optionally fenced) or an already-parsed object. Throws an `OrcaError`
 * with a descriptive message on malformed JSON or schema mismatch — invalid AI output
 * must never propagate into a plan or a Dockerfile.
 */
export function validateAgainst<Output, Input = Output>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  raw: unknown
): Output {
  const candidate = parseModelJson(raw);

  const result = schema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new OrcaError(`AI response failed schema validation: ${issues}`, 'AI_INVALID_RESPONSE');
  }
  return result.data;
}
