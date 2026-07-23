import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { planToComposeVars } from '../../src/generate/composeVars.js';
import { buildServicePlan } from '../../src/plan/servicePlan.js';
import { renderCompose } from '../../src/templates/render.js';

const execFileAsync = promisify(execFile);

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function dockerComposeAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['compose', 'version'], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerComposeAvailable();
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function renderToDisk(name: string): Promise<string> {
  const detection = await detectStack(fixture(name));
  const plan = buildServicePlan(detection, {});
  const dir = await mkdtemp(join(tmpdir(), 'orca-compose-'));
  dirs.push(dir);
  await writeFile(join(dir, 'docker-compose.yml'), renderCompose(planToComposeVars(plan)), 'utf8');
  return dir;
}

// `docker compose config` is the parser/validator the real run hits first. It needs the
// docker CLI but neither a daemon nor a network, so it stays hermetic where available
// and is skipped where it is not.
describe.runIf(hasDocker)('generated compose passes docker compose config', () => {
  for (const name of ['mern-repo', 'django-postgres-repo', 'react-express-nodb-repo']) {
    it(`${name} validates`, async () => {
      const dir = await renderToDisk(name);

      await expect(
        execFileAsync('docker', ['compose', 'config', '--quiet'], { cwd: dir, timeout: 60_000 })
      ).resolves.toBeDefined();
    }, 90_000);
  }
});

describe('a repo with no database still produces a usable stack', () => {
  it('detects both components, plans no named volumes, and omits the volumes key', async () => {
    const detection = await detectStack(fixture('react-express-nodb-repo'));

    expect(detection.isSupported).toBe(true);
    expect(detection.frontend?.framework).toBe('react');
    expect(detection.backend?.framework).toBe('express');
    expect(detection.databases).toEqual([]);

    const plan = buildServicePlan(detection, {});
    expect(plan.services.map((s) => s.id)).toEqual(['backend', 'frontend']);
    expect(plan.volumes).toEqual([]);

    const composeText = renderCompose(planToComposeVars(plan));
    expect(composeText).not.toMatch(/^volumes:/m);
  });
});
