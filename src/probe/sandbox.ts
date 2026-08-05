/**
 * THE ISOLATION BOUNDARY for tier-4 probing (Phase G, security-contract clause 1).
 *
 * This module is the ONLY place in ORCA that deliberately executes repo-controlled code.
 * Everything about it is built around one rule: that code runs inside a container stripped
 * of every capability it does not need, and never on the host.
 *
 * WHY A FACADE. `ProbeSandbox` is an interface with one Docker-backed implementation, for
 * the same reason `AIFacade` is: the tests stay hermetic (no Docker, no network), and a
 * seam here means the runner's gate logic is testable without any container ever being
 * created. It also makes a different runtime (Podman, gVisor, Firecracker) a new
 * implementation rather than an edit to the gates.
 *
 * WHY IT OBSERVES FROM OUTSIDE. The container runs the image's OWN command, untouched, and
 * every fact is read out afterwards through separate `docker exec` / `docker logs` calls.
 * The alternative — injecting a script that prints ports and logs to one stream — would
 * mix trusted output with the probed process's own, and a repo that printed the section
 * banners could forge an observation. Keeping the streams separate makes that impossible
 * rather than merely unlikely, and means the probed process runs exactly as it would in
 * the real stack.
 *
 * WHAT IT NEVER DOES. It runs no host command other than `docker`; it never interpolates
 * anything into a host shell (execa takes an argv array, no shell); it mounts no host path
 * at all. A repo cannot write to the machine analysing it.
 *
 * STAGE: 2 (detect) / PHASE G — REAL code.
 */

import { randomUUID } from 'node:crypto';

import { execa } from 'execa';

import { loadSettings, type Settings } from '../config/settings.js';
import type { ProbeReading } from '../model/prober.js';

/** What to observe: an already-built image, run under isolation. */
export interface SandboxSpec {
  /** Image to run — built by compose from the repo's own Dockerfile. */
  image: string;
  /** How long to let the process settle before reading the container's state. */
  settleMs: number;
  /**
   * Wall-clock cap for the WHOLE run, not per docker call.
   *
   * Per-call was the wrong unit: a probe issues a `run`, a settle, four reads and a
   * `rm`, so a 60s "timeout" actually bounded the run at ~6 minutes, and a container
   * that hung every call hung for all of them. The deadline is computed once here and
   * every call gets whatever is left of it.
   */
  timeoutMs: number;
  /** Cancels the probe when the surrounding run is aborted. */
  signal?: AbortSignal;
}

/** One isolated run. The only way probe code executes. */
export interface ProbeSandbox {
  run(spec: SandboxSpec): Promise<ProbeReading>;
}

/** Cap on captured log bytes, so a chatty container cannot exhaust memory here. */
const MAX_LOG_BYTES = 8192;

/** Cap on process lines kept, for the same reason. */
const MAX_PROCESS_LINES = 64;

/**
 * Byte cap on what a single `docker` call may BUFFER, as opposed to what we keep.
 *
 * `MAX_LOG_BYTES` and `MAX_PROCESS_LINES` above bound what is RETAINED — they slice a
 * string that has already been read fully into memory, so on their own they bound nothing
 * that matters here. execa buffers an unbounded child stdout by default (measured: a 20 MB
 * single line is collected in full, no error), and `docker logs --tail 200` caps lines, not
 * bytes — so one container printing one enormous line made ORCA allocate it all before the
 * slice threw it away. That is a memory-exhaustion DoS delivered by the one feature that
 * runs untrusted code, against the machine analysing it.
 *
 * With `reject: false`, exceeding this truncates the output and flags the result rather
 * than throwing, so a hostile container yields the useful PREFIX of its logs instead of
 * either an empty reading or an OOM. 256 KiB is far above any honest reading (the largest
 * is `/proc/net/tcp`, itself bounded by `--pids-limit`) and far below unbounded.
 */
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;

/**
 * Environment passed to the `docker` CLI — the client's own configuration, and nothing
 * else.
 *
 * NOT `extendEnv: false` with an empty env, which is what this used to be. The intent
 * (don't hand the host's whole environment to a subprocess) was right, but it also stripped
 * `DOCKER_HOST`, `DOCKER_CONTEXT`, and `HOME` — and `HOME` is how the CLI finds
 * `~/.docker/config.json`, hence the user's active context. `src/build/docker.ts` runs with
 * `extendEnv: true`, so on any setup whose daemon is not the default local socket (rootless
 * Docker, Docker Desktop, an SSH or TLS context) the BUILD would succeed against the real
 * daemon while every probe silently talked to a different one and returned an empty
 * reading — indistinguishable, to the user, from "the app binds nothing".
 *
 * Passing the client variables through explicitly keeps the narrow surface and makes
 * probing work wherever building already works.
 */
