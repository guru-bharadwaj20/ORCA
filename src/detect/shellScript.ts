/**
 * Repository-understanding signals (Phase-3 spec): recover build/run commands from the
 * shell scripts a repo ships as its own entrypoints — `start.sh`, `run.sh`, `dev.sh`,
 * `scripts/*.sh`, `bin/*.sh`. Sibling of `taskRunners.ts`: same category of signal (the
 * maintainer's own stated commands), same tier-1 rung, same advisory placement in
 * `DetectionResult.insights`.
 *
 * This module also owns the shared shell-line extraction core, which `readme.ts` reuses
 * for fenced code blocks — mirroring how the CI provider parsers reuse `ci.ts`'s
 * `classifyCommand` rather than each re-deriving it.
 *
 * DELIBERATELY CONSERVATIVE. A line survives only when its leading token is a known
 * build/run tool AND an intent can be classified for it. Prose, sample output, and
 * setup noise (`git clone`, `cd`, `export`, `curl`, `sudo`) are dropped rather than
 * guessed at — an ambiguous repo is left for tier-3 AI inference, which is the whole
 * point of keeping this parser narrow.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Pure parsing, no AI.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { classifyCommand, type CiCommand } from './ci.js';
import { readFileIfExists } from '../utils/fs.js';

/** Commands + ports recovered from one script file or one README code block. */
export interface ScriptExtraction {
  commands: CiCommand[];
  ports: number[];
}

/** One shell script whose contents yielded a recognizable command or port. */
export interface ShellScriptDetection {
  /** Repo-relative POSIX path, e.g. "scripts/dev.sh". */
  file: string;
  commands: CiCommand[];
  ports: number[];
}

/** Everything the shell-script analysis recovered from a repo. */
export interface ShellScriptAnalysis {
  found: boolean;
  scripts: ShellScriptDetection[];
}

/**
 * Leading tokens that mark a line as a build or run command worth extracting. This is an
 * allowlist on purpose: everything not named here is dropped. Notably absent, because
 * they are environment setup rather than a statement of how the app builds or runs:
 * `git`, `cd`, `export`, `echo`, `curl`, `wget`, `sudo`, `chmod`, `mkdir`, `source`,
 * `nvm`, `brew`, `apt`.
 */
const KNOWN_TOOLS = new Set([
  // Package managers / installers.
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'pip',
  'pip3',
  'poetry',
  'uv',
  'pipenv',
  'composer',
  'bundle',
  'gem',
  'go',
  'cargo',
  'mvn',
  'gradle',
  'gradlew',
  './gradlew',
  'dotnet',
  // Task runners.
  'make',
  'just',
  'task',
  // Interpreters and application servers.
  'python',
  'python3',
  'node',
  'deno',
  'ruby',
  'php',
  'java',
  'uvicorn',
  'gunicorn',
  'flask',
  'rails',
  'rackup',
  'puma',
  // Containers.
  'docker',
  'docker-compose',
]);

/**
 * Tools that are a complete command on their own. Every other known tool needs at least
 * one more token — a bare `npm` is not a command, but a bare `make` (default target) or
 * a bare `rackup` is.
 */
const SELF_STARTING = new Set(['make', 'just', 'task', 'rackup', 'puma']);

/** Interpreters whose first argument decides whether the line starts an app. */
const INTERPRETERS = new Set(['python', 'python3', 'node', 'deno', 'ruby', 'php', 'java']);

/** Second tokens that make a `<tool> <sub>` line a run command. */
const RUN_SUBCOMMANDS = new Set(['run', 'start', 'dev', 'up', 'serve', 'server', 's']);

/** Docker/compose subcommands that build or run something (anything else is not a build signal). */
const DOCKER_RUN_SUBCOMMANDS = new Set(['run', 'up', 'start']);

/** A file argument that makes an interpreter invocation an app start command. */
const SCRIPT_FILE = /\.(?:py|js|mjs|cjs|ts|rb|php|jar)$/;

