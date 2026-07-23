/**
 * The self-healing retry loop. On a failed attempt it asks the LLM to diagnose the
 * error and propose a patch, applies the patch, records a plain-English diagnosis
 * entry, and retries — up to `maxHealAttempts` (default 3). Headline feature.
 *
 * STAGE: 5 (build) — self-heal. REAL code.
 * Inputs: a `RunContext` (project dir, options, cost ledger, diagnosis log).
 * Outputs: the final `AttemptResult`; appends a `DiagnosisEntry` per heal attempt.
 *
 * SECURITY INVARIANT (code-enforced, not prompt-enforced): a heal patch may only
 * touch files ORCA itself generated (`ctx.generatedFiles`). Every patch path is
 * canonicalized against the workspace root; traversal attempts and application
 * source files are rejected here regardless of what the model claims.
 */

import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ai } from '../ai/client.js';
import { buildHealPrompt, type HealRecipeContext } from '../ai/prompts/heal.js';
import { HealSuggestionSchema, type HealSuggestion } from '../ai/schema.js';
import type { DiagnosisEntry, RunContext } from '../core/context.js';
import { HealExhaustedError } from '../utils/errors.js';
import { readFileIfExists } from '../utils/fs.js';
import { toDiagnosisEntry } from './diagnosisLog.js';
import { runOnce, type AttemptResult } from './runner.js';

const ERROR_EXCERPT_CHARS = 600;

function excerpt(errorOutput: string): string {
  const trimmed = errorOutput.trim();
  return trimmed.length > ERROR_EXCERPT_CHARS
    ? `...${trimmed.slice(-ERROR_EXCERPT_CHARS)}`
    : trimmed;
}

/**
 * Canonicalize a patch path against the workspace root and check it against the
 * allowlist. Returns the absolute path to write, or null when the patch must be
 * rejected (escapes the workspace, or targets a file ORCA did not generate).
 */
function resolveAllowedPath(
  workspaceDir: string,
  file: string,
  allowlist: ReadonlySet<string>
): string | null {
  const abs = resolve(workspaceDir, file);
  const rel = relative(workspaceDir, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return allowlist.has(rel.split(sep).join('/')) ? abs : null;
}

/**
 * Recipe context for any synthesized ecosystem/inferred services in the plan, so the
 * healer keeps a Go/Rust/inferred Dockerfile fix faithful to its runtime and commands.
 * Empty for pure seed-stack runs (whose Dockerfiles come from templates, not recipes).
 */
function healRecipeContext(ctx: RunContext): HealRecipeContext[] {
  const recipes: HealRecipeContext[] = [];
  for (const node of ctx.plan?.services ?? []) {
    if (node.source.type !== 'build' || node.source.recipe === undefined) continue;
    const { recipe } = node.source;
    recipes.push({
      serviceId: node.id,
      runtime: recipe.runtime,
      recipeId: recipe.id,
      installCommands: recipe.installCommands,
      buildCommands: recipe.buildCommands ?? [],
      startCommand: recipe.startCommand,
    });
  }
  return recipes;
}

/** Current contents of every generated file, for the heal prompt's grounding. */
async function readGeneratedFiles(ctx: RunContext): Promise<{ path: string; contents: string }[]> {
  const files: { path: string; contents: string }[] = [];
  for (const generated of ctx.generatedFiles) {
    const contents = await readFileIfExists(join(ctx.workspaceDir, generated.path));
    if (contents !== null) files.push({ path: generated.path, contents });
  }
  return files;
}

/** Apply the allowed subset of a suggestion's patches; returns what was written. */
async function applyPatches(
  ctx: RunContext,
  suggestion: HealSuggestion,
  allowlist: ReadonlySet<string>
): Promise<{ applied: string[]; rejected: string[] }> {
  const applied: string[] = [];
  const rejected: string[] = [];
  for (const patch of suggestion.patches) {
    const abs = resolveAllowedPath(ctx.workspaceDir, patch.file, allowlist);
    if (abs === null) {
      rejected.push(patch.file);
      ctx.logger.warn(
        `Rejected heal patch for '${patch.file}' — only ORCA-generated files may be patched.`
      );
      continue;
    }
    await writeFile(abs, patch.contents, 'utf8');
    applied.push(patch.file);
  }
  return { applied, rejected };
}

/**
 * Loop: runOnce -> on failure ask the AI to heal -> apply allowed patches -> retry.
 * `maxHealAttempts` bounds the number of HEALS, so the stack is attempted at most
 * `maxHealAttempts + 1` times. Throws `HealExhaustedError` when out of options.
 */
export async function runSelfHealLoop(ctx: RunContext): Promise<AttemptResult> {
  const allowlist: ReadonlySet<string> = new Set(ctx.generatedFiles.map((f) => f.path));
  const maxHeals = ctx.options.maxHealAttempts;
  let lastEntry: DiagnosisEntry | null = null;

  const signal = ctx.options.signal;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    ctx.logger.info(`Build/run attempt ${attempt} ...`);
    const result = await runOnce(ctx.workspaceDir, signal);
    if (result.ok) {
      // The previous heal is what made this attempt pass — mark it resolved.
      if (lastEntry !== null) lastEntry.resolved = true;
      return result;
    }

    const errorOutput = result.errorOutput ?? '';
    ctx.logger.warn(`Attempt ${attempt} failed during ${result.phase}.`);
    if (attempt > maxHeals) {
      throw new HealExhaustedError(
        `Self-heal gave up after ${maxHeals} fix attempt(s). ` +
          `Last failure (${result.phase}): ${excerpt(errorOutput)}`
      );
    }

    // Don't spend an AI heal call on a run that was cancelled mid-build.
    signal?.throwIfAborted();

    let suggestion: HealSuggestion;
    try {
      // Run-scoped facade when the pipeline provided one (--model / --cost-cap).
      const client = ctx.ai ?? ai;
      suggestion = await client.complete(
        buildHealPrompt(
          errorOutput,
          await readGeneratedFiles(ctx),
          attempt,
          healRecipeContext(ctx)
        ),
        HealSuggestionSchema,
        ctx.cost,
        { schemaName: 'HealSuggestion' }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HealExhaustedError(
        `Build failed and self-heal is unavailable (${message}). ` +
          `Failure (${result.phase}): ${excerpt(errorOutput)}`
      );
    }

    if (suggestion.patches.length === 0) {
      ctx.diagnosis.push(toDiagnosisEntry(attempt, errorOutput, suggestion, false));
      throw new HealExhaustedError(
        `Self-heal judged this failure unfixable by config changes: ${suggestion.explanation}`
      );
    }

    const { applied, rejected } = await applyPatches(ctx, suggestion, allowlist);
    // The diagnosis records only what was actually written, not what was proposed.
    lastEntry = toDiagnosisEntry(
      attempt,
      errorOutput,
      { ...suggestion, patches: suggestion.patches.filter((p) => applied.includes(p.file)) },
      false
    );
    ctx.diagnosis.push(lastEntry);

    if (applied.length === 0) {
      throw new HealExhaustedError(
        `Self-heal only proposed patches outside ORCA-generated files ` +
          `(${rejected.join(', ')}); refusing to modify application source.`
      );
    }
    ctx.logger.info(`Heal #${attempt}: ${suggestion.explanation}`);
    ctx.logger.info(`Fix applied: ${suggestion.fix}`, { changed: applied.join(', ') });
  }
}
