/**
 * The tagged claim values the shipped detectors emit (§2.1, §3).
 *
 * These live in the detect layer, not in `src/model/`, on purpose: `model/` is the lower
 * layer and must not depend on `detect/` for its vocabulary (`Runtime` is a model type,
 * but `RunnableRole` is a detect type). `model/` supplies only the generic `KindedValue`
 * contract; which kinds actually exist is a detect-layer concern, so a new kind is a new
 * entry here plus a detector — never an edit to the model.
 *
 * Each fact carries a `kind` discriminant so claims of different kinds can share one
 * `DetectorRegistry` and be narrowed with `claimsOfKind` instead of cast.
 *
 * STAGE: 2 (detect) — REAL code. Pure types.
 */

import type { KindedValue } from '../../model/claim.js';
import type { Runtime } from '../../model/recipe.js';
import type { RunnableRole } from '../types.js';

/** "This component's runtime is X" — emitted by the tier-1 manifest detectors. */
export interface RuntimeFact extends KindedValue<'runtime'> {
  kind: 'runtime';
  runtime: Runtime;
}

/** "This component's role is X" — emitted by the tier-1 role detectors. */
export interface RoleFact extends KindedValue<'role'> {
  kind: 'role';
  role: RunnableRole;
}

/** Every fact kind the shipped detectors can emit. */
export type DetectedFact = RuntimeFact | RoleFact;

/** Construct a `RuntimeFact`. */
export function runtimeFact(runtime: Runtime): RuntimeFact {
  return { kind: 'runtime', runtime };
}

/** Construct a `RoleFact`. */
export function roleFact(role: RunnableRole): RoleFact {
  return { kind: 'role', role };
}
