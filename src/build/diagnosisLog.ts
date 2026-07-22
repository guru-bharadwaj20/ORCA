import type { DiagnosisEntry } from '../core/context.js';
import type { HealSuggestion } from '../ai/schema.js';

const SIGNATURE_CHARS = 400;

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
