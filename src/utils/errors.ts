export class OrcaError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedStackError extends OrcaError {
  constructor(message: string) {
    super(message, 'UNSUPPORTED_STACK');
  }
}

export class MissingDependencyError extends OrcaError {
  constructor(message: string) {
    super(message, 'MISSING_DEPENDENCY');
  }
}

export class HealExhaustedError extends OrcaError {
  constructor(message: string) {
    super(message, 'HEAL_EXHAUSTED');
  }
}

export class CostCapExceededError extends OrcaError {
  constructor(message: string) {
    super(message, 'COST_CAP_EXCEEDED');
  }
}

export class PlanRejectedError extends OrcaError {
  constructor(message: string) {
    super(message, 'PLAN_REJECTED');
  }
}

export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
}
