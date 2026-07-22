import { describe, expect, it } from 'vitest';

import { refineDockerfileVars } from '../../src/ai/refineVars.js';
import { FilledTemplateVarsSchema, validateAgainst } from '../../src/ai/schema.js';
import type { DockerfileVars } from '../../src/templates/types.js';

const defaults: DockerfileVars = {
  baseImage: 'node:20-slim',
  workdir: '/app',
  packageManager: 'npm',
  dependencyFiles: ['package.json'],
  installCommand: 'npm install',
  startCommand: 'npm run dev',
  port: 3000,
};

describe('typed AI-output boundary', () => {
  it('merges AI refinements over defaults, keeping everything the AI omitted', () => {
    const filled = validateAgainst(FilledTemplateVarsSchema, {
      variables: { baseImage: 'node:22-slim', port: 8080 },
      notes: ['README pins Node 22 and port 8080.'],
    });

    const refined = refineDockerfileVars(defaults, filled);

    expect(refined).toEqual({
      ...defaults,
      baseImage: 'node:22-slim',
      port: 8080,
    });
    expect(defaults.port).toBe(3000);
  });

  it('coerces lenient model output: numeric-string ports and space-separated lists', () => {
    const filled = validateAgainst(FilledTemplateVarsSchema, {
      variables: {
        port: '8000',
        dependencyFiles: 'requirements.txt constraints.txt',
        systemPackages: 'libpq-dev gcc',
      },
    });

    expect(filled.variables.port).toBe(8000);
    expect(filled.variables.dependencyFiles).toEqual(['requirements.txt', 'constraints.txt']);
    expect(filled.variables.systemPackages).toEqual(['libpq-dev', 'gcc']);
  });

  it('strips unknown variable names instead of propagating them', () => {
    const filled = validateAgainst(FilledTemplateVarsSchema, {
      variables: { baseImage: 'node:20-slim', exposePort: 3000, USER: 'root' },
    });

    expect(filled.variables).toEqual({ baseImage: 'node:20-slim' });
  });

  it('rejects out-of-range ports and unsupported package managers', () => {
    expect(() =>
      validateAgainst(FilledTemplateVarsSchema, { variables: { port: 99999 } })
    ).toThrowError(/schema validation/);
    expect(() =>
      validateAgainst(FilledTemplateVarsSchema, { variables: { packageManager: 'cargo' } })
    ).toThrowError(/schema validation/);
  });

  it('never lets an empty dependencyFiles clobber the default, but honors empty systemPackages', () => {
    const filled = validateAgainst(FilledTemplateVarsSchema, {
      variables: { dependencyFiles: [], systemPackages: [] },
    });

    const refined = refineDockerfileVars(
      { ...defaults, systemPackages: ['libpq-dev', 'gcc'] },
      filled
    );

    expect(refined.dependencyFiles).toEqual(['package.json']);
    expect(refined.systemPackages).toEqual([]);
  });
});
