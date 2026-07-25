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
  /**
   * Which INDEPENDENT source this signal came from. Signals sharing a family are treated
   * as one observation (the strongest wins) rather than as corroborating each other.
   *
   * Defaults to `detector` when omitted, which is the honest default: two signals from the
   * same detector are rarely independent. Give two detectors the same family when their
   * observations are derived from one another — `Cargo.toml` and `Cargo.lock` are one
   * fact, since the lockfile is *generated from* the manifest.
   */
  family?: string;
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
 * Combine evidence weights into a single 0..1 confidence using the probabilistic OR
 * `1 - Π(1 - wᵢ)` — but only ACROSS independent families, never within one.
 *
 * The probabilistic OR is only valid for independent observations. Applied naively it
 * treats every signal as fresh corroboration, so evidence that is really one fact
 * observed twice compounds into near-certainty:
 *
 *   `Cargo.toml` (0.85) + `Cargo.lock` (0.85)  ->  0.978 under a naive fold
 *
 * A lockfile is *generated from* its manifest, so it carries almost no information the
 * manifest did not already give; letting it cut the residual uncertainty by 85% is
 * manufactured confidence. The same flaw scales: ten correlated weak signals at 0.2 fold
 * to 0.89, turning a pile of guesses into an apparent near-certainty.
 *
 * So signals are grouped by `family` (defaulting to `detector`), reduced to the STRONGEST
 * weight within each family, and only then combined across families. Genuinely independent
 * corroboration — manifest AND ci AND imports all saying "rust" — still compounds, because
 * those are different families. Weights are clamped to [0, 1]; the result never exceeds 1.
 */
export function combineConfidence(evidence: readonly Evidence[]): number {
  if (evidence.length === 0) return 0;

  // Strongest signal per independent family — correlated repeats do not stack.
  const strongestByFamily = new Map<string, number>();
  for (const e of evidence) {
    const family = e.family ?? e.detector;
    const weight = Math.min(1, Math.max(0, e.weight));
    const current = strongestByFamily.get(family);
    if (current === undefined || weight > current) strongestByFamily.set(family, weight);
  }

  let complement = 1;
  for (const weight of strongestByFamily.values()) complement *= 1 - weight;
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
