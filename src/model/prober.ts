/**
 * The tier-4 plugin contract for DYNAMIC PROBING (docs/universal-understanding-plan.md
 * §3, Phase G). This is a SEAM ONLY — the interface and its security contract, not an
 * implementation. Per decision #2, ORCA designs where probing plugs into the ladder but
 * ships no arbitrary code execution. Nothing here runs anything; there is deliberately
 * no default `Prober` and no runner that invokes one.
 *
 * A `Prober` is the dynamic analogue of a `Detector` (`src/model/detector.ts`): a
 * standalone unit that emits evidence-backed `Claim<T>`s. Where a detector reasons
 * statically over files, a prober would learn by *observing a running build/container* —
 * the ports it actually binds, the processes it starts, the log lines it prints, the
 * artifacts it produces. Those observations become tier-4 claims on the same ladder,
 * so a probe can only ever *reinforce or fill gaps left by* tiers 1–3, never bypass the
 * deterministic-first ordering.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * SECURITY CONTRACT (a future implementation MUST satisfy ALL of these before it ships):
 *
 *  1. ISOLATION. Untrusted repo code runs ONLY inside an ephemeral, network-isolated,
 *     resource-capped container (no host execution, ever). No bind mounts of host paths
 *     beyond the repo checkout; no host network; CPU/memory/PID/time limits enforced by
 *     the runtime, not by the probe's own good behavior.
 *  2. OPT-IN. Probing is gated behind an explicit, off-by-default flag. Absent the flag,
 *     the ladder simply has no tier-4 and behaves exactly as it does today.
 *  3. APPROVE-BEFORE-RUN. The same approval gate that guards `docker compose up` guards
 *     probing: the user sees WHAT would be executed and WHY before anything runs.
 *  4. EPHEMERALITY. The probe environment is created per-run and destroyed after, with no
 *     persistence and no reuse across repos.
 *  5. EXPLAINABILITY. Every probe claim carries `Evidence` like any other claim, so a
 *     probed fact is as auditable as a static one ("observed process bound :8080").
 *
 * Exit criterion for Phase G (met by this file): the ladder has a tier-4 slot and a
 * written security contract. Whether to BUILD execution is a separate, later decision.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

import type { Claim } from './claim.js';
import type { RepoContext } from './detector.js';

/**
 * What a prober is allowed to observe about a running build/container. These are the
 * *shapes* of tier-4 evidence; no prober implementation exists yet to produce them.
 */
export type ProbeObservation =
  /** A port the running container actually bound, learned by observation not by guess. */
  | { kind: 'port'; port: number; protocol: 'tcp' | 'udp' }
  /** A process the container started, e.g. its argv[0] or a recognized server. */
  | { kind: 'process'; command: string }
  /** A notable log line (a bound address, a readiness banner, a fatal error). */
  | { kind: 'log'; line: string }
  /** A build artifact the process produced, e.g. a compiled binary or a dist bundle. */
  | { kind: 'artifact'; path: string };

/**
 * The controlled environment a prober is handed. A real implementation would supply a
 * handle to the ISOLATED sandbox here (see the security contract above); the interface
 * intentionally does not expose a way to run arbitrary host commands.
 */
export interface ProbeContext extends RepoContext {
  /**
   * True only when probing has been explicitly opted into AND approved for this run.
   * A prober MUST treat a false/absent value as "do nothing" — it is the code-level
   * echo of the opt-in + approve-before-run contract, not merely advisory.
   */
  readonly enabled: boolean;
}

/**
 * One dynamic-probing plugin (tier 4 of the inference ladder). Mirrors `Detector` so the
 * same registry/runner machinery can host it once execution is built. Emitting a claim
 * requires `ctx.enabled`; a disabled context yields `[]`.
 */
export interface Prober {
  /** Stable id, namespaced by kind, e.g. "probe:ports", "probe:process". */
  id: string;
  /** Always 4 — probing is the last, most-guarded rung. */
  tier: 4;
  /**
   * Observe the (isolated, opt-in, approved) run and emit evidence-backed claims. MUST
   * return `[]` when `ctx.enabled` is false. No implementation ships in this phase.
   */
  probe(ctx: ProbeContext): Promise<Claim<ProbeObservation>[]>;
}
