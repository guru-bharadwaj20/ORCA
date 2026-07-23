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

async function occupy(port: number): Promise<void> {
  const server = createServer();
  open.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '0.0.0.0' }, resolve);
  });
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
    await occupy(48231);

    await expect(hostPortAvailable(48231)).resolves.toBe(false);
    await expect(hostPortAvailable(48232)).resolves.toBe(true);
  });
});

describe('resolveHostPortConflicts', () => {
  it('moves a service off a port another process on the machine already holds', async () => {
    await occupy(48240);
    const plan = planOf(node('backend', 48240));

    const notes = await resolveHostPortConflicts(plan);

    expect(plan.services[0]?.ports[0]?.host).not.toBe(48240);
    expect(plan.services[0]?.ports[0]?.container).toBe(48240);
    expect(notes[0]).toMatch(/already in use on this machine/);
  });

  it('leaves an unconflicted plan exactly as it was', async () => {
    const plan = planOf(node('backend', 48250), node('frontend', 48251));

    await expect(resolveHostPortConflicts(plan)).resolves.toEqual([]);
    expect(plan.services.map((s) => s.ports[0]?.host)).toEqual([48250, 48251]);
  });
});
