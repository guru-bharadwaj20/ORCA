/**
 * Composition of the concrete detector plugins into a `DetectorRegistry`. This is the
 * Phase-B assembly point — as detectors are added (CI analysis in Phase D, etc.) they
 * register here, and nothing downstream changes.
 *
 * PHASE: B — REAL code.
 */

import { DetectorRegistry } from '../../model/detector.js';
import { RUNTIME_DETECTORS } from './runtime.js';

export {
  RUNTIME_DETECTORS,
  goDetector,
  rustDetector,
  jvmDetector,
  dotnetDetector,
} from './runtime.js';

/** A registry populated with every shipped detector, in priority order. */
export function defaultDetectorRegistry(): DetectorRegistry {
  const registry = new DetectorRegistry();
  for (const detector of RUNTIME_DETECTORS) registry.register(detector);
  return registry;
}
