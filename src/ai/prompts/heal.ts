/**
 * Prompt builder for the "diagnose and heal a failed build/run" task. Feeds the model
 * the failing command output + current configs and asks for a plain-English diagnosis
 * plus a concrete patch.
 *
 * STAGE: 3 (ai) — used by STAGE 5 (self-heal). REAL code.
 * Inputs: the error output, the current generated files, attempt number, and (optional)
 * the recipe context for any synthesized ecosystem/inferred Dockerfiles.
 * Outputs: a { system, user } prompt pair for the client.
 */

import type { PromptPair } from './fill.js';

/**
 * A synthesized service's build recipe, surfaced to the healer so a fix to a Go/Rust/
 * inferred Dockerfile is grounded in the intended runtime and commands — not guessed
 * from the Dockerfile text alone. Empty for pure seed-stack (template) runs.
 */
export interface HealRecipeContext {
  /** The service node id, e.g. "app" or "api". */
  serviceId: string;
  /** The recipe runtime, e.g. "rust", "go", "jvm". */
  runtime: string;
  /** The recipe id, e.g. "rust-cargo" or "ai-rust". */
  recipeId: string;
  /** The intended install/build/start commands, so a fix stays faithful to the recipe. */
  installCommands: string[];
  buildCommands: string[];
  startCommand: string;
}

/** Keep the *tail* of build output — that's where the actual error usually is. */
const MAX_ERROR_CHARS = 5000;
/** Cap per-file contents so a big Dockerfile/compose can't blow the prompt. */
const MAX_FILE_CHARS = 4000;

const HEAL_SYSTEM = `You are ORCA's self-heal assistant. A docker build/run of a small student/hackathon repo just failed. Diagnose the failure and propose ONE minimal fix by patching the files ORCA generated (Dockerfiles, docker-compose.yml, .env). Never patch the repo's own application source code.

Respond with ONLY a JSON object of this exact shape — no markdown fences, no commentary:
{"explanation": "<plain English: what broke and why, 1-2 sentences a student can understand>", "fix": "<plain English: what you are changing, 1 sentence>", "patches": [{"file": "<path relative to repo root>", "contents": "<the COMPLETE new file contents>"}], "confidence": <0.0-1.0>}

Rules:
- "patches" must contain the FULL new contents of each changed file, not a diff.
- Change as little as possible — one root cause per attempt.
- Only patch files from the provided list; do not introduce new files unless strictly required to fix the error.
- If the error is unfixable by config changes (e.g. broken application code), say so in "explanation" and return an empty "patches" array.
- "confidence" is your own honest self-assessment (0.0-1.0) of how certain you are this fix addresses the actual root cause shown in the error output, not a constant — use a low number when you are guessing.`;

/** Render the recipe-context block for synthesized services, or '' when there is none. */
function recipeSection(recipes: readonly HealRecipeContext[]): string {
  if (recipes.length === 0) return '';
  const blocks = recipes.map((r) =>
    [
      `### service "${r.serviceId}" — ${r.runtime} (recipe ${r.recipeId})`,
      `install: ${r.installCommands.join(' && ') || '(none)'}`,
      `build:   ${r.buildCommands.join(' && ') || '(none)'}`,
      `start:   ${r.startCommand}`,
    ].join('\n')
  );
  return [
    '',
    '## Synthesized service recipes (keep fixes faithful to these)',
    'These Dockerfiles were generated from build recipes. Keep any fix consistent with the',
    'runtime and intended commands below — do not switch a service to a different runtime.',
    ...blocks,
  ].join('\n');
}

/** Compose the heal prompt; demands explanation + fix + minimal patches. */
export function buildHealPrompt(
  errorOutput: string,
  currentFiles: { path: string; contents: string }[],
  attempt: number,
  recipes: readonly HealRecipeContext[] = []
): PromptPair {
  const errorTail =
    errorOutput.length > MAX_ERROR_CHARS
      ? `[...truncated by ORCA...]\n${errorOutput.slice(-MAX_ERROR_CHARS)}`
      : errorOutput;

  const fileSections = currentFiles.map((file) => {
    const contents =
      file.contents.length > MAX_FILE_CHARS
        ? `${file.contents.slice(0, MAX_FILE_CHARS)}\n[...truncated by ORCA...]`
        : file.contents;
    return `### ${file.path}\n${contents}`;
  });

  const user = [
    `## Heal attempt ${attempt}`,
    '',
    '## Failing command output (tail)',
    errorTail.trim() === '' ? '(no output captured)' : errorTail,
    '',
    '## Current generated files',
    ...(fileSections.length > 0 ? fileSections : ['(none)']),
    recipeSection(recipes),
  ]
    .join('\n')
    .trimEnd();

  return { system: HEAL_SYSTEM, user };
}