/** `-p 8080:80`, `-p 3000`, `--port 8000`, `--publish 8080:80`. */
const PORT_FLAG = /(?:^|\s)(?:-p|--port|--publish)[\s=]+(\d{1,5})(?::(\d{1,5}))?/g;

/** `localhost:3000`, `127.0.0.1:8080`, `0.0.0.0:8000` — including inside a URL. */
const HOST_PORT = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})\b/g;

/** Django's `manage.py runserver [0.0.0.0:]8000`. */
const RUNSERVER = /\brunserver\s+(?:\S+:)?(\d{1,5})\b/g;

/** Root-level scripts a repo conventionally uses as its entrypoint. */
const ROOT_SCRIPTS = ['start.sh', 'run.sh', 'dev.sh'];

/** Directories scanned (non-recursively) for `*.sh`. */
const SCRIPT_DIRS = ['scripts', 'bin'];

/** Cap on scripts read, so a repo with a large `bin/` can't dominate detection. */
const MAX_SCRIPTS = 20;

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Strip an interactive prompt marker from a line copied out of a terminal session. */
function stripPrompt(line: string): string {
  return line.replace(/^[$❯>]\s+/, '');
}

/** Join backslash-continued lines so a multi-line command is classified as one command. */
function joinContinuations(lines: readonly string[]): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '').trim();
    current = current === '' ? trimmed : `${current} ${trimmed}`;
    if (current.endsWith('\\')) {
      current = current.slice(0, -1).trimEnd();
      continue;
    }
    out.push(current);
    current = '';
  }
  if (current !== '') out.push(current);
  return out;
}

/** True when the line's leading token(s) identify a build/run tool we recognize. */
function isRecognized(tokens: readonly string[]): boolean {
  const head = tokens[0] ?? '';
  if (!KNOWN_TOOLS.has(head)) return false;

  // `docker` and `docker-compose` do many things; only the build/run subcommands are a
  // statement about how this repo runs.
  if (head === 'docker') {
    const sub = tokens[1] ?? '';
    if (sub === 'compose') {
      const action = tokens[2] ?? '';
      return action === 'build' || DOCKER_RUN_SUBCOMMANDS.has(action);
    }
    return sub === 'build' || DOCKER_RUN_SUBCOMMANDS.has(sub);
  }
  if (head === 'docker-compose') {
    const sub = tokens[1] ?? '';
    return sub === 'build' || DOCKER_RUN_SUBCOMMANDS.has(sub);
  }

  return tokens.length > 1 || SELF_STARTING.has(head);
}

/**
 * Intent for a command `classifyCommand` returns `'other'` for.
 *
 * REUSE FIRST: `ci.ts`'s `classifyCommand` is always consulted first and its answer
 * always wins. This table only covers the run-shaped forms that classifier has no
 * keyword for — `python app.py`, `docker run`, `docker-compose up`, `go run`,
 * `cargo run`, `flask run`, `rails server` — which are precisely the forms READMEs and
 * start scripts state. Widening `classifyCommand` itself would retroactively reclassify
 * commands already recovered from CI configs, Dockerfiles, and task runners, so the
 * supplement stays local to this module.
 *
 * Returns null when no intent can be established — the caller drops the line rather
 * than recording it as `'other'`.
 */
function supplementalKind(tokens: readonly string[]): CiCommand['kind'] | null {
  const head = tokens[0] ?? '';
  const second = tokens[1] ?? '';
  const third = tokens[2] ?? '';

  if (head === 'docker') {
    if (second === 'build') return 'build';
    if (second === 'compose') return third === 'build' ? 'build' : 'start';
    return DOCKER_RUN_SUBCOMMANDS.has(second) ? 'start' : null;
  }
  if (head === 'docker-compose') {
    if (second === 'build') return 'build';
    return DOCKER_RUN_SUBCOMMANDS.has(second) ? 'start' : null;
  }

  // An interpreter pointed at a script, module, or jar is the app's start command.
  if (INTERPRETERS.has(head)) {
    if (second === '-m' || second === '-jar') return 'start';
    return SCRIPT_FILE.test(second) ? 'start' : null;
  }

  // `<tool> run|start|dev|serve|…` — go run, cargo run, dotnet run, flask run,
  // rails server, make dev, just up.
  if (RUN_SUBCOMMANDS.has(second)) return 'start';

  // A self-starting server named on its own (`rackup`, `puma`).
  return SELF_STARTING.has(head) && tokens.length === 1 ? 'start' : null;
}