export function dockerClientEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const passthrough = [
    'HOME',
    'PATH',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'XDG_RUNTIME_DIR',
  ];
  const passed: Record<string, string> = {};
  for (const key of passthrough) {
    const value = env[key];
    if (value !== undefined) passed[key] = value;
  }
  return passed;
}

/**
 * The flags that make a container safe to run untrusted code in. Exported so the tests can
 * assert the contract flag-by-flag: this list IS clause 1, and a change that quietly drops
 * `--network none` is a security regression, not a style change.
 *
 * `--memory-swap` equals `--memory` deliberately: without it Docker grants swap equal to
 * memory, silently doubling the real cap. `--read-only` plus a `noexec` tmpfs gives the
 * process somewhere to write without letting it drop a new executable where it could run
 * one.
 */
export function isolationArgs(settings: Settings): string[] {
  return [
    '--network',
    settings.probeNetwork,
    // A read-only root is the strictest setting that still lets most images start, but it
    // is also the one that most often stops them: plenty of real apps write a cache or a
    // pid file at startup and die instantly under it, which yields an empty reading and
    // looks like "the app binds nothing". Relaxing it is a deliberate, per-run choice —
    // the DEFAULT stays locked down, and everything else in this list is unconditional.
    ...(settings.probeReadOnlyRootfs ? ['--read-only'] : []),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    settings.probeMemory,
    '--memory-swap',
    settings.probeMemory,
    '--cpus',
    String(settings.probeCpus),
    '--pids-limit',
    String(settings.probePidsLimit),
  ];
}

/**
 * Read every process's argv from `/proc`, and the kernel's own record of what is bound.
 *
 * Ports come from `/proc/net/tcp` rather than from connecting to them, because the
 * container has no network to connect over — but the kernel still reports what the process
 * bound inside its own namespace, which is exactly the fact worth learning.
 */
const PORTS_COMMAND = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null';
const PROCS_COMMAND =
  'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline" 2>/dev/null; echo; done';

/**
 * Teardown gets its own small budget, independent of the run's deadline. Removing the
 * container is the one step that must still happen when everything else has been
 * cancelled or has run out of time.
 */
const CLEANUP_TIMEOUT_MS = 10_000;

/** Gap between readiness polls. Short enough to catch a fast starter, cheap to repeat. */
const POLL_INTERVAL_MS = 250;

/**
 * Wait `ms`, or resolve early if `signal` aborts. Never rejects: an aborted settle just
 * means "read the container's state now", and the caller's own abort handling decides
 * what happens next.
 */
