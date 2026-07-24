/**
 * Repository-understanding signals (Phase-3 spec): recover build/run commands and
 * advertised ports from a repo's README. READMEs routinely state the exact commands a
 * maintainer expects you to run ("npm install", "docker-compose up", "open
 * http://localhost:3000"), which makes them a real tier-1 signal — but only the
 * STRUCTURED parts of one are parseable, so this reads fenced shell blocks and nothing
 * else.
 *
 * Prose is never parsed. A README that only describes the project in sentences yields
 * nothing, deliberately: guessing a command out of unstructured text is exactly the job
 * that belongs to tier-3 AI inference, not to a deterministic detector.
 *
 * The line-level extraction (what counts as a command, how it's classified, which ports
 * it mentions) is shared with `shellScript.ts` so both sources agree, mirroring how the
 * CI provider parsers share `ci.ts`'s `classifyCommand`.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Pure parsing, no AI.
 */

import { join } from 'node:path';

import type { CiCommand } from './ci.js';
import { extractShellCommands, localhostPorts } from './shellScript.js';
import { readFileIfExists } from '../utils/fs.js';

/** Everything the README analysis recovered from a repo. */
export interface ReadmeAnalysis {
  /** True when at least one command or port was recovered — not merely that a README exists. */
  found: boolean;
  /** The README filename that was read, or '' when the repo has none. */
  file: string;
  commands: CiCommand[];
  ports: number[];
}

/**
 * README names checked at the repo root, in order. Matches the list `pipeline.ts`'s
 * `readReadme` already uses to ground the AI fill, so the deterministic and AI paths
 * read the same file.
 */
const README_FILES = ['README.md', 'readme.md', 'README'];

/**
 * Fence info-strings whose body is shell. The empty label (a bare ``` fence) is included
 * because unlabeled blocks are overwhelmingly shell in a README — the per-line allowlist
 * in `extractShellCommands` is what keeps a stray JSON or JS block from contributing.
 * Any OTHER label (`js`, `json`, `python`, `yaml`, `ts`) rejects the whole block.
 */
const SHELL_LABELS = new Set([
  '',
  'bash',
  'sh',
  'shell',
  'zsh',
  'console',
  'shell-session',
  'shellsession',
  'terminal',
]);

/** An opening fence: up to 3 spaces of indent, 3+ backticks, an optional info string. */
const FENCE_OPEN = /^ {0,3}(`{3,})\s*([^\s`]*)/;

/** A closing fence: the same run of backticks (or longer) and nothing else on the line. */
const FENCE_CLOSE = /^ {0,3}(`{3,})\s*$/;

/**
 * The bodies of every fenced block whose language label marks it as shell. Tilde fences
 * (`~~~`) are not supported: they are rare in practice, and under-reaching is the right
 * failure mode for this detector.
 */
function shellBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let fence: string | null = null;
  let accepted = false;
  let current: string[] = [];

  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\r$/, '');

    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open?.[1] !== undefined) {
        fence = open[1];
        accepted = SHELL_LABELS.has((open[2] ?? '').toLowerCase());
        current = [];
      }
      continue;
    }

    const close = FENCE_CLOSE.exec(line);
    if (close?.[1] !== undefined && close[1].length >= fence.length) {
      if (accepted && current.length > 0) blocks.push(current);
      fence = null;
      accepted = false;
      current = [];
      continue;
    }
    current.push(line);
  }

  // An unterminated fence at EOF still counts — a truncated README is common enough.
  if (fence !== null && accepted && current.length > 0) blocks.push(current);

  return blocks;
}

/**
 * Parse the repo's README into recovered commands + ports. Only the first README found
 * is read (they are alternative spellings of the same file, not additive sources).
 */
export async function analyzeReadme(repoPath: string): Promise<ReadmeAnalysis> {
  for (const name of README_FILES) {
    const raw = await readFileIfExists(join(repoPath, name));
    if (raw === null) continue;

    const commands: CiCommand[] = [];
    const ports: number[] = [];
    const seen = new Set<string>();

    for (const block of shellBlocks(raw)) {
      const extracted = extractShellCommands(block);
      for (const command of extracted.commands) {
        if (seen.has(command.command)) continue;
        seen.add(command.command);
        commands.push(command);
      }
      ports.push(...extracted.ports);
    }

    // `localhost:PORT` is an unambiguous, structured token, so it is read from the WHOLE
    // README: in practice it appears in prose ("then open http://localhost:3000"), not
    // inside a code block. Flag-style ports (`-p`, `--port`) stay confined to recognized
    // command lines, where they can't be confused with arbitrary numbers.
    ports.push(...localhostPorts(raw));

    return {
      found: commands.length > 0 || ports.length > 0,
      file: name,
      commands,
      ports: [...new Set(ports)],
    };
  }

  return { found: false, file: '', commands: [], ports: [] };
}
