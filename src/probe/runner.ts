/**
 * The tier-4 runner (Phase G) — where the security contract is ENFORCED.
 *
 * Two gates stand between a caller and the sandbox, and both are checked before the
 * sandbox is so much as constructed:
 *
 *   - OPT-IN (clause 2): `Settings.enableProbing`, off by default. With the flag unset,
 *     `runProbers` returns `[]` and the ladder behaves exactly as it did before tier 4
 *     existed — no container, no docker call, nothing.
 *   - APPROVE-BEFORE-RUN (clause 3): the caller passes the SAME `approved` bit that the
 *     one plan-approval gate sets. Probing cannot be approved separately or implicitly.
 *
 * ORDER MATTERS AND IS TESTED. The gates come first so that "probing is disabled" is a
 * statement about what ran, not about what was returned: a check that filtered results
 * afterwards would still have started the container.
 *
 * A probe never fails a run. Every path degrades to `[]` with a warning, because tier 4 is
 * additive by definition — anything it would have told us, the deterministic tiers have
 * already had their turn at.
 *
 * STAGE: 2 (detect) / PHASE G — REAL code.
 */

import { loadSettings, type Settings } from '../config/settings.js';
import type { Claim } from '../model/claim.js';
import type { ProbeContext, ProbeObservation, Prober } from '../model/prober.js';
import { PROBERS } from './probers.js';
import { dockerProbeSandbox, isolationArgs, type ProbeSandbox } from './sandbox.js';

/** The two bits that must BOTH be true before anything runs. */
export interface ProbeGate {
  /** The opt-in flag (`Settings.enableProbing`). */
  enabled: boolean;
  /** The plan-approval bit (`RunContext.approved`). */
  approved: boolean;
}

export interface ProbeRequest {
  /** Absolute path to the repo, for the `RepoContext` half of the prober contract. */
  repoPath: string;
  /** Repo-relative component directory this probe is about. */
  scopeDir?: string;
  /** The already-built image to observe. */
  image: string;
  gate: ProbeGate;
  /** Cancels the probe when the surrounding run is aborted. */
  signal?: AbortSignal;
  /** Injected for tests; defaults to the real Docker-backed sandbox. */
  sandbox?: ProbeSandbox;
  probers?: readonly Prober[];
  settings?: Settings;
}

export interface ProbeOutcome {
  /** Tier-4 claims, empty when the gates declined or nothing was observed. */
  claims: Claim<ProbeObservation>[];
  /**
   * Why probing did not run, when it did not. Null when it did.
   *
   * This is the field that keeps "produced nothing" distinguishable from "never ran" —
   * two outcomes that both yield zero claims and mean completely different things.
   */
  skipped: string | null;
}

/**
 * A human-readable description of what probing WOULD do, for the approval gate to show.
 * Clause 3 is "the user sees WHAT would be executed and WHY before anything runs", which
 * means this string has to name the image and the isolation it runs under — not merely
 * say that probing is enabled.
 */
export function describeProbePlan(image: string, settings: Settings = loadSettings()): string {
  return [
    `Probe (tier 4): run ${image} in one throwaway container to observe the ports it binds,`,
    `the process it starts, and its first log lines.`,
    `Isolation: ${isolationArgs(settings).join(' ')}.`,
    `No host path is mounted and the container is removed afterwards.`,
  ].join(' ');
}

/**
 * Run the registered probers against one isolated observation of `image`.
 *
 * Returns `{ claims: [], skipped: <reason> }` whenever a gate declines — the reason is
 * surfaced rather than swallowed, so "probing produced nothing" is always distinguishable
 * from "probing never ran".
 */
export async function runProbers(request: ProbeRequest): Promise<ProbeOutcome> {
  const settings = request.settings ?? loadSettings();

  // GATE 1 — opt-in. Before the sandbox exists.
  if (!request.gate.enabled) {
    return { claims: [], skipped: 'probing is disabled (set ORCA_ENABLE_PROBING=1)' };
  }
  // GATE 2 — approve-before-run. Same bit as `docker compose up`.
  if (!request.gate.approved) {
    return { claims: [], skipped: 'the plan was not approved' };
  }

  const sandbox = request.sandbox ?? dockerProbeSandbox(settings);
  const reading = await sandbox.run({
    image: request.image,
    settleMs: settings.probeSettleMs,
    timeoutMs: settings.probeTimeoutMs,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });

  const ctx: ProbeContext = {
    repoPath: request.repoPath,
    scopeDir: request.scopeDir ?? '.',
    enabled: true,
    reading,
  };

  const claims: Claim<ProbeObservation>[] = [];
  for (const prober of request.probers ?? PROBERS) {
    try {
      claims.push(...((await prober.probe(ctx)) as Claim<ProbeObservation>[]));
    } catch {
      // One misbehaving prober must not lose the others' observations.
      continue;
    }
  }

  return { claims, skipped: null };
}

/** One reasoning line per probe claim, for the run's evidence trail. */
export function describeProbeClaims(claims: readonly Claim<ProbeObservation>[]): string[] {
  return claims.flatMap((c) => c.evidence.map((e) => `${e.signal} (tier 4, ${c.confidence})`));
}
