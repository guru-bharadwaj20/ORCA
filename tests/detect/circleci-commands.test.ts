/**
 * CircleCI reusable `commands:` — resolving the indirection between a job and its work.
 *
 * A 2.1 config routinely hoists its real steps into a top-level `commands:` block, so a
 * job's `steps:` list can name commands and contain no `run:` of its own. Before this
 * pass, such a job recovered nothing at all.
 *
 * The half of this file that matters most is what must NOT happen. Expansion touches every
 * config CircleCI has, so an orb reference, an unknown name, a cycle, or a parameter with
 * no value all have to degrade to "recovered nothing here" — never a throw, and never a
 * literal `<< parameters.x >>` leaking into a Dockerfile RUN.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeCircleCi } from '../../src/detect/circleci.js';
import { detectStack } from '../../src/detect/index.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** The recovered command strings for one job of the first parsed config. */
async function commandsOf(repo: string, job: string): Promise<string[]> {
  const analysis = await analyzeCircleCi(repo);
  return (
    analysis.configs[0]?.jobs.find((j) => j.name === job)?.commands.map((c) => c.command) ?? []
  );
}

describe('ACCEPTANCE: a job step that references a top-level command', () => {
  it("recovers the command's own run: steps", async () => {
    // `build` declares no `run:` of its own beyond `npm test`; `npm ci` exists only inside
    // commands.install-deps, reached via commands.build-app.
    expect(await commandsOf(fixture('circleci-commands-repo'), 'build')).toEqual([
      'npm ci',
      'npm run build -- --mode production',
      'npm test',
    ]);
  });

  it('substitutes a simple string parameter passed by the invoking step', async () => {
    expect(await commandsOf(fixture('circleci-commands-repo'), 'deploy')).toContain(
      'npm run build -- --mode staging'
    );
  });

  it('falls back to the parameter default when the step passes no argument', async () => {
    const build = await commandsOf(fixture('circleci-commands-repo'), 'build');
    expect(build).toContain('npm run build -- --mode production');
  });

  it('resolves a command that invokes another command and forwards a parameter', async () => {
    // build-app forwards its own `pkg-manager` default down into install-deps, so `npm ci`
    // only appears if substitution survives two levels of nesting.
    for (const job of ['build', 'deploy']) {
      expect(await commandsOf(fixture('circleci-commands-repo'), job)).toContain('npm ci');
    }
  });

  it('leaves no empty or unsubstituted entry anywhere in the output', async () => {
    const analysis = await analyzeCircleCi(fixture('circleci-commands-repo'));
    for (const job of analysis.configs[0]!.jobs) {
      for (const { command } of job.commands) {
        expect(command.trim()).not.toBe('');
        expect(command).not.toContain('<<');
        expect(command).not.toContain('parameters.');
      }
    }
  });

  it('reaches recovered build commands through detectStack', async () => {
    const result = await detectStack(fixture('circleci-commands-repo'));
    const recovered = result.insights.recoveredBuild;

    expect(recovered?.installCommands).toContain('npm ci');
    expect(recovered?.startCommand).toBe('npm start');
  });

  it('leaves workflow ordering untouched by the expansion pass', async () => {
    const analysis = await analyzeCircleCi(fixture('circleci-commands-repo'));
    expect(analysis.configs[0]?.stages).toEqual(['main:build', 'main:deploy']);
  });
});

