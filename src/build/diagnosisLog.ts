/**
 * Builds and formats the plain-English, attempt-by-attempt self-heal log. Turns raw
 * error output + the AI diagnosis into a `DiagnosisEntry` and renders the running log
 * for the user. Headline feature: explainable self-heal.
 *
 * STAGE: 5 (build)
 * Inputs: attempt number, error signature, AI explanation/fix, changed files.
 * Outputs: a `DiagnosisEntry` and a human-readable rendering of the log.
 */

import type { DiagnosisEntry } from '../core/context.js';
import type { HealSuggestion } from '../ai/schema.js';

// TODO(stage-5): construct a DiagnosisEntry from an attempt + the AI's suggestion.
export function toDiagnosisEntry(
  _attempt: number,
  _errorOutput: string,
  _suggestion: HealSuggestion,
  _resolved: boolean
): DiagnosisEntry {
  throw new Error('not implemented');
}

// TODO(stage-5): render the full diagnosis log as plain English for the terminal.
export function formatDiagnosisLog(_entries: DiagnosisEntry[]): string {
  throw new Error('not implemented');
}
