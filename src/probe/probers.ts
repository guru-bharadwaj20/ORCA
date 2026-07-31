/**
 * The shipped tier-4 probers (Phase G). Each turns one isolated run's `ProbeReading` into
 * evidence-backed `Claim<ProbeObservation>`s.
 *
 * These are PURE PARSERS. They start nothing: the runner performs the single isolated run
 * and hands every prober the same reading, so registering a tenth prober still costs one
 * container. That split is what keeps the isolation boundary in exactly one file.
 *
 * Every prober returns `[]` for a disabled context, unconditionally and before touching
 * the reading — the code-level echo of the opt-in contract, restated in each prober rather
 * than trusted to the runner, because a prober may one day be invoked from somewhere else.
 *
 * STAGE: 2 (detect) / PHASE G — REAL code. No AI.
 */

import { claim, type Claim } from '../model/claim.js';
import type { ProbeContext, ProbeObservation, Prober } from '../model/prober.js';

/** `/proc/net/tcp` state code for a socket in LISTEN. */
const TCP_LISTEN = '0A';

/**
 * Ports the process actually bound, parsed from `/proc/net/tcp{,6}`.
 *
 * Each line looks like `sl local_address rem_address st ...` with the address as
 * `HEXADDR:HEXPORT`. Only `st == 0A` (LISTEN) counts: an outbound connection is not a
 * port the service offers, and counting one would publish a random ephemeral port.
 */
export function listeningPorts(netTcp: string): number[] {
  const ports = new Set<number>();
  for (const line of netTcp.split('\n')) {
    const fields = line.trim().split(/\s+/);
    // fields: [sl, local, remote, st, ...] — the header row has no numeric sl and is
    // discarded by the state check below.
    const local = fields[1];
    const state = fields[3];
    if (local === undefined || state !== TCP_LISTEN) continue;
    const hexPort = local.split(':')[1];
    if (hexPort === undefined) continue;
    const port = Number.parseInt(hexPort, 16);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * `probe:ports` — what the container actually listened on.
 *
 * The flagship tier-4 fact, and the one static analysis is worst at: a port read out of
 * source is what the code *says*, while this is what the kernel *recorded*. Weighted below
 * a lockfile-grade deterministic signal on purpose (see `PROBE_CONFIDENCE_CEILING`): one
 * run under one configuration can miss a bind that a different code path would make.
 */
export const portProber: Prober = {
  id: 'probe:ports',
  tier: 4,
  probe(ctx: ProbeContext): Promise<Claim<ProbeObservation>[]> {
    if (!ctx.enabled || ctx.reading === undefined) return Promise.resolve([]);
    return Promise.resolve(
      listeningPorts(ctx.reading.netTcp).map((port) =>
        claim<ProbeObservation>(
          { kind: 'port', port, protocol: 'tcp' },
          [
            {
              detector: 'probe:ports',
              signal: `observed process bound :${port} (LISTEN in /proc/net/tcp)`,
              weight: 0.7,
              // One family: ten ports from one run are ten facts, but they are not ten
              // independent confirmations of each other.
              family: 'probe:run',
            },
          ],
          'probe'
        )
      )
    );
  },
};

/** Kernel threads and the reader's own shell — noise, not the container's workload. */
const IGNORED_PROCESSES = /^(?:\[|\/bin\/sh -c |sh -c |ps\b|cat\b|tr\b|for\b)/;

/**
 * `probe:process` — what the container actually started.
 *
 * Answers "did the start command we synthesized survive contact with the image?", which is
 * precisely the question a Dockerfile's `CMD` cannot answer statically.
 */
export const processProber: Prober = {
  id: 'probe:process',
  tier: 4,
  probe(ctx: ProbeContext): Promise<Claim<ProbeObservation>[]> {
    if (!ctx.enabled || ctx.reading === undefined) return Promise.resolve([]);
    const commands = ctx.reading.processes
      .filter((command) => command !== '' && !IGNORED_PROCESSES.test(command))
      .slice(0, 8);
    return Promise.resolve(
      commands.map((command) =>
        claim<ProbeObservation>(
          { kind: 'process', command },
          [
            {
              detector: 'probe:process',
              signal: `observed running process \`${command}\``,
              weight: 0.6,
              family: 'probe:run',
            },
          ],
          'probe'
        )
      )
    );
  },
};

/**
 * Log lines worth keeping: a readiness banner, a bound address, or a fatal error. A probe
 * that reported every line would be a log viewer, not a detector.
 */
const NOTABLE_LOG =
  /\b(?:listening|running at|started server|bound|error|fatal|exception|traceback|cannot find|permission denied|address already in use)\b/i;

/**
 * `probe:log` — the handful of lines that explain the run.
 *
 * This is the prober that pays for itself when the container does NOT work: "Missing
 * script: dev" or "ModuleNotFoundError" is the exact sentence a user needs, and it is
 * invisible to every static tier.
 */
export const logProber: Prober = {
  id: 'probe:log',
  tier: 4,
  probe(ctx: ProbeContext): Promise<Claim<ProbeObservation>[]> {
    if (!ctx.enabled || ctx.reading === undefined) return Promise.resolve([]);
    const lines = ctx.reading.log
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && NOTABLE_LOG.test(line))
      .slice(0, 5);
    return Promise.resolve(
      lines.map((line) =>
        claim<ProbeObservation>(
          { kind: 'log', line },
          [
            {
              detector: 'probe:log',
              signal: `container logged: ${line}`,
              weight: 0.5,
              family: 'probe:run',
            },
          ],
          'probe'
        )
      )
    );
  },
};

/** The registered probers, in reporting order. */
export const PROBERS: readonly Prober[] = [portProber, processProber, logProber];
