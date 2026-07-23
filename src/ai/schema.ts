import { z } from 'zod';

import { OrcaError } from '../utils/errors.js';

const splitWords = (value: unknown): unknown =>
  typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;

const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>\\\n\r'"]/;

const COMMAND_BINARIES = new Set([
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'node',
  'python',
  'python3',
  'pip',
  'pip3',
  'poetry',
  'gunicorn',
  'uvicorn',
  'daphne',
  'vite',
  'serve',
]);

const BASE_IMAGE = /^(node|python):[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SYSTEM_PACKAGE = /^[a-z0-9][a-z0-9.+-]*$/;
const RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;

function hasTraversal(path: string): boolean {
  return path.split('/').includes('..');
}

const shellCommand = z
  .string()
  .min(1)
  .refine((value) => !SHELL_METACHARACTERS.test(value), {
    message:
      'must not contain shell metacharacters (; & | ` $ ( ) { } [ ] < > \\ quotes or newlines)',
  })
  .refine((value) => COMMAND_BINARIES.has(value.trim().split(/\s+/)[0] ?? ''), {
    message: `must start with a supported binary (${[...COMMAND_BINARIES].join(', ')})`,
  });

const relativePath = z
  .string()
  .min(1)
  .refine((value) => RELATIVE_PATH.test(value) && !hasTraversal(value), {
    message: 'must be a relative path inside the build context, without ".." segments',
  });

export const FilledTemplateVarsSchema = z.object({
  variables: z.object({
    baseImage: z
      .string()
      .min(1)
      .regex(BASE_IMAGE, {
        message: 'must be an official node:* or python:* image tag',
      })
      .optional(),
    workdir: z
      .string()
      .min(1)
      .refine((value) => ABSOLUTE_PATH.test(value) && !hasTraversal(value), {
        message: 'must be an absolute path without ".." segments',
      })
      .optional(),
    packageManager: z.enum(['npm', 'yarn', 'pnpm', 'pip', 'poetry']).optional(),
    dependencyFiles: z.preprocess(splitWords, z.array(relativePath)).optional(),
    installCommand: shellCommand.optional(),
    buildCommand: shellCommand.optional(),
    startCommand: shellCommand.optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    systemPackages: z
      .preprocess(
        splitWords,
        z.array(z.string().regex(SYSTEM_PACKAGE, { message: 'must be a plain apt package name' }))
      )
      .optional(),
    entrypointScript: relativePath.optional(),
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
