/**
 * The evidence-based detection model — the foundation of ORCA's Universal Repository
 * Understanding architecture (see docs/universal-understanding-plan.md §2, §4).
 *
 * Every fact a detector asserts about a repo is a `Claim<T>`: a value, a computed
 * confidence, and a non-empty `Evidence[]` reasoning trail. This replaces the closed
 * union types + the single hardcoded `scoreConfidence()` heuristic with an open,
 * traceable, extensible model where "add a framework" means "add a detector", not
 * "edit an enum".
 *
 * PHASE: A (foundation) — REAL code. Pure data + math, no I/O, no AI.
 */

/**
 * Which tier of the inference ladder produced a claim. Lower tiers are cheaper and
 * more trustworthy; deterministic-first means tiers 1–2 run before AI (tier 3) and
 * probing (tier 4). See the ladder in docs/universal-understanding-plan.md §3.
 */
export type ClaimSource = 'deterministic' | 'ci' | 'ai' | 'probe';

/**
 * The maximum confidence an AI-sourced claim may reach on its own. This mechanically
 * enforces "AI is a fallback, not primary" (§4): an AI claim can *agree with* and
 * thereby reinforce a deterministic claim, but can never outrank determinism by fiat.
 */
export const AI_CONFIDENCE_CEILING = 0.7;

/** One piece of support for a claim, so every inference is explainable. */
export interface Evidence {
  /** The detector that observed this signal, e.g. "manifest:cargo", "ci:github-actions". */
  detector: string;
  /** Human-readable signal, surfaced verbatim as reasoning, e.g. "Cargo.toml present". */
  signal: string;
  /** This signal's contribution to confidence, 0..1. */
  weight: number;
}

/**
 * A scored assertion about the repo. Detectors emit these; the aggregator merges and
 * ranks them. `evidence` is never empty — a claim with no reasoning is a bug.
 */
export interface Claim<T> {
  value: T;
  /** 0..1, computed from `evidence` (see `combineConfidence`), never hand-set. */
  confidence: number;
  /** The reasoning trail. Guaranteed non-empty by `claim()`. */
  evidence: Evidence[];
  source: ClaimSource;
}

/**
 * Combine independent evidence weights into a single 0..1 confidence using the
 * probabilistic OR `1 - Π(1 - wᵢ)`: independent signals that agree drive confidence
 * up (manifest AND ci AND imports all saying "rust" beats any one alone), while a
 * lone weak signal stays low. Weights are clamped to [0, 1]; the result never exceeds 1.
 */
export function combineConfidence(evidence: readonly Evidence[]): number {
  if (evidence.length === 0) return 0;
  const complement = evidence.reduce((acc, e) => {
    const w = Math.min(1, Math.max(0, e.weight));
    return acc * (1 - w);
  }, 1);
  return round2(1 - complement);
}

/**
 * Construct a claim from its value, evidence, and source. Confidence is *computed*
 * from the evidence (never passed in), then capped at the AI ceiling when the source
 * is `'ai'`. Throws if evidence is empty — an unexplained claim is not allowed.
 */
export function claim<T>(value: T, evidence: Evidence[], source: ClaimSource): Claim<T> {
  if (evidence.length === 0) {
    throw new Error(
      `Claim for ${JSON.stringify(value)} has no evidence — every claim must explain itself.`
    );
  }
  let confidence = combineConfidence(evidence);
  if (source === 'ai') confidence = Math.min(confidence, AI_CONFIDENCE_CEILING);
  return { value, confidence, evidence, source };
}

/**
 * A claim value that names its own kind, so claims of different kinds can share one
 * registry without their values being confused for one another.
 *
 * WHY THIS EXISTS. Detectors emit `Claim<unknown>`, which erases what a claim is *about*.
 * That erasure forced two workarounds: role detectors had to live in a second registry
 * (mixing them into the runtime registry "would corrupt runtime detection"), and both
 * consumers recovered their type with an unchecked `as Claim<T>[]` cast — a cast that
 * would silently mis-type every claim the moment a registry gained a new detector kind.
 * Tagging the value makes the kind checkable at runtime and narrowable at compile time,
 * so one registry can safely serve every kind.
 */
export interface KindedValue<K extends string = string> {
  readonly kind: K;
}

/** True when a claim's value is a `KindedValue` bearing exactly `kind`. */
function hasKind(value: unknown, kind: string): boolean {
  return (
    typeof value === 'object' && value !== null && (value as Partial<KindedValue>).kind === kind
  );
}

/**
 * Select the claims whose value is of `kind`, narrowing them to `Claim<V>`.
 *
 * This replaces `claims as Claim<T>[]`: the discriminant is *checked* at runtime, so a
 * claim of another kind is filtered out rather than mis-typed. Mixing kinds in one
 * registry is therefore safe — a consumer asks for the kind it understands and is
 * unaffected by every other kind present.
 */
export function claimsOfKind<V extends KindedValue>(
  claims: readonly Claim<unknown>[],
  kind: V['kind']
): Claim<V>[] {
  return claims.filter((c): c is Claim<V> => hasKind(c.value, kind));
}

/** Project a claim's evidence to the plain reasoning strings shown to the user. */
export function reasoning<T>(c: Claim<T>): string[] {
  return c.evidence.map((e) => e.signal);
}

/**
 * Pick the highest-confidence claim from a list, or null if empty. Ties break toward
 * the earlier claim (detectors are registered in priority order). This is how a role's
 * single winner is chosen from competing detectors.
 */
export function bestClaim<T>(claims: readonly Claim<T>[]): Claim<T> | null {
  let best: Claim<T> | null = null;
  for (const c of claims) {
    if (best === null || c.confidence > best.confidence) best = c;
  }
  return best;
}

/** Round to 2 decimals, matching the existing `scoreConfidence` presentation. */
function round2(n: number): number {
  return Number(n.toFixed(2));
}