function settle(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** An empty reading — what every failure path returns. */
function emptyReading(): ProbeReading {
  return { exitCode: null, timedOut: false, netTcp: '', processes: [], log: '' };
}

/**
 * The container's exit code, or null while it is still running.
 *
 * Takes `docker inspect --format '{{.State.Status}} {{.State.ExitCode}}'`. The status is
 * what makes the number meaningful: Docker reports `ExitCode: 0` for a running container,
 * so reading the code alone conflates "exited successfully" with "has not exited". Null
 * is the honest answer for the latter, and `null` is exactly what the field's type already
 * allowed for.
 */
export function parseExitCode(inspectOutput: string): number | null {
  const [status, code] = inspectOutput.trim().split(/\s+/);
  if (status === undefined || code === undefined) return null;
  // `running`, `created`, `paused`, `restarting` have not produced an exit code yet.
  if (status !== 'exited' && status !== 'dead') return null;
  const parsed = Number.parseInt(code, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * The Docker-backed sandbox. Creates one throwaway container per run, reads what it did,
 * and destroys it — including on the failure paths, which is why the `docker rm -f` sits
 * in a `finally` rather than after the read.
 */
export function dockerProbeSandbox(settings: Settings = loadSettings()): ProbeSandbox {
  return {
    async run(spec: SandboxSpec): Promise<ProbeReading> {
      const name = `orca-probe-${randomUUID()}`;
      // Set by any docker call that hits its wall-clock cap, so `ProbeReading.timedOut`
      // reports something real. It used to be hardcoded `false` on every path — a field
      // that could not be true, which is worse than no field at all: a caller reading it
      // would conclude the run completed when it may have been killed mid-flight.
      let timedOut = false;
      // ONE deadline for the whole probe, shared by every call below.
      const deadline = Date.now() + spec.timeoutMs;
      const remaining = (): number => Math.max(0, deadline - Date.now());
      const docker = (args: string[]): Promise<{ exitCode: number | null; stdout: string }> => {
        const budget = remaining();
        if (budget === 0) {
          timedOut = true;
          return Promise.resolve({ exitCode: null, stdout: '' });
        }
        return execa('docker', args, {
          reject: false,
          timeout: budget,
          maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
          env: dockerClientEnv(),
          extendEnv: false,
          // Cancellation propagates: Ctrl-C during a probe kills the docker call rather
          // than leaving the run waiting on it. The `finally` still removes the container.
          ...(spec.signal !== undefined ? { cancelSignal: spec.signal } : {}),
        }).then(
          (r) => {
            if (r.timedOut === true) timedOut = true;
            return {
              exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
              stdout: typeof r.stdout === 'string' ? r.stdout : '',
            };
          },
          (err: unknown) => {
            if ((err as { timedOut?: boolean })?.timedOut === true) timedOut = true;
            return { exitCode: null, stdout: '' };
          }
        );
      };

      try {
        // Detached, so the image's own command runs unmodified. `--rm` is deliberately
        // NOT set here: it would race the reads below by deleting the container the
        // instant a short-lived process exits, and the `finally` already guarantees
        // removal on every path.
        const started = await docker([
          'run',
          '--detach',
          '--name',
          name,
          ...isolationArgs(settings),
          // `--` ends flag parsing, so the image name can never be read as an option.
          // Docker's parser allows flags after positionals, so without this an image
          // string beginning with `-` would be parsed as one — `--privileged` being the
          // interesting case. No path today produces such a name (compose derives it and
          // rejects a leading dash), which is exactly why this is worth pinning: the
          // isolation flags above would be silently joined by one that undoes them.
          '--',
          spec.image,
        ]);
        if (started.exitCode !== 0) return emptyReading();

        // POLL, don't sleep. A fixed settle is wrong in both directions: a fast app is
        // ready in 200ms and the probe waited 3s anyway, while a slow one had not bound
        // its port yet and the probe recorded "binds nothing" as though that were a fact.
        // Stop as soon as the container is either listening or dead — there is nothing
        // further to learn by waiting in either case.
        const pollBudget = Math.min(spec.settleMs, remaining());
        const pollDeadline = Date.now() + pollBudget;
        let exited = false;
        for (;;) {
          const state = await docker([
            'inspect',
            '--format',
            '{{.State.Status}} {{.State.ExitCode}}',
            name,
          ]);
          exited = parseExitCode(state.stdout) !== null;
          if (exited) break;
          const listening = await docker(['exec', name, '/bin/sh', '-c', PORTS_COMMAND]);
          if (listening.stdout.includes(' 0A ')) break;
          if (Date.now() >= pollDeadline || spec.signal?.aborted === true) break;
          await settle(Math.min(POLL_INTERVAL_MS, pollDeadline - Date.now()), spec.signal);
        }

        // Both reads go through a shell INSIDE the container, so an image without one
        // (distroless) simply yields nothing here — the logs below still work, and a
        // partial reading is honest where a fabricated one would not be. `docker logs`
        // keeps working against an EXITED container, which is why a crashed app still
        // produces the most useful half of the reading rather than nothing at all.
        const [ports, procs, logs, inspect] = await Promise.all([
          docker(['exec', name, '/bin/sh', '-c', PORTS_COMMAND]),
          docker(['exec', name, '/bin/sh', '-c', PROCS_COMMAND]),
          docker(['logs', '--tail', '200', name]),
          // Status AND exit code together. `.State.ExitCode` alone reads 0 for a container
          // that is still RUNNING, which is indistinguishable from one that exited
          // cleanly — so `exitCode: 0` used to mean either "finished fine" or "has not
          // finished", and a caller could not tell which.
          docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', name]),
        ]);

        return {
          exitCode: parseExitCode(inspect.stdout),
          timedOut,
          netTcp: ports.stdout,
          processes: procs.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .slice(0, MAX_PROCESS_LINES),
          log: logs.stdout.slice(0, MAX_LOG_BYTES),
        };
      } catch {
        // A sandbox that cannot run is not a failed run: probing is additive, so a missing
        // or old Docker must never fail a pipeline that works fine without tier 4.
        return emptyReading();
      } finally {
        // Clause 4, unconditionally — including the paths where the container outlives
        // the client that started it.
        //
        // NOT through `docker()`: that call is bound to the run's deadline and to the
        // caller's AbortSignal, and both are precisely the states in which cleanup matters
        // most. A timed-out or Ctrl-C'd probe would otherwise skip its own teardown and
        // leave the container running — ephemerality has to be the one thing that cannot
        // be cancelled.
        await execa('docker', ['rm', '--force', name], {
          reject: false,
          timeout: CLEANUP_TIMEOUT_MS,
          maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
          env: dockerClientEnv(),
          extendEnv: false,
        }).catch(() => undefined);
      }
    },
  };
}
