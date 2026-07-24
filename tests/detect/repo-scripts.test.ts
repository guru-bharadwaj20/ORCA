/**
 * PHASE C tests — README and shell-script parsing as a deterministic detection source.
 *
 * Two things are being pinned here, and the second matters as much as the first:
 *   1. The clear cases extract the right commands and ports.
 *   2. The ambiguous case extracts NOTHING. A README of prose plus TOML/YAML config
 *      blocks must not be guessed at — that repo belongs to tier-3 AI inference, and a
 *      false positive here would be worse than silence.
 *
 * Also pinned: this source is strictly gap-filling. It never makes an otherwise
 * unsupported repo supported, and it contributes no confidence when a Dockerfile or CI
 * already spoke.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectStack } from '../../src/detect/index.js';
import { analyzeReadme } from '../../src/detect/readme.js';
import { analyzeShellScripts, extractShellCommands } from '../../src/detect/shellScript.js';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe('analyzeReadme', () => {
  it('extracts install/run commands and ports from fenced shell blocks', async () => {
    const analysis = await analyzeReadme(fixture('readme-only-repo'));

    expect(analysis.found).toBe(true);
    expect(analysis.file).toBe('README.md');
    expect(analysis.commands).toEqual([
      { command: 'npm install', kind: 'install' },
      { command: 'npm run dev', kind: 'start' },
      // The `$ ` prompt marker is stripped, and `python <script>` is recognized as a
      // start command even though ci.ts's classifier has no keyword for it.
      { command: 'python worker.py', kind: 'start' },
      // An unlabeled ``` block is accepted; the published mapping records the CONTAINER
      // port (4000), which is what the app actually serves on.
      { command: 'docker run -p 8080:4000 widget-api:latest', kind: 'start' },
    ]);
    expect(analysis.ports).toEqual([4000]);
  });

  it('drops setup noise rather than recording it as a build command', async () => {
    const analysis = await analyzeReadme(fixture('readme-only-repo'));
    const commands = analysis.commands.map((c) => c.command);

    // `git clone` / `cd` are in a ```bash block, but they describe getting the repo, not
    // building or running it.
    expect(commands.some((c) => c.startsWith('git '))).toBe(false);
    expect(commands.some((c) => c.startsWith('cd '))).toBe(false);
  });

  it('rejects non-shell fenced blocks wholesale, including the ports inside them', async () => {
    const analysis = await analyzeReadme(fixture('readme-only-repo'));

    // The ```json block declares "port": 9999 and the ```js block declares port: 1234.
    // Neither is shell, so neither contributes a command or a port.
    expect(analysis.ports).not.toContain(9999);
    expect(analysis.ports).not.toContain(1234);
    expect(analysis.commands.some((c) => c.command.includes('WidgetClient'))).toBe(false);
  });

  it('finds nothing in an ambiguous, prose-only README', async () => {
    const analysis = await analyzeReadme(fixture('readme-ambiguous-repo'));

    // Prose, a TOML block and a YAML block (both declaring port 7777), and a shell block
    // holding only clone/cd/export/source/curl. Nothing here states how the app builds.
    expect(analysis.found).toBe(false);
    expect(analysis.commands).toEqual([]);
    expect(analysis.ports).toEqual([]);
  });

  it('reports not-found when the repo has no README at all', async () => {
    const analysis = await analyzeReadme(fixture('shell-script-repo'));
    expect(analysis).toEqual({ found: false, file: '', commands: [], ports: [] });
  });
});

describe('analyzeShellScripts', () => {
  it('parses root scripts and scripts/*.sh, dropping shell bookkeeping', async () => {
    const analysis = await analyzeShellScripts(fixture('shell-script-repo'));

    expect(analysis.found).toBe(true);
    expect(analysis.scripts.map((s) => s.file)).toEqual(['start.sh', 'scripts/build.sh']);

    const start = analysis.scripts.find((s) => s.file === 'start.sh');
    expect(start?.commands).toEqual([
      { command: 'npm ci', kind: 'install' },
      { command: 'node server.js --port 5000', kind: 'start' },
    ]);
    expect(start?.ports).toEqual([5000]);

    // `set -euo pipefail`, `cd`, `export`, `source`, and `echo` are all dropped — note
    // the echo string mentions "port 5000" in prose and must not become a port.
    const commands = start?.commands.map((c) => c.command) ?? [];
    expect(commands.some((c) => /^(set|cd|export|source|echo)\b/.test(c))).toBe(false);
  });

  it('joins backslash-continued lines into a single command', async () => {
    const analysis = await analyzeShellScripts(fixture('shell-script-repo'));
    const build = analysis.scripts.find((s) => s.file === 'scripts/build.sh');

    expect(build?.commands).toEqual([
      { command: 'npm run build', kind: 'build' },
      { command: 'docker build -t widget-api:latest .', kind: 'build' },
    ]);
    // `widget-api:latest` is a tag, not a host:port — it must not yield a port.
    expect(build?.ports).toEqual([]);
  });

  it('reports not-found when the repo ships no conventional scripts', async () => {
    const analysis = await analyzeShellScripts(fixture('readme-only-repo'));
    expect(analysis.found).toBe(false);
    expect(analysis.scripts).toEqual([]);
  });
});

describe('extractShellCommands classification', () => {
  it('defers to ci.ts classifyCommand wherever it has an answer', () => {
    const { commands } = extractShellCommands([
      'npm install',
      'npm run build',
      'npm test',
      'pip install -r requirements.txt',
      'cargo build --release',
    ]);
    expect(commands).toEqual([
      { command: 'npm install', kind: 'install' },
      { command: 'npm run build', kind: 'build' },
      { command: 'npm test', kind: 'test' },
      { command: 'pip install -r requirements.txt', kind: 'install' },
      { command: 'cargo build --release', kind: 'build' },
    ]);
  });

  it('supplements only the run-shaped forms classifyCommand returns other for', () => {
    const { commands } = extractShellCommands([
      'python app.py',
      'python3 -m myapp',
      'node index.js',
      'go run .',
      'dotnet run',
      'flask run',
      'rails server',
      'docker-compose up',
      'docker compose up -d',
      'java -jar dist/app.jar',
    ]);
    expect(commands.every((c) => c.kind === 'start')).toBe(true);
    expect(commands).toHaveLength(10);
  });

  it('lets classifyCommand win even when a keyword appears in an argument path', () => {
    // Documented behavior, not an accident: ci.ts's classifier keyword-matches the whole
    // line, so a path containing "build" or "test" colours the result. Overriding that
    // for interpreter forms would regress the cases below, where the argument genuinely
    // IS the intent — so the shared classifier stays authoritative.
    const { commands } = extractShellCommands([
      'java -jar build/libs/app.jar',
      'python -m pytest',
      'python -m pip install requests',
    ]);
    expect(commands).toEqual([
      { command: 'java -jar build/libs/app.jar', kind: 'build' },
      { command: 'python -m pytest', kind: 'test' },
      { command: 'python -m pip install requests', kind: 'install' },
    ]);
  });

  it('drops recognized tools whose intent cannot be established', () => {
    // The leading token is known, but nothing says these build or run anything.
    const { commands } = extractShellCommands([
      'node --version',
      'python --help',
      'docker ps',
      'docker login registry.example.com',
    ]);
    expect(commands).toEqual([]);
  });

  it('extracts ports from flags and host:port mentions, ignoring bare numbers', () => {
    const { ports } = extractShellCommands([
      'docker run -p 8080:80 app',
      'uvicorn main:app --host 0.0.0.0 --port 8000',
      'python manage.py runserver 0.0.0.0:9000',
      'npm install --legacy-peer-deps',
    ]);
    expect(ports.sort((a, b) => a - b)).toEqual([80, 8000, 9000]);
  });
});

describe('scriptSources reaching DetectionResult.insights', () => {
  it('surfaces both a README and a shell script for the same repo', async () => {
    const result = await detectStack(fixture('readme-and-script-repo'));

    expect(result.insights.scriptSources.map((s) => s.source)).toEqual(['readme', 'shell-script']);

    const readme = result.insights.scriptSources.find((s) => s.source === 'readme');
    expect(readme?.file).toBe('README.md');
    expect(readme?.commands).toEqual([
      { command: 'npm install', kind: 'install' },
      { command: 'npm start', kind: 'start' },
    ]);
    expect(readme?.ports).toEqual([3001]);

    const script = result.insights.scriptSources.find((s) => s.source === 'shell-script');
    expect(script?.file).toBe('run.sh');
    expect(script?.commands).toEqual([
      { command: 'npm install', kind: 'install' },
      { command: 'node scripts/migrate.js', kind: 'start' },
      { command: 'npm start', kind: 'start' },
    ]);
  });

  it('contributes a confidence signal when no Dockerfile or CI already spoke', async () => {
    const result = await detectStack(fixture('readme-and-script-repo'));
    expect(result.reasoning.some((r) => r.startsWith('README/scripts declare the build'))).toBe(
      true
    );
  });

  it('stays silent on confidence when a Dockerfile already spoke', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'orca-scripts-'));
    try {
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { express: '^4.19.2' } })
      );
      await writeFile(join(repo, 'README.md'), '# App\n\n```bash\nnpm start\n```\n');
      await writeFile(
        join(repo, 'Dockerfile'),
        'FROM node:20-slim\nWORKDIR /app\nRUN npm install\nEXPOSE 3000\nCMD ["npm", "start"]\n'
      );

      const result = await detectStack(repo);

      // The README is still recorded as an insight …
      expect(result.insights.scriptSources.some((s) => s.source === 'readme')).toBe(true);
      // … but it adds no confidence, because a more authoritative source already spoke.
      expect(result.reasoning.some((r) => r.startsWith('README/scripts declare'))).toBe(false);
      expect(result.reasoning.some((r) => r.startsWith('Dockerfile parsed'))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('never makes an otherwise-unsupported repo supported', async () => {
    // readme-only-repo has clear, parseable run instructions and NO manifest at all.
    const result = await detectStack(fixture('readme-only-repo'));

    expect(result.insights.scriptSources.some((s) => s.source === 'readme')).toBe(true);
    expect(result.isSupported).toBe(false);
    expect(result.confidence).toBe(0);
  });
});

describe('scriptSources on repos that have neither', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'orca-noscripts-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('is an empty list, not undefined', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'bare' }));
    const result = await detectStack(repo);
    expect(result.insights.scriptSources).toEqual([]);
  });
});
