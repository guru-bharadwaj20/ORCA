import { describe, expect, it } from 'vitest';

import { renderDiagnosisLog, renderPlanTable } from '../../src/cli/output.js';
import type { DiagnosisEntry } from '../../src/core/context.js';
import type { ServicePlan } from '../../src/plan/types.js';

const plan: ServicePlan = {
  projectName: 'orca-test',
  services: [
    {
      id: 'db',
      name: 'db',
      kind: 'database',
      source: { type: 'image', image: 'postgres:16' },
      ports: [{ host: 5432, container: 5432, protocol: 'tcp' }],
      environment: {},
      dependsOn: [],
      volumes: [],
    },
    {
      id: 'backend',
      name: 'backend',
      kind: 'backend',
      source: { type: 'build', context: './server', dockerfile: 'Dockerfile' },
      ports: [{ host: 3000, container: 3000, protocol: 'tcp' }],
      environment: {},
      dependsOn: [{ serviceId: 'db', condition: 'service_healthy' }],
      volumes: [],
    },
  ],
  networks: ['orca-net'],
  volumes: [],
  createdAt: new Date().toISOString(),
  source: 'template',
};

const entry: DiagnosisEntry = {
  attempt: 1,
  errorSignature: 'npm ERR! missing script: dev',
  explanation: 'The start command points at a script the repo does not define.',
  fix: 'Rewrite the compose command to use npm start.',
  changedFiles: ['docker-compose.yml'],
  resolved: true,
  timestamp: new Date().toISOString(),
};

describe('renderPlanTable', () => {
  it('lists every service with its source and dependency conditions', () => {
    const table = renderPlanTable(plan);

    expect(table).toContain('postgres:16');
    expect(table).toContain('build ./server (Dockerfile)');
    expect(table).toContain('db (service_healthy)');
    expect(table).toContain('3000:3000');
  });
});

describe('renderDiagnosisLog', () => {
  it('renders an attempt-by-attempt plain-English log', () => {
    const log = renderDiagnosisLog([entry, { ...entry, attempt: 2, resolved: false }]);

    expect(log).toContain('Attempt 1:');
    expect(log).toContain('does not define');
    expect(log).toContain('npm start');
    expect(log).toContain('docker-compose.yml');
    expect(log).toContain('resolved — the next attempt succeeded');
    expect(log).toContain('did not resolve the failure');
  });

  it('returns an empty string when there were no heal attempts', () => {
    expect(renderDiagnosisLog([])).toBe('');
  });
});
