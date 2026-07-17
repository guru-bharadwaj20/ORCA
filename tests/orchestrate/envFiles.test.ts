/**
 * Env-file generation tests — dedupe against the plan, explainable comments,
 * quoting, and the invalid-name guard.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import type { InferredEnv } from '../../src/ai/schema.js';
import { detectStack } from '../../src/detect/index.js';
import { buildEnvFile, selectEnvVars } from '../../src/orchestrate/envFiles.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function mernPlan(inferred: InferredEnv | null = null) {
  const detection = await detectStack(fixture('mern-repo'));
  return buildServicePlan(detection, {}, inferred);
}

const inferred: InferredEnv = {
  variables: [
    // Already injected inline by the plan (backend MONGO_URL) → must be skipped.
    { key: 'MONGO_URL', value: 'mongodb://db:27017/orca', required: true, reason: 'db url' },
    { key: 'JWT_SECRET', value: 'change-me', required: true, reason: 'README says auth needs it' },
    { key: 'LOG_LEVEL', value: 'debug', required: false, reason: 'optional tuning from README' },
    { key: 'BAD KEY!', value: 'x', required: true, reason: 'invalid name must be dropped' },
  ],
};

describe('selectEnvVars / buildEnvFile', () => {
  it('keeps only valid vars the plan does not already inject', async () => {
    const plan = await mernPlan();
    expect(selectEnvVars(inferred, plan).map((v) => v.key)).toEqual(['JWT_SECRET', 'LOG_LEVEL']);
  });

  it('renders an explainable .env with required markers and reasons', async () => {
    const text = buildEnvFile(inferred, await mernPlan());

    expect(text).toContain('JWT_SECRET=change-me');
    expect(text).toContain('# (required) README says auth needs it');
    expect(text).toContain('LOG_LEVEL=debug');
    expect(text).toContain('# optional tuning from README');
    expect(text).not.toContain('MONGO_URL'); // plan-owned wiring never duplicated
    expect(text).not.toContain('BAD KEY');
  });

  it('quotes values containing spaces or comment characters', async () => {
    const text = buildEnvFile(
      { variables: [{ key: 'MOTD', value: 'hello world # hi', required: false, reason: 'r' }] },
      await mernPlan()
    );
    expect(text).toContain('MOTD="hello world # hi"');
  });

  it('returns "" when every var is covered by the plan', async () => {
    const onlyCovered: InferredEnv = {
      variables: [{ key: 'MONGO_URL', value: 'x', required: true, reason: 'r' }],
    };
    expect(buildEnvFile(onlyCovered, await mernPlan())).toBe('');
  });

  it('attaches env_file to the backend node exactly when vars survive', async () => {
    const withVars = await mernPlan(inferred);
    expect(withVars.services.find((s) => s.id === 'backend')?.envFile).toBe('.env');

    const withoutVars = await mernPlan({
      variables: [{ key: 'MONGO_URL', value: 'x', required: true, reason: 'r' }],
    });
    expect(withoutVars.services.find((s) => s.id === 'backend')?.envFile).toBeUndefined();
  });
});
