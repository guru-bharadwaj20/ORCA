/**
 * Runtime-version recovery: fold every CI source that PINS a runtime version into one
 * ranked, provenance-carrying answer — the same pattern `buildRecovery.ts` established
 * for build/run commands (docs/universal-understanding-plan.md §3, §5 Phase C).
 *
 * `insights.ciRuntimeVersions` was the last dead-end parallel array of the kind
 * `buildRecovery` was written to retire: four providers (GitHub Actions, GitLab CI, Azure
 * Pipelines, CircleCI) each contribute `{ runtime, version }` pins, they were merged into
 * one flat, deduped, provenance-less array, and nothing downstream but `logInsights` ever
 * read it. This module is the missing consumer: it normalizes those pins into a single
 * evidence-backed `Claim<RecoveredRuntimes>` that keeps WHICH providers agreed, ranks by
 * cross-source agreement, and explains itself like every other detector.
 *
 * PROVIDERS ARE UNIFORM. The `provider` field on each signal is a label that rides into
 * the provenance/evidence — never a branch. Adding a fifth CI provider means its parser
 * emits `RuntimeVersionSignal`s and this module needs no edit at all (the same line
 * `ciProviders` already holds for command recovery).
 *
 * STAGE: 2 (detect) — REAL code. Pure functions, no AI, no IO.
 */

import { claim, type Claim, type Evidence } from '../model/claim.js';
import type { CiRuntimeVersion } from './ci.js';

/** A runtime-version pin from one CI source, tagged with the provider that declared it. */
export interface RuntimeVersionSignal extends CiRuntimeVersion {
  /** Provider label, used as provenance: 'github-actions' | 'gitlab' | 'azure' | 'circleci' | … */
  provider: string;
}

/** One runtime:version pin, with every provider that declared exactly it. */
export interface RecoveredRuntimeVersion {
  runtime: string;
  version: string;
  /** Distinct providers that pinned this exact runtime:version, in first-seen order. */
  origins: string[];
}

/** The runtime versions a repo's CI declares, normalized with provenance. */
export interface RecoveredRuntimes {
  /** Deduped by runtime:version, first-seen order preserved. A genuine cross-source
   * disagreement (CI pins node 18, GitLab says node 20) is kept as two entries — that is
   * real information about the repo, not noise. */
  versions: RecoveredRuntimeVersion[];
  /** Distinct providers that contributed any pin. */
  origins: string[];
}

/**
 * Confidence weight for a CI-pinned runtime version. A version pin is a weaker signal
 * than a recovered build command (it says how, not what to run), so it sits just below
 * `RECOVERY_WEIGHTS.ci`; cross-source agreement still compounds it via `combineConfidence`
 * exactly like any other independent evidence (§4).
 */
export const RUNTIME_VERSION_WEIGHT = 0.15;

/**
 * Recover the runtime versions a repo's CI pins, as a `Claim`.
 *
 * Returns null when no source pinned anything — a repo with no CI (or CI that pins no
 * versions) leaves nothing to normalize, rather than an empty recovery callers must
 * special-case (mirrors `recoverBuild`).
 */
export function recoverRuntimes(
  signals: readonly RuntimeVersionSignal[]
): Claim<RecoveredRuntimes> | null {
  if (signals.length === 0) return null;

  // Group by runtime:version, collecting the providers that agree, first-seen order kept
  // (GitHub Actions first, mirroring the previous merge order in index.ts).
  const byKey = new Map<string, RecoveredRuntimeVersion>();
  const order: string[] = [];
  for (const s of signals) {
    const key = `${s.runtime}:${s.version}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { runtime: s.runtime, version: s.version, origins: [] };
      byKey.set(key, entry);
      order.push(key);
    }
    if (!entry.origins.includes(s.provider)) entry.origins.push(s.provider);
  }
  const versions = order.map((k) => byKey.get(k)!);
  const origins = [...new Set(signals.map((s) => s.provider))];

  // One evidence entry per contributing provider family, each weighted the same, so
  // independent providers pinning versions raises confidence like any cross-source
  // agreement (§4) — not a bespoke rule. Providers are data: the label rides in the
  // signal, so a new provider contributes here without a code change.
  const evidence: Evidence[] = origins.map((provider) => {
    const mine = signals.filter((s) => s.provider === provider);
    const pins = [...new Set(mine.map((s) => `${s.runtime} ${s.version}`))].join(', ');
    return {
      detector: `runtime-recovery:${provider}`,
      signal: `${provider} pins ${pins}`,
      weight: RUNTIME_VERSION_WEIGHT,
    };
  });

  return claim({ versions, origins }, evidence, 'ci');
}
