/**
 * Export-map smoke — proves the published library surface actually resolves:
 * a spawned node process imports every subpath via package self-reference
 * against the built `dist/`. Skipped when `dist/` hasn't been built yet
 * (CI always builds first).
 */
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const hasDist = existsSync(join(root, 'dist/index.js'));

// Self-reference only resolves from a module inside the package, so the probe
// runs as a throwaway file in the repo root rather than `node -e`.
const PROBE = `
const core = await import('orca-cli');
const plan = await import('orca-cli/plan');
const ai = await import('orca-cli/ai');
const config = await import('orca-cli/config');
console.log(
  [
    typeof core.runPipeline,
    typeof core.createRunContext,
    typeof plan.buildServicePlan,
    typeof plan.renderDiagram,
    typeof ai.AIRouter,
    typeof ai.aiFor,
    typeof config.loadSettings,
  ].join(',')
);
`;

describe('package export map', () => {
  it.skipIf(!hasDist)('exposes the library surface via subpath exports', async () => {
    const probePath = join(root, '.orca-exports-smoke.mjs');
    await writeFile(probePath, PROBE, 'utf8');
    try {
      const { stdout } = await execa('node', [probePath], { cwd: root });
      expect(stdout.trim()).toBe('function,function,function,function,function,function,function');
    } finally {
      await rm(probePath, { force: true });
    }
  });
});