describe('references that cannot be resolved', () => {
  let repo: string;
  const write = async (yaml: string): Promise<void> => {
    await mkdir(join(repo, '.circleci'), { recursive: true });
    await writeFile(join(repo, '.circleci', 'config.yml'), yaml);
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-circle-cmd-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('skips an orb command without throwing or emitting an entry', async () => {
    await write(
      'version: 2.1\n' +
        'orbs:\n  node: circleci/node@5.2.0\n' +
        'jobs:\n  build:\n    steps:\n' +
        '      - node/install-packages\n' +
        '      - node/run:\n          npm-run: build\n' +
        '      - run: npm test\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm test']);
  });

  it('skips a name that matches no command and no orb', async () => {
    await write(
      'version: 2.1\njobs:\n  build:\n    steps:\n      - nonexistent\n      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci']);
  });

  it('drops a step whose parameter has neither an argument nor a default', async () => {
    // Rather than emitting the literal `./deploy.sh << parameters.env >>`, which would
    // reach a Dockerfile RUN verbatim.
    await write(
      'version: 2.1\n' +
        'commands:\n  deploy-to:\n    parameters:\n      env:\n        type: string\n' +
        '    steps:\n      - run: ./deploy.sh << parameters.env >>\n' +
        'jobs:\n  build:\n    steps:\n      - deploy-to\n      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci']);
  });

  it('drops a step interpolating a pipeline parameter it cannot know', async () => {
    await write(
      'version: 2.1\n' +
        'commands:\n  tag:\n    steps:\n      - run: docker tag app:<< pipeline.number >>\n' +
        'jobs:\n  build:\n    steps:\n      - tag\n      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci']);
  });

  it('keeps a shell heredoc that merely looks like an interpolation', async () => {
    // Regression: `cat << 'EOF' >> file` matches a naive /<<[^>]*>>/ and was being dropped
    // as an unresolved parameter. It is ordinary CI work and must survive untouched.
    await write(
      'version: 2.1\n' +
        "commands:\n  npmrc:\n    steps:\n      - run: cat << 'EOF' >> .npmrc\n" +
        'jobs:\n  build:\n    steps:\n      - npmrc\n      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(["cat << 'EOF' >> .npmrc", 'npm ci']);
  });

  it('keeps a heredoc in a plain inline run, with no commands: block in play', async () => {
    await write(
      'version: 2.1\njobs:\n  build:\n    steps:\n' +
        "      - run: cat << 'EOF' >> .npmrc\n" +
        '      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(["cat << 'EOF' >> .npmrc", 'npm ci']);
  });

  it('terminates on a cycle between two commands instead of recursing forever', async () => {
    await write(
      'version: 2.1\n' +
        'commands:\n' +
        '  a:\n    steps:\n      - run: echo a\n      - b\n' +
        '  b:\n    steps:\n      - run: echo b\n      - a\n' +
        'jobs:\n  build:\n    steps:\n      - a\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['echo a', 'echo b']);
  });

  it('ignores a commands: entry that declares no steps', async () => {
    await write(
      'version: 2.1\n' +
        'commands:\n  broken:\n    description: nothing here\n' +
        'jobs:\n  build:\n    steps:\n      - broken\n      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci']);
  });

  it('ignores a malformed commands: section rather than failing the whole parse', async () => {
    await write(
      'version: 2.1\ncommands: not-a-map\njobs:\n  build:\n    steps:\n      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci']);
  });
});

describe('steps that are not command references', () => {
  let repo: string;
  const write = async (yaml: string): Promise<void> => {
    await mkdir(join(repo, '.circleci'), { recursive: true });
    await writeFile(join(repo, '.circleci', 'config.yml'), yaml);
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-circle-builtin-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('never treats a built-in step as a command, even when one shares its name', async () => {
    // A `commands:` entry named `checkout` must not hijack the built-in step.
    await write(
      'version: 2.1\n' +
        'commands:\n  checkout:\n    steps:\n      - run: echo hijacked\n' +
        'jobs:\n  build:\n    steps:\n      - checkout\n      - run: npm ci\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci']);
  });

  it('passes cache and workspace plumbing through untouched', async () => {
    await write(
      'version: 2.1\njobs:\n  build:\n    steps:\n' +
        '      - restore_cache:\n          keys: [v1-deps]\n' +
        '      - run: npm ci\n' +
        '      - save_cache:\n          key: v1-deps\n          paths: [node_modules]\n' +
        '      - persist_to_workspace:\n          root: .\n          paths: [dist]\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci']);
  });

  it('leaves a config with no commands: block behaving exactly as before', async () => {
    // Regression guard: the pass must be inert for the configs that already worked.
    const analysis = await analyzeCircleCi(fixture('circleci-repo'));
    const byName = new Map(analysis.configs[0]!.jobs.map((j) => [j.name, j.commands]));

    expect(byName.get('build')?.map((c) => c.command)).toEqual(['npm ci', 'npm run build']);
    expect(byName.get('test')?.map((c) => c.command)).toEqual(['npm test']);
  });

  it('expands a bare string reference the same as a mapping reference', async () => {
    await write(
      'version: 2.1\n' +
        'commands:\n  setup:\n    steps:\n      - run: npm ci\n' +
        'jobs:\n  a:\n    steps:\n      - setup\n  b:\n    steps:\n      - setup: {}\n'
    );
    expect(await commandsOf(repo, 'a')).toEqual(['npm ci']);
    expect(await commandsOf(repo, 'b')).toEqual(['npm ci']);
  });

  it('keeps every line of a multi-line run inside an expanded command', async () => {
    await write(
      'version: 2.1\n' +
        'commands:\n  setup:\n    steps:\n      - run:\n          command: |\n' +
        '            npm ci\n            npm run build\n' +
        'jobs:\n  build:\n    steps:\n      - setup\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm ci', 'npm run build']);
  });

  it('substitutes a numeric parameter as well as a string one', async () => {
    await write(
      'version: 2.1\n' +
        'commands:\n  test:\n    parameters:\n      jobs:\n        type: integer\n        default: 4\n' +
        '    steps:\n      - run: npm test -- --maxWorkers << parameters.jobs >>\n' +
        'jobs:\n  build:\n    steps:\n      - test:\n          jobs: 8\n'
    );
    expect(await commandsOf(repo, 'build')).toEqual(['npm test -- --maxWorkers 8']);
  });
});
