/**
 * Builds and formats the plain-English, attempt-by-attempt self-heal log. Turns raw
 * error output + the AI diagnosis into a `DiagnosisEntry` and renders the running log
 * for the user. Headline feature: explainable self-heal.
 *
 * STAGE: 5 (build) — REAL code.
 * Inputs: attempt number, error signature, AI explanation/fix, changed files.
 * Outputs: a `DiagnosisEntry` and a human-readable rendering of the log.
 */

import type { DiagnosisEntry } from '../core/context.js';
import type { HealSuggestion } from '../ai/schema.js';

/** How much raw error tail to keep as the machine-matchable signature. */
const SIGNATURE_CHARS = 400;

/** Construct a DiagnosisEntry from one failed attempt + the AI's suggestion. */
export function toDiagnosisEntry(
  attempt: number,
  errorOutput: string,
  suggestion: HealSuggestion,
  resolved: boolean
): DiagnosisEntry {
  const trimmed = errorOutput.trim();
  return {
    attempt,
    errorSignature:
      trimmed.length > SIGNATURE_CHARS ? `...${trimmed.slice(-SIGNATURE_CHARS)}` : trimmed,
    explanation: suggestion.explanation,
    fix: suggestion.fix,
    changedFiles: suggestion.patches.map((patch) => patch.file),
    resolved,
    timestamp: new Date().toISOString(),
  };
}

/** Render the full diagnosis log as plain English for the terminal ('' when empty). */
export function formatDiagnosisLog(entries: DiagnosisEntry[]): string {
  if (entries.length === 0) return '';

  const lines = ['Self-heal log:'];
  for (const entry of entries) {
    lines.push(
      `  Attempt ${entry.attempt}: ${entry.explanation}`,
      `    Fix: ${entry.fix}` +
        (entry.changedFiles.length > 0 ? ` (changed: ${entry.changedFiles.join(', ')})` : ''),
      `    Outcome: ${entry.resolved ? 'resolved — the next attempt succeeded' : 'did not resolve the failure'}`
    );
  }
  return `${lines.join('\n')}\n`;
}
