/**
 * Terminal presentation helpers: spinners, tables, and colored output. Keeps all
 * chalk/ora/cli-table3 usage in one place so the rest of the CLI stays presentation-free.
 *
 * STAGE: 7 (cli)
 * Inputs: plain data (plans, diagnosis entries, messages).
 * Outputs: writes formatted text to stdout/stderr; returns spinner handles.
 */

import type { ServicePlan } from '../../plan/types.js';
import type { DiagnosisEntry } from '../../core/context.js';

/** A minimal spinner handle so callers don't depend on ora's type directly. */
export interface Spinner {
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

// TODO(stage-7): start an ora spinner with the given label.
export function startSpinner(_label: string): Spinner {
  throw new Error('not implemented');
}

// TODO(stage-7): render a ServicePlan as a colored cli-table3 for the review screen.
export function renderPlanTable(_plan: ServicePlan): string {
  throw new Error('not implemented');
}

// TODO(stage-7): render the self-heal diagnosis as an attempt-by-attempt colored log.
export function renderDiagnosisLog(_entries: DiagnosisEntry[]): string {
  throw new Error('not implemented');
}
