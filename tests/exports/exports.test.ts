/**
 * Import-smoke test for the library surface (Phase 1, gap 1). Verifies the four
 * public barrels export the symbols an embedder (the VS Code extension) needs, and
 * that package.json's `exports` map advertises each subpath. Hermetic: imports the
 * source barrels through the same specifiers the package publishes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as root from '../../src/core/index.js';
import * as plan from '../../src/plan/index.js';
import * as config from '../../src/config/index.js';
import * as ai from '../../src/ai/index.js';

describe('library surface (subpath exports)', () => {
  it('orca-cli exposes the pipeline + context contract', () => {
    expect(typeof root.runPipeline).toBe('function');
    expect(typeof root.createRunContext).toBe('function');
    expect(root.DEFAULT_RUN_OPTIONS).toMatchObject({ dryRun: false });
  });

  it('orca-cli/plan exposes the diagram + plan model + review gate', () => {
    expect(typeof plan.renderDiagram).toBe('function');
    expect(typeof plan.buildServicePlan).toBe('function');
    expect(typeof plan.reviewPlan).toBe('function');
  });

  it('orca-cli/config exposes settings + the key-resolver seam', () => {
    expect(typeof config.loadSettings).toBe('function');
    expect(typeof config.envKeyResolver).toBe('function');
    expect(config.ENV_KEYS.qwenApiKey).toBe('QWEN_API_KEY');
  });

  it('orca-cli/ai exposes the facade + router', () => {
    expect(typeof ai.aiFor).toBe('function');
    expect(typeof ai.AIRouter).toBe('function');
    expect(typeof ai.defaultProviderFactories).toBe('function');
    expect(typeof ai.routerConfigForRun).toBe('function');
  });

  it('package.json advertises every subpath in its exports map', () => {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports: Record<string, { types: string; import: string }>;
    };
    const expected: Record<string, string> = {
      '.': './dist/core/index.js',
      './plan': './dist/plan/index.js',
      './config': './dist/config/index.js',
      './ai': './dist/ai/index.js',
    };
    for (const [subpath, importPath] of Object.entries(expected)) {
      expect(pkg.exports[subpath]?.import).toBe(importPath);
      expect(pkg.exports[subpath]?.types).toMatch(/\.d\.ts$/);
    }
  });
});
