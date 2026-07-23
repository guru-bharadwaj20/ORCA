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

const splitWords = (value: unknown): unknown =>
  typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;

/**
 * Wrap a lone value into a list. Commands must NOT be split on whitespace — a
 * `startCommand` of "cargo build --release" is one command, not three.
 */
const asList = (value: unknown): unknown =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>\\\n\r'"]/;

/**
 * Every toolchain ORCA can legitimately invoke inside a build. Broad enough to cover
 * the ecosystem recipes (cargo/go/mvn/gradle/java/dotnet) as well as the seed stacks,
 * because the security property is the metacharacter guard below — this list only
 * stops a model naming something no supported stack would ever run.
 */
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
  'uv',
  'gunicorn',
  'uvicorn',
  'daphne',
  'vite',
  'serve',
  'cargo',
  'go',
  'mvn',
  'gradle',
  'java',
  'dotnet',
]);

/** `./server`, `./target/release/app`, `/app/server` — a compiled artifact to exec. */
const EXECUTABLE_PATH = /^\.?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const head = (command: string): string => command.trim().split(/\s+/)[0] ?? '';

const BASE_IMAGE = /^(node|python):[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SYSTEM_PACKAGE = /^[a-z0-9][a-z0-9.+-]*$/;
const RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;

function hasTraversal(path: string): boolean {
  return path.split('/').includes('..');
}

const NO_METACHARACTERS = {
  message:
    'must not contain shell metacharacters (; & | ` $ ( ) { } [ ] < > \\ quotes or newlines)',
} as const;

const shellCommand = z
  .string()
  .min(1)
  .refine((value) => !SHELL_METACHARACTERS.test(value), NO_METACHARACTERS)
  .refine((value) => COMMAND_BINARIES.has(head(value)), {
    message: `must start with a supported binary (${[...COMMAND_BINARIES].join(', ')})`,
  });

/**
 * A command proposed by tier-3 inference. Same guarantee as `shellCommand`: it is
 * built into a Dockerfile and executed, so chaining, substitution, pipes, redirects
 * and newlines are refused outright rather than trusted to the prompt.
 */
const inferredCommand = shellCommand;

/**
 * An inferred entrypoint. Compiled ecosystems exec an artifact rather than a
 * toolchain ("./target/release/app", "/app/server"), so a plain executable path is
 * allowed alongside a known binary — still with no shell metacharacters.
 */
const inferredStartCommand = z
  .string()
  .min(1)
  .refine((value) => !SHELL_METACHARACTERS.test(value), NO_METACHARACTERS)
  .refine((value) => COMMAND_BINARIES.has(head(value)) || EXECUTABLE_PATH.test(head(value)), {
    message: 'must start with a supported binary or an executable path inside the image',
  })
  .refine((value) => !head(value).split('/').includes('..'), {
    message: 'must not escape the image root with ".." segments',
  });

const stringList = z.preprocess(asList, z.array(inferredCommand));

const relativePath = z
  .string()
  .min(1)
  .refine((value) => RELATIVE_PATH.test(value) && !hasTraversal(value), {
    message: 'must be a relative path inside the build context, without ".." segments',
  });

/**
 * Validated shape for AI-filled template variables. Mirrors `DockerfileVars`
 * field-for-field (every field optional — the model only supplies what it wants to
 * change), so downstream stages receive typed values, never a stringly-typed record.
 * Unknown keys are stripped by zod, which doubles as the variable-name whitelist.
 */
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
    packageManager: z.enum(['npm', 'yarn', 'pnpm', 'pip', 'poetry', 'uv']).optional(),
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
  startCommand: inferredStartCommand,
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
