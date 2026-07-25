/**
 * Composition of the concrete detector plugins into a `DetectorRegistry`. This is the
 * Phase-B assembly point — as detectors are added (CI analysis in Phase D, etc.) they
 * register here, and nothing downstream changes.
 *
 * PHASE: B — REAL code.
 */

import { DetectorRegistry } from '../../model/detector.js';
import { ROLE_DETECTORS } from './role.js';
import { RUNTIME_DETECTORS } from './runtime.js';

export {
  RUNTIME_DETECTORS,
  goDetector,
  rustDetector,
  jvmDetector,
  dotnetDetector,
  phpDetector,
  rubyDetector,
} from './runtime.js';
export { ROLE_DETECTORS, jobDetector, libraryDetector } from './role.js';
export * from './facts.js';

/**
 * A registry populated with the detectors the repo-wide insight pass consumes, in
 * priority order.
 *
 * WHY ROLE DETECTORS ARE NOT IN HERE — AND WHY THAT IS NO LONGER A TYPING WORKAROUND.
 * The registry can now hold mixed kinds safely: every shipped detector emits a *tagged*
 * value (`RuntimeFact` / `RoleFact`), so a consumer narrows with `claimsOfKind` and never
 * sees the rest (`mixedRegistry()` below exercises exactly that). The old split existed
 * because untagged claims were recovered by an unchecked cast that mixing kinds would
 * have corrupted — that reason is gone.
 *
 * What remains is a plain cost argument: this registry's only tier-1 consumer wants
 * runtimes, and `libraryDetector` walks the source tree. Registering it here would run
 * that walk once per candidate root and discard every claim it produced. So the split is
 * now by PURPOSE (who consumes what), not forced by types — which is why
 * `detectComponentRole` keeps `ROLE_DETECTORS` as its own curated view.
 */
export function defaultDetectorRegistry(): DetectorRegistry {
  const registry = new DetectorRegistry();
  for (const detector of RUNTIME_DETECTORS) registry.register(detector);
  return registry;
}

/**
 * A registry holding **every** shipped detector, runtime and role together.
 *
 * Not used by the pipeline — it exists so the mixed-kind guarantee is a real, exercised
 * code path rather than a claim in a comment: a caller can register both kinds and pull
 * out just the one it wants. If tagging ever regressed, this is what would break.
 */
export function mixedDetectorRegistry(): DetectorRegistry {
  const registry = new DetectorRegistry();
  for (const detector of RUNTIME_DETECTORS) registry.register(detector);
  for (const detector of ROLE_DETECTORS) registry.register(detector);
  return registry;
}
