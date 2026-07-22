/**
 * Integration test — the Phase-B/C signals reaching DetectionResult.insights end to
 * end through detectStack, on a synthesized repo (Turborepo + CI + a Go service). This
 * exercises the wiring in src/detect/index.ts's gatherInsights, not the units in
 * isolation.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'orca-insights-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('detectStack insights integration', () => {
  it('surfaces monorepo tooling, an ecosystem runtime, and CI signals together', async () => {
    // Root: a Turborepo monorepo with a CI workflow pinning Go 1.23.
    await writeFile(join(repo, 'turbo.json'), JSON.stringify({ pipeline: {} }));
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['api'] })
    );
    const wf = join(repo, '.github', 'workflows');
    await mkdir(wf, { recursive: true });
    await writeFile(
      join(wf, 'ci.yml'),
      [
        'jobs:',
        '  build:',
        '    steps:',
        '      - uses: actions/setup-go@v5',
        '        with:',
        "          go-version: '1.23'",
        '      - run: go build ./...',
      ].join('\n')
    );
    // A Go service component with a gin dependency (first-level candidate root).
    const svc = join(repo, 'api');
    await mkdir(svc, { recursive: true });
    await writeFile(
      join(svc, 'go.mod'),
      'module example.com/api\n\ngo 1.23\n\nrequire github.com/gin-gonic/gin v1.9.1\n'
    );

    const result = await detectStack(repo);

    expect(result.insights.monorepoTools).toEqual(expect.arrayContaining(['turborepo', 'npm']));
    expect(result.insights.runtimes).toContain('go');
    expect(result.insights.frameworks).toContain('gin');
    expect(result.insights.ciRuntimeVersions).toContainEqual({ runtime: 'go', version: '1.23' });
    expect(result.insights.ciCommands.some((c) => c.kind === 'build')).toBe(true);
  });
});
