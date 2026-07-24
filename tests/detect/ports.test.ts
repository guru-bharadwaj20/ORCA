/**
 * Port detection over a real temp repo tree. Covers the source ordering (env → container
 * file → code → default) and, in particular, that a `Containerfile`'s EXPOSE is honored —
 * the detector recognizes Containerfiles everywhere else, so the port lookup must too.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectPorts } from '../../src/detect/ports.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-ports-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectPorts', () => {
  it('reads EXPOSE from a Containerfile, not just a Dockerfile', async () => {
    await writeFile(
      join(dir, 'Containerfile'),
      'FROM node:20-slim\nEXPOSE 8080\nCMD ["node","."]\n'
    );
    const ports = await detectPorts(dir, 'backend');

    expect(ports).toEqual([{ port: 8080, protocol: 'tcp', source: 'dockerfile' }]);
  });

  it('reads EXPOSE from a suffixed Dockerfile.prod variant', async () => {
    await writeFile(join(dir, 'Dockerfile.prod'), 'FROM node:20-slim\nEXPOSE 4321\n');
    const ports = await detectPorts(dir, 'backend');

    expect(ports.map((p) => p.port)).toEqual([4321]);
    expect(ports[0]?.source).toBe('dockerfile');
  });

  it('honors a JSON-array / multi-port EXPOSE line', async () => {
    await writeFile(join(dir, 'Dockerfile'), 'FROM nginx\nEXPOSE 80 443\n');
    const ports = await detectPorts(dir, 'frontend');

    expect(ports.map((p) => p.port)).toEqual([80, 443]);
  });

  it('prefers an .env PORT over the container file', async () => {
    await writeFile(join(dir, '.env'), 'PORT=7000\n');
    await writeFile(join(dir, 'Dockerfile'), 'FROM node:20-slim\nEXPOSE 8080\n');
    const ports = await detectPorts(dir, 'backend');

    expect(ports[0]).toEqual({ port: 7000, protocol: 'tcp', source: 'env' });
  });

  it('falls back to the role default when nothing declares a port', async () => {
    const ports = await detectPorts(dir, 'backend');

    expect(ports).toEqual([{ port: 3000, protocol: 'tcp', source: 'default' }]);
  });
});
