/**
 * The tier-4 plugin contract for DYNAMIC PROBING (docs/universal-understanding-plan.md
 * §3, Phase G) — the interface and its security contract.
 *
 * THIS FILE IS STILL PURE CONTRACT: it defines the shapes and runs nothing. Execution now
 * exists, behind it, in `src/probe/` — `sandbox.ts` owns the isolation boundary,
 * `probers.ts` holds the shipped probers, and `runner.ts` enforces the gates below before
 * a container can be created. Every numbered clause names where it is enforced, so a
 * reviewer can check the contract against the code rather than against a promise.
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
 * SECURITY CONTRACT (every clause is satisfied before any probing ships):
 *
 *  1. ISOLATION. Untrusted repo code runs ONLY inside an ephemeral, network-isolated,
 *     resource-capped container (no host execution, ever). No bind mounts of host paths
 *     beyond the repo checkout; no host network; CPU/memory/PID/time limits enforced by
 *     the runtime, not by the probe's own good behavior.
 *     → `probe/sandbox.ts`. `dockerProbeSandbox` is the single code path that can start a
 *       process, it spawns nothing but `docker`, and `isolationArgs()` is asserted
 *       flag-by-flag in `tests/probe/sandbox.test.ts`.
 *  2. OPT-IN. Probing is gated behind an explicit, off-by-default flag. Absent the flag,
 *     the ladder simply has no tier-4 and behaves exactly as it does today.
 *     → `Settings.enableProbing` (`ORCA_ENABLE_PROBING`), default false, checked in
 *       `probe/runner.ts` BEFORE the sandbox is touched.
 *  3. APPROVE-BEFORE-RUN. The same approval gate that guards `docker compose up` guards
 *     probing: the user sees WHAT would be executed and WHY before anything runs.
 *     → `runProbers` requires `gate.approved`, and the pipeline passes `ctx.approved` —
 *       the flag set by the one `reviewPlan`/`approvePlan` gate. `describeProbePlan()`
 *       renders what would run for that gate to display.
 *  4. EPHEMERALITY. The probe environment is created per-run and destroyed after, with no
 *     persistence and no reuse across repos.
 *     → `--rm` plus an unconditional `docker rm -f` in a `finally`, against a container
 *       name unique to the run. No volumes, no reuse.
 *  5. EXPLAINABILITY. Every probe claim carries `Evidence` like any other claim, so a
 *     probed fact is as auditable as a static one ("observed process bound :8080").
 *     → `claim()` rejects empty evidence, and `PROBE_CONFIDENCE_CEILING` mechanically
 *       keeps a tier-4 observation from outranking the deterministic tiers.
 *
 * Exit criterion for Phase G: MET — the ladder has a tier-4 slot, a written security
 * contract, and an implementation that satisfies it.
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
 * What one isolated run actually observed, as raw text — the material a prober
 * interprets. Deliberately unparsed: the sandbox's job is to get the bytes out of the
 * container safely, and each prober's job is to make a claim from them, so adding a
 * prober never means changing the isolation boundary.
 */
export interface ProbeReading {
  /** Exit status of the probe script, or null when the run was killed. */
  exitCode: number | null;
  /** True when the run hit its wall-clock cap rather than finishing. */
  timedOut: boolean;
  /** Raw `/proc/net/tcp` + `/proc/net/tcp6` from inside the container. */
  netTcp: string;
  /** One entry per process seen inside the container: its argv, space-joined. */
  processes: string[];
  /** Captured stdout+stderr of the probed process, truncated by the sandbox. */
  log: string;
}

/**
 * The controlled environment a prober is handed. Probers never start anything themselves:
 * the runner performs ONE isolated run and hands every prober the same `reading`, which is
 * what keeps "one ephemeral container per probe run" true no matter how many probers are
 * registered. The interface intentionally exposes no way to run a host command.
 */
export interface ProbeContext extends RepoContext {
  /**
   * True only when probing has been explicitly opted into AND approved for this run.
   * A prober MUST treat a false/absent value as "do nothing" — it is the code-level
   * echo of the opt-in + approve-before-run contract, not merely advisory.
   */
  readonly enabled: boolean;
  /** The isolated run's output. Absent when probing is disabled — nothing ran. */
  readonly reading?: ProbeReading;
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
