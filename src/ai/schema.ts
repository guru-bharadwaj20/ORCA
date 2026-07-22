import { z } from 'zod';

import { OrcaError } from '../utils/errors.js';

const stringList = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value),
  z.array(z.string())
);

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

function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}

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
