import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ai } from '../ai/client.js';
import { buildHealPrompt } from '../ai/prompts/heal.js';
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

async function readGeneratedFiles(ctx: RunContext): Promise<{ path: string; contents: string }[]> {
  const files: { path: string; contents: string }[] = [];
  for (const generated of ctx.generatedFiles) {
    const contents = await readFileIfExists(join(ctx.workspaceDir, generated.path));
    if (contents !== null) files.push({ path: generated.path, contents });
  }
  return files;
}

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

    signal?.throwIfAborted();

    let suggestion: HealSuggestion;
    try {
      const client = ctx.ai ?? ai;
      suggestion = await client.complete(
        buildHealPrompt(errorOutput, await readGeneratedFiles(ctx), attempt),
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