/**
 * Every port a command line advertises. For a published mapping (`-p 8080:80`) the
 * CONTAINER side is recorded — the port the app actually serves on — matching the
 * semantics of `dockerfile.exposedPorts`.
 */
function portsInCommand(command: string): number[] {
  const ports: number[] = [];
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    const port = Number(value);
    if (isValidPort(port)) ports.push(port);
  };
  for (const match of command.matchAll(PORT_FLAG)) add(match[2] ?? match[1]);
  for (const match of command.matchAll(HOST_PORT)) add(match[1]);
  for (const match of command.matchAll(RUNSERVER)) add(match[1]);
  return [...new Set(ports)];
}

/**
 * The `localhost:PORT` / `127.0.0.1:PORT` / `0.0.0.0:PORT` mentions in a block of text.
 * Split out from `portsInCommand` because `readme.ts` reads these from the whole README
 * (they live in prose — "open http://localhost:3000"), while flag-style ports stay
 * confined to recognized command lines.
 */
export function localhostPorts(text: string): number[] {
  const ports: number[] = [];
  for (const match of text.matchAll(HOST_PORT)) {
    const port = Number(match[1]);
    if (isValidPort(port)) ports.push(port);
  }
  return [...new Set(ports)];
}

/**
 * The shared extraction core: turn raw shell lines into classified commands plus the
 * ports they mention. Used for both script bodies and README fenced blocks, so the two
 * sources agree on exactly what counts as a command.
 */
export function extractShellCommands(lines: readonly string[]): ScriptExtraction {
  const commands: CiCommand[] = [];
  const ports: number[] = [];
  const seen = new Set<string>();

  for (const raw of joinContinuations(lines)) {
    const command = stripPrompt(raw.trim());
    if (command === '' || command.startsWith('#')) continue;

    const tokens = command.split(/\s+/);
    if (!isRecognized(tokens)) continue;

    const classified = classifyCommand(command);
    const kind = classified === 'other' ? supplementalKind(tokens) : classified;
    if (kind === null) continue;

    if (!seen.has(command)) {
      seen.add(command);
      commands.push({ command, kind });
    }
    ports.push(...portsInCommand(command));
  }

  return { commands, ports: [...new Set(ports)] };
}

/** The conventional script paths present in a repo, capped and in a stable order. */
async function scriptFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];

  for (const name of ROOT_SCRIPTS) {
    if ((await readFileIfExists(join(repoPath, name))) !== null) files.push(join(repoPath, name));
  }

  for (const dir of SCRIPT_DIRS) {
    let entries;
    try {
      entries = await readdir(join(repoPath, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    const shell = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of shell) files.push(join(repoPath, dir, name));
  }

  return files.slice(0, MAX_SCRIPTS);
}

/**
 * Parse the repo's conventional shell scripts into recovered commands + ports. A script
 * that yields nothing recognizable is omitted entirely rather than recorded as empty —
 * "found nothing" and "found an empty script" are the same answer to the caller.
 */
export async function analyzeShellScripts(repoPath: string): Promise<ShellScriptAnalysis> {
  const scripts: ShellScriptDetection[] = [];

  for (const file of await scriptFiles(repoPath)) {
    const raw = await readFileIfExists(file);
    if (raw === null) continue;
    const { commands, ports } = extractShellCommands(raw.split('\n'));
    if (commands.length === 0 && ports.length === 0) continue;
    scripts.push({ file: toPosix(relative(repoPath, file)), commands, ports });
  }

  return { found: scripts.length > 0, scripts };
}
