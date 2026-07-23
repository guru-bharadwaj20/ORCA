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

/** Lenient string list: accepts a proper string[] or a space-separated string. */
const stringList = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value),
  z.array(z.string())
);

/**
 * Validated shape for AI-filled template variables. Mirrors `DockerfileVars`
 * field-for-field (every field optional — the model only supplies what it wants to
 * change), so downstream stages receive typed values, never a stringly-typed record.
 * Unknown keys are stripped by zod, which doubles as the variable-name whitelist.
 */
export const FilledTemplateVarsSchema = z.object({
  variables: z.object({
    baseImage: z.string().min(1).optional(),
    workdir: z.string().min(1).optional(),
    packageManager: z.enum(['npm', 'yarn', 'pnpm', 'pip', 'poetry']).optional(),
    dependencyFiles: stringList.optional(),
    installCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
    startCommand: z.string().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    systemPackages: stringList.optional(),
    entrypointScript: z.string().min(1).optional(),
  }),
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

/**
 * Validated shape for an AI-inferred build recipe (tier-3 detection fallback). The
 * model proposes how an unfamiliar repo is built/run; each field is validated before
 * it becomes an `ai`-sourced Claim (whose confidence is capped below determinism).
 * `reasoning` is required — an unexplained AI inference is rejected.
 */
export const InferredBuildSchema = z.object({
  runtime: z.string().min(1),
  packageManager: z.string().min(1).optional(),
  installCommands: stringList.default([]),
  buildCommands: stringList.default([]),
  startCommand: z.string().min(1),
  ports: z.preprocess(
    (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]),
    z.array(z.coerce.number().int().min(1).max(65535)).default([])
  ),
  reasoning: z.array(z.string()).min(1),
});
export type InferredBuild = z.infer<typeof InferredBuildSchema>;

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
