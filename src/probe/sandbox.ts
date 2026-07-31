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
  /** Wall-clock cap for each docker call. */
  timeoutMs: number;
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
    'none',
    '--read-only',
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

/** An empty reading — what every failure path returns. */
function emptyReading(): ProbeReading {
  return { exitCode: null, timedOut: false, netTcp: '', processes: [], log: '' };
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
      const docker = (args: string[]): Promise<{ exitCode: number | null; stdout: string }> =>
        execa('docker', args, {
          reject: false,
          timeout: spec.timeoutMs,
          env: {},
          extendEnv: false,
        }).then(
          (r) => ({
            exitCode: typeof r.exitCode === 'number' ? r.exitCode : null,
            stdout: typeof r.stdout === 'string' ? r.stdout : '',
          }),
          () => ({ exitCode: null, stdout: '' })
        );

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
          spec.image,
        ]);
        if (started.exitCode !== 0) return emptyReading();

        await new Promise((resolve) => setTimeout(resolve, spec.settleMs));

        // Both reads go through a shell INSIDE the container, so an image without one
        // (distroless) simply yields nothing here — the logs below still work, and a
        // partial reading is honest where a fabricated one would not be.
        const [ports, procs, logs, inspect] = await Promise.all([
          docker(['exec', name, '/bin/sh', '-c', PORTS_COMMAND]),
          docker(['exec', name, '/bin/sh', '-c', PROCS_COMMAND]),
          docker(['logs', '--tail', '200', name]),
          docker(['inspect', '--format', '{{.State.ExitCode}}', name]),
        ]);

        const exitCode = Number.parseInt(inspect.stdout.trim(), 10);
        return {
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          timedOut: false,
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
        await docker(['rm', '--force', name]);
      }
    },
  };
}
