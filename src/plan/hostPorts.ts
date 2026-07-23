import { createServer } from 'node:net';

import type { ServiceNode, ServicePlan } from './types.js';

const MAX_PORT = 65535;
const MAX_PROBES_PER_BINDING = 64;

export function isPrivileged(port: number): boolean {
  return port < 1024;
}

export function nextCandidate(port: number): number {
  const bumped = port + 1;
  return bumped > MAX_PORT ? 1024 : bumped;
}

export function assignUniqueHostPorts(services: ServiceNode[]): string[] {
  const taken = new Set<number>();
  const notes: string[] = [];

  for (const node of services) {
    for (const binding of node.ports) {
      if (!taken.has(binding.host)) {
        taken.add(binding.host);
        continue;
      }
      const original = binding.host;
      let candidate = nextCandidate(original);
      while (taken.has(candidate)) candidate = nextCandidate(candidate);
      binding.host = candidate;
      taken.add(candidate);
      notes.push(
        `${node.name}: host port ${original} is already claimed by another service in this ` +
          `stack — publishing on ${candidate} instead (container still listens on ${binding.container}).`
      );
    }
  }

  return notes;
}

export function hostPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const settle = (available: boolean): void => {
      server.removeAllListeners();
      server.close(() => resolve(available));
    };
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        server.removeAllListeners();
        resolve(false);
        return;
      }
      settle(true);
    });
    server.once('listening', () => settle(true));
    try {
      server.listen({ port, host: '0.0.0.0', exclusive: true });
    } catch {
      resolve(true);
    }
  });
}

export async function resolveHostPortConflicts(plan: ServicePlan): Promise<string[]> {
  const notes = assignUniqueHostPorts(plan.services);
  const claimed = new Set(plan.services.flatMap((n) => n.ports.map((p) => p.host)));

  for (const node of plan.services) {
    for (const binding of node.ports) {
      if (await hostPortAvailable(binding.host)) continue;

      const original = binding.host;
      let candidate = nextCandidate(original);
      let probes = 0;
      while (
        probes < MAX_PROBES_PER_BINDING &&
        (claimed.has(candidate) || !(await hostPortAvailable(candidate)))
      ) {
        candidate = nextCandidate(candidate);
        probes += 1;
      }

      if (probes >= MAX_PROBES_PER_BINDING) {
        notes.push(
          `${node.name}: host port ${original} is in use and no free port was found nearby — ` +
            `leaving it as-is; 'docker compose up' will fail if it is still taken.`
        );
        continue;
      }

      claimed.delete(original);
      claimed.add(candidate);
      binding.host = candidate;
      notes.push(
        `${node.name}: host port ${original} is already in use on this machine — publishing on ` +
          `${candidate} instead (container still listens on ${binding.container}).`
      );
    }
  }

  return notes;
}
