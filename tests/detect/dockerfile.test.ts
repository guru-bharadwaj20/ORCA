/**
 * PHASE C tests — deterministic Dockerfile analysis. Uses real Dockerfile fixtures
 * at the repo root and in common subdirectories, then asserts the parsed base image,
 * ports, start command, and working directory.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { analyzeDockerfiles } from '../../src/detect/dockerfile.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const dockerfileFor = (analysis: Awaited<ReturnType<typeof analyzeDockerfiles>>, rootDir: string) =>
  analysis.dockerfiles.find((dockerfile) => dockerfile.rootDir === rootDir);

describe('analyzeDockerfiles', () => {
  it('parses a root-level Node Dockerfile', async () => {
    const analysis = await analyzeDockerfiles(fixture('dockerfile-node-repo'));

    expect(analysis.found).toBe(true);
    expect(dockerfileFor(analysis, '.')).toMatchObject({
      baseImage: 'node:20-slim',
      exposedPorts: [3000],
      installCommands: ['npm ci'],
      buildCommands: ['npm run build'],
      startCommand: 'npm start',
      workingDir: '/app',
    });
  });

  it('finds a Python Dockerfile in a nested docker/ directory', async () => {
    const analysis = await analyzeDockerfiles(fixture('dockerfile-python-repo'));

    expect(analysis.found).toBe(true);
    expect(dockerfileFor(analysis, 'docker')).toMatchObject({
      baseImage: 'python:3.12-slim',
      exposedPorts: [8000],
      installCommands: ['pip install -r requirements.txt'],
      startCommand: 'python manage.py runserver 0.0.0.0:8000',
      workingDir: '/srv/app',
    });
  });

  it('parses a multi-stage Dockerfile in deploy/', async () => {
    const analysis = await analyzeDockerfiles(fixture('dockerfile-multistage-repo'));
    const dockerfile = dockerfileFor(analysis, 'deploy');

    expect(analysis.found).toBe(true);
    expect(dockerfile).toMatchObject({
      baseImage: 'nginx:1.27-alpine',
      exposedPorts: [80],
      buildCommands: ['npm run build'],
      startCommand: 'nginx -g daemon off;',
      workingDir: '/usr/share/nginx/html',
    });
  });
});
