/**
 * Typed error classes used across ORCA so stages can throw/catch precisely and the CLI
 * can map them to helpful messages and exit codes.
 *
 * STAGE: utils (shared)
 * Inputs: n/a (definitions).
 * Outputs: error classes.
 *
 * NOTE: The class definitions here are REAL; they carry no business logic, just typed
 * error identity, which is what the rest of the pipeline throws.
 */

/** Base class for all ORCA-thrown errors. */
export class OrcaError extends Error {
  constructor(
    message: string,
    /** Stable, machine-readable code for the CLI to branch on. */
    public readonly code: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The repo isn't one of ORCA's supported stacks. */
export class UnsupportedStackError extends OrcaError {
  constructor(message: string) {
    super(message, 'UNSUPPORTED_STACK');
  }
}

/** A required external tool (git, docker) is missing or unreachable. */
export class MissingDependencyError extends OrcaError {
  constructor(message: string) {
    super(message, 'MISSING_DEPENDENCY');
  }
}

/** The self-heal loop exhausted its attempts without a working build. */
export class HealExhaustedError extends OrcaError {
  constructor(message: string) {
    super(message, 'HEAL_EXHAUSTED');
  }
}

/** The run exceeded its configured LLM cost cap. */
export class CostCapExceededError extends OrcaError {
  constructor(message: string) {
    super(message, 'COST_CAP_EXCEEDED');
  }
}

/** The user rejected the plan at the approval gate. */
export class PlanRejectedError extends OrcaError {
  constructor(message: string) {
    super(message, 'PLAN_REJECTED');
  }
}
