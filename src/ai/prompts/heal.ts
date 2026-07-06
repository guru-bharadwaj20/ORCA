/**
 * Prompt builder for the "diagnose and heal a failed build/run" task. Feeds the model
 * the failing command output + current configs and asks for a plain-English diagnosis
 * plus a concrete patch.
 *
 * STAGE: 3 (ai) — used by STAGE 5 (self-heal)
 * Inputs: the error output, the current generated files, and attempt number.
 * Outputs: a { system, user } prompt pair for the client.
 */

import type { PromptPair } from './fill.js';

// TODO(stage-3): compose the heal prompt; demand explanation + fix + minimal patches.
export function buildHealPrompt(
  _errorOutput: string,
  _currentFiles: { path: string; contents: string }[],
  _attempt: number
): PromptPair {
  throw new Error('not implemented');
}
