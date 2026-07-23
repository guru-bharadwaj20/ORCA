/**
 * Repository-understanding signals (Phase-3 spec): recover build/run/test tasks from
 * the task runners a project commonly ships — Makefile, Taskfile.yml, justfile, and
 * package.json scripts. These are the maintainer's own entrypoints; when manifest and
 * framework detection are thin, they are often the clearest statement of how a repo is
 * driven. Tier-1 (deterministic) — pure parsing, no AI.
 *
 * STAGE: 2 (detect) / PHASE 3 — REAL code.
 */

import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { classifyCommand } from './ci.js';
import { readPackageJson } from './manifest.js';
import { readFileIfExists } from '../utils/fs.js';

/** A named task recovered from a task runner, with its recipe and a classified intent. */
export interface RecoveredTask {
  /** Where the task came from, for the reasoning trail. */
  source: 'makefile' | 'taskfile' | 'justfile' | 'npm-scripts';
  /** Task/target/script name, e.g. "build", "dev", "start". */
  name: string;
  /** The command body (first meaningful line), when recoverable. */
  command: string;
  /** Intent classified from the name + command keywords. */
  kind: 'install' | 'build' | 'test' | 'start' | 'other';
}

/** Classify a task by its name first (build/dev/start are conventional), then its body. */
function classifyTask(name: string, command: string): RecoveredTask['kind'] {
  const n = name.toLowerCase();
  if (/^(install|deps|bootstrap|setup)$/.test(n)) return 'install';
  if (/^(build|compile|dist|bundle)$/.test(n)) return 'build';
  if (/^(test|check|lint|ci)$/.test(n)) return 'test';
  if (/^(start|serve|dev|run|up)$/.test(n)) return 'start';
  return classifyCommand(command);
}

/** Parse GNU Make targets: `target:` lines, with the first recipe line as the command. */
function parseMakefile(text: string): RecoveredTask[] {
  const tasks: RecoveredTask[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const target = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line);
    if (!target?.[1] || target[1] === '.PHONY') continue;
    // The command is the first tab-indented recipe line following the target.
    let command = '';
    for (let j = i + 1; j < lines.length; j++) {
      const recipe = lines[j] ?? '';
      if (/^\t/.test(recipe)) {
        command = recipe.trim();
        break;
      }
      if (recipe.trim() !== '' && !recipe.startsWith('#')) break;
    }
    tasks.push({
      source: 'makefile',
      name: target[1],
      command,
      kind: classifyTask(target[1], command),
    });
  }
  return tasks;
}

/** Parse a justfile: `recipe:` lines with the following indented line as the command. */
function parseJustfile(text: string): RecoveredTask[] {
  const tasks: RecoveredTask[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const recipe = /^([A-Za-z0-9][\w-]*)\s*(?:[\w\s]*)?:(?!=)/.exec(line);
    if (!recipe?.[1]) continue;
    const next = (lines[i + 1] ?? '').trim();
    tasks.push({
      source: 'justfile',
      name: recipe[1],
      command: next,
      kind: classifyTask(recipe[1], next),
    });
  }
  return tasks;
}

/** Parse a Taskfile.yml `tasks:` map; each task's first `cmds` entry is the command. */
function parseTaskfile(text: string): RecoveredTask[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const tasksMap = (doc as { tasks?: Record<string, { cmds?: unknown[] }> } | null)?.tasks;
  if (!tasksMap) return [];
  const tasks: RecoveredTask[] = [];
  for (const [name, def] of Object.entries(tasksMap)) {
    const first = def?.cmds?.find((c) => typeof c === 'string');
    const command = typeof first === 'string' ? first : '';
    tasks.push({ source: 'taskfile', name, command, kind: classifyTask(name, command) });
  }
  return tasks;
}

/**
 * Recover tasks from every runner present at a component root. package.json scripts are
 * included (the most common runner of all). Absent files contribute nothing.
 */
export async function recoverTasks(dir: string): Promise<RecoveredTask[]> {
  const tasks: RecoveredTask[] = [];

  // GNU make's own search order: GNUmakefile, then makefile, then Makefile. `GNUmakefile`
  // is used by projects that are deliberately GNU-make-only, so check it first.
  const makefile =
    (await readFileIfExists(join(dir, 'GNUmakefile'))) ??
    (await readFileIfExists(join(dir, 'Makefile'))) ??
    (await readFileIfExists(join(dir, 'makefile')));
  if (makefile !== null) tasks.push(...parseMakefile(makefile));

  // `just` resolves any of these names (case + dotfile variants), so check them all —
  // a repo shipping `Justfile` would otherwise have its tasks silently missed.
  for (const name of ['justfile', 'Justfile', '.justfile', '.Justfile']) {
    const justfile = await readFileIfExists(join(dir, name));
    if (justfile !== null) {
      tasks.push(...parseJustfile(justfile));
      break;
    }
  }

  for (const name of ['Taskfile.yml', 'Taskfile.yaml']) {
    const taskfile = await readFileIfExists(join(dir, name));
    if (taskfile !== null) tasks.push(...parseTaskfile(taskfile));
  }

  const pkg = await readPackageJson(dir);
  for (const [name, command] of Object.entries(pkg?.scripts ?? {})) {
    tasks.push({ source: 'npm-scripts', name, command, kind: classifyTask(name, command) });
  }

  return tasks;
}
