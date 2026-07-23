import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assignUniqueHostPorts,
  hostPortAvailable,
  resolveHostPortConflicts,
} from '../../src/plan/hostPorts.js';
import type { ServiceNode, ServicePlan } from '../../src/plan/types.js';

const node = (id: string, host: number, container = host): ServiceNode => ({
  id,
  name: id,
  kind: 'backend',
  source: { type: 'build', context: '.', dockerfile: 'Dockerfile' },
  ports: [{ host, container, protocol: 'tcp' }],
  environment: {},
  dependsOn: [],
  volumes: [],
});

const planOf = (...services: ServiceNode[]): ServicePlan => ({
  projectName: 'orca-test',
  services,
  networks: ['orca-net'],
  volumes: [],
  createdAt: new Date().toISOString(),
  source: 'template',
});

const open: Server[] = [];

/**
 * Bind an ephemeral port (`:0`), read the number the OS assigned, then release it. The
 * OS won't immediately re-hand that number out, so it's a port that is *currently free*
 * without hardcoding a specific value that a busy CI runner might already hold. Returns
 * that number for use as a "known-free" port in assertions.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ port: 0, host: '0.0.0.0' }, () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Occupy a real, currently-free port and return it — so the "in use" cases are exact. */
async function occupy(): Promise<number> {
  const server = createServer();
  open.push(server);
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  return port;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('assignUniqueHostPorts', () => {
  it('moves the second claimant off a port two services both want', () => {
    const services = [node('backend', 3000), node('frontend', 3000)];
    const notes = assignUniqueHostPorts(services);

    expect(services[0]?.ports[0]?.host).toBe(3000);
    expect(services[1]?.ports[0]?.host).toBe(3001);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/frontend/);
  });

  it('leaves the container port untouched when it remaps the host side', () => {
    const services = [node('backend', 3000), node('frontend', 3000)];
    assignUniqueHostPorts(services);

    expect(services[1]?.ports[0]?.container).toBe(3000);
  });

  it('says nothing when every service already has its own port', () => {
    const services = [node('backend', 3000), node('frontend', 5173)];
    expect(assignUniqueHostPorts(services)).toEqual([]);
    expect(services.map((s) => s.ports[0]?.host)).toEqual([3000, 5173]);
  });
});

describe('hostPortAvailable', () => {
  it('reports a bound port as unavailable and a free one as available', async () => {
    const busy = await occupy();
    const free = await freePort();

    await expect(hostPortAvailable(busy)).resolves.toBe(false);
    await expect(hostPortAvailable(free)).resolves.toBe(true);
  });
});

describe('resolveHostPortConflicts', () => {
  it('moves a service off a port another process on the machine already holds', async () => {
    const busy = await occupy();
    const plan = planOf(node('backend', busy));

    const notes = await resolveHostPortConflicts(plan);

    expect(plan.services[0]?.ports[0]?.host).not.toBe(busy);
    expect(plan.services[0]?.ports[0]?.container).toBe(busy);
    expect(notes[0]).toMatch(/already in use on this machine/);
  });

  it('leaves an unconflicted plan exactly as it was', async () => {
    // Two servers bound at once guarantees distinct numbers; releasing them makes both
    // free for the assertion (the OS holds them out of rotation briefly after close).
    const held = [await occupy(), await occupy()];
    const [a, b] = held;
    await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))));
    const plan = planOf(node('backend', a as number), node('frontend', b as number));

    await expect(resolveHostPortConflicts(plan)).resolves.toEqual([]);
    expect(plan.services.map((s) => s.ports[0]?.host)).toEqual([a, b]);
  });
});
