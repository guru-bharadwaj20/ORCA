/**
 * README-sourced ports — `DetectedPort.source: 'readme'`.
 *
 * `DetectedPort.source` has declared `'readme'` since the type was written, but nothing
 * ever emitted it: README ports lived only inside `insights.scriptSources`, with no
 * port-level record of where they came from. These tests pin the port reaching the
 * component, the plan, and the reasoning trail with that provenance intact.
 *
 * The other half of what they pin is what must NOT happen: README ports go through the
 * SAME merge as every other tier-1 source and are added last, so a port a Dockerfile or
 * the source code also declares keeps its stronger origin. There is no precedence rule
 * for README ports — being last in the existing sequence is the whole mechanism.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { createRunContext, DEFAULT_RUN_OPTIONS, type Logger } from '../../src/core/context.js';
import { runPipeline } from '../../src/core/pipeline.js';
import { detectStack } from '../../src/detect/index.js';
import { declaredPorts, detectPorts } from '../../src/detect/ports.js';

const docker = vi.hoisted(() => ({
  assertDockerAvailable: vi.fn(),
  composeBuild: vi.fn(),
  composeUp: vi.fn(),
  composeDown: vi.fn(),
  composeLogs: vi.fn(),
}));
vi.mock('../../src/build/docker.js', () => docker);

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

function silentLogger(): Logger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

describe('ACCEPTANCE: a README-only port reaches detection and the plan', () => {
  it('emits a DetectedPort with source readme and the right number', async () => {
    // readme-port-repo ships package.json + a README with `docker run -p 8080:8080`.
    // There is deliberately NO Dockerfile, so the README is the only declaring source.
    const detection = await detectStack(fixture('readme-port-repo'));

    expect(detection.backend?.ports).toEqual([{ port: 8080, protocol: 'tcp', source: 'readme' }]);
  });

  it('explains the choice in the reasoning trail', async () => {
    const detection = await detectStack(fixture('readme-port-repo'));
    expect(detection.reasoning).toContain('backend port 8080 read from the README');
  });

  it('publishes that port in the plan instead of the 3000 default', async () => {
    const output = new PassThrough();
    output.resume();
    const repo = fixture('readme-port-repo');
    const ctx = createRunContext({
      repoUrl: repo,
      workspaceDir: repo,
      logger: silentLogger(),
      options: { ...DEFAULT_RUN_OPTIONS, dryRun: true, autoApprove: true },
    });
    await runPipeline(ctx, { output });

    const backend = ctx.plan?.services.find((s) => s.id === 'backend');
    // The CONTAINER port is the assertion: it is what detection resolved. The host port
    // is deliberately not pinned — `resolveHostPortConflicts` probes the machine for a
    // free port and will legitimately publish on 8081 if 8080 is already taken locally.
    expect(backend?.ports).toHaveLength(1);
    expect(backend?.ports[0]?.container).toBe(8080);
  });
});

describe('README port extraction shapes', () => {
  let repo: string;

  const withReadme = async (body: string): Promise<string> => {
    repo = await mkdtemp(join(tmpdir(), 'orca-readme-port-'));
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x' }));
    await writeFile(join(repo, 'README.md'), body);
    return repo;
  };

  const cleanup = async (): Promise<void> => {
    if (repo) await rm(repo, { recursive: true, force: true });
  };

  it('reads a published mapping, a --port flag, a PORT= env, and a localhost URL', async () => {
    for (const [body, expected] of [
      ['# a\n\n```bash\ndocker run -p 9000:7000 app\n```\n', 7000],
      ['# a\n\n```bash\nnode server.js --port 4321\n```\n', 4321],
      ['# a\n\n```bash\nPORT=6543 npm start\n```\n', 6543],
      ['# a\n\nOpen http://localhost:5544 when it boots.\n', 5544],
    ] as const) {
      const dir = await withReadme(body);
      try {
        expect(await declaredPorts(dir)).toEqual([
          { port: expected, protocol: 'tcp', source: 'readme' },
        ]);
      } finally {
        await cleanup();
      }
    }
  });

  it('reads an EXPOSE line pasted into a fenced block', async () => {
    const dir = await withReadme('# a\n\n```\nEXPOSE 8181\n```\n');
    try {
      expect(await declaredPorts(dir)).toEqual([{ port: 8181, protocol: 'tcp', source: 'readme' }]);
    } finally {
      await cleanup();
    }
  });

  it('still finds nothing in a prose-only README with lowercase config blocks', async () => {
    // The false-positive guard. `port = 7777` (TOML) and `port: 7777` (YAML) are config,
    // not shell — matching them would defeat readme-ambiguous-repo's whole purpose.
    const dir = await withReadme(
      '# a\n\nSome prose.\n\n```toml\nport = 7777\n```\n\n```yaml\nport: 7777\n```\n'
    );
    try {
      expect(await declaredPorts(dir)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('ignores a dependency the README shows you how to start', async () => {
    // Regression: READMEs routinely document `docker run -p 5432:5432 postgres` to get a
    // database up. That is the app's DEPENDENCY, not the app — publishing the service on
    // 5432 is the same mistake `express-dbconfig-repo` exists to prevent, and
    // `portsFromCode` already filters these, so the README path filters them identically.
    const dir = await withReadme('# a\n\n```bash\ndocker run -p 5432:5432 postgres:16\n```\n');
    try {
      expect(await declaredPorts(dir)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('keeps the app port when the README documents both app and database', async () => {
    const dir = await withReadme(
      '# a\n\n```bash\ndocker run -p 5432:5432 postgres:16\ndocker run -p 4000:4000 app\n```\n'
    );
    try {
      expect(await declaredPorts(dir)).toEqual([{ port: 4000, protocol: 'tcp', source: 'readme' }]);
    } finally {
      await cleanup();
    }
  });

  it('does not mistake POSTGRES_PORT for the app port', async () => {
    const dir = await withReadme('# a\n\n```bash\nPOSTGRES_PORT=5432 npm start\n```\n');
    try {
      expect(await declaredPorts(dir)).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('README ports merge through the existing tier logic', () => {
  let repo: string;
  const cleanup = async (): Promise<void> => {
    if (repo) await rm(repo, { recursive: true, force: true });
  };

  it('yields to a Dockerfile EXPOSE for the same port, with no special-casing', async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-readme-merge-'));
    try {
      await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x' }));
      await writeFile(join(repo, 'README.md'), '# a\n\n```bash\ndocker run -p 8080:8080 x\n```\n');
      await writeFile(
        join(repo, 'Dockerfile'),
        'FROM node:20-slim\nEXPOSE 8080\nCMD ["npm", "start"]\n'
      );

      // Same port from two tiers → recorded once, attributed to the stronger source.
      // This falls out of `add()` keeping the first claimant; no reconciliation rule.
      expect(await declaredPorts(repo)).toEqual([
        { port: 8080, protocol: 'tcp', source: 'dockerfile' },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('keeps both when the README declares a port the Dockerfile does not', async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-readme-merge2-'));
    try {
      await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x' }));
      await writeFile(join(repo, 'README.md'), '# a\n\n```bash\ndocker run -p 9090:9090 x\n```\n');
      await writeFile(
        join(repo, 'Dockerfile'),
        'FROM node:20-slim\nEXPOSE 8080\nCMD ["npm", "start"]\n'
      );

      expect(await declaredPorts(repo)).toEqual([
        { port: 8080, protocol: 'tcp', source: 'dockerfile' },
        { port: 9090, protocol: 'tcp', source: 'readme' },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('does not let a README port suppress the role default for a listening role', async () => {
    // A README with no port at all still falls through to the default, unchanged.
    repo = await mkdtemp(join(tmpdir(), 'orca-readme-default-'));
    try {
      await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x' }));
      await writeFile(join(repo, 'README.md'), '# a\n\nNothing runnable here.\n');
      expect(await detectPorts(repo, 'backend')).toEqual([
        { port: 3000, protocol: 'tcp', source: 'default' },
      ]);
    } finally {
      await cleanup();
    }
  });
});
