/**
 * CI/CD intelligence (Phase-4 spec, CircleCI extension): parse `.circleci/config.yml`
 * the same way `ci.ts` parses GitHub Actions workflows — recovering jobs, their `run`
 * steps, and any docker image, so a CircleCI repo's build recipe is understood too.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Structured YAML parsing via the `yaml`
 * package. No AI.
 *
 * CircleCI has no `stages` concept (workflows orchestrate jobs instead), so every
 * `CircleCiConfig.stages` is `[]` — kept only for shape parity with the other providers.
 */

import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { classifyCommand, type CiCommand } from './ci.js';
import { readFileIfExists } from '../utils/fs.js';

/** A job recovered from a CircleCI config. */
export interface CircleCiJob {
  name: string;
  stage: null;
  commands: CiCommand[];
  image: string | null;
}

/** One parsed `.circleci/config.yml` file. */
export interface CircleCiConfig {
  file: string;
  stages: string[];
  jobs: CircleCiJob[];
  image: string | null;
}

/** Everything the CircleCI analysis recovered from a repo. */
export interface CircleCiAnalysis {
  found: boolean;
  configs: CircleCiConfig[];
}

async function configFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of ['.circleci/config.yml', '.circleci/config.yaml']) {
    const path = join(repoPath, ...name.split('/'));
    if ((await readFileIfExists(path)) !== null) files.push(path);
  }
  return files;
}

/** A job's `docker:`/`machine:`/`executor:` executor, the closest CircleCI equivalent of a base image. */
function jobImage(job: Record<string, unknown>): string | null {
  if (Array.isArray(job.docker)) {
    const first = job.docker[0];
    if (first !== null && typeof first === 'object' && typeof (first as { image?: unknown }).image === 'string') {
      return (first as { image: string }).image;
    }
  }
  if (typeof job.executor === 'string') return job.executor;
  if (job.machine !== undefined) return 'machine';
  return null;
}

function toCommands(lines: string[]): CiCommand[] {
  const commands: CiCommand[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const command = raw.trim();
    if (command === '' || command.startsWith('#') || seen.has(command)) continue;
    seen.add(command);
    commands.push({ command, kind: classifyCommand(command) });
  }
  return commands;
}

/** A CircleCI step is either a bare string (built-in like `checkout`, ignored) or a `run:` step. */
function jobCommands(steps: unknown): CiCommand[] {
  if (!Array.isArray(steps)) return [];
  const lines: string[] = [];
  for (const step of steps) {
    if (step === null || typeof step !== 'object') continue;
    const run = (step as Record<string, unknown>).run;
    if (typeof run === 'string') {
      lines.push(...run.split('\n'));
    } else if (run !== null && typeof run === 'object') {
      const command = (run as { command?: unknown }).command;
      if (typeof command === 'string') lines.push(...command.split('\n'));
    }
  }
  return toCommands(lines);
}

/** Parse one CircleCI document's `jobs:` map into name/commands/image. `stages` is always `[]`. */
function parseConfig(doc: unknown): Omit<CircleCiConfig, 'file'> | null {
  if (doc === null || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;
  if (root.jobs === null || typeof root.jobs !== 'object') return null;

  const jobs: CircleCiJob[] = [];
  for (const [name, value] of Object.entries(root.jobs as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const job = value as Record<string, unknown>;
    jobs.push({
      name,
      stage: null,
      commands: jobCommands(job.steps),
      image: jobImage(job),
    });
  }

  return { stages: [], jobs, image: jobs.find((j) => j.image !== null)?.image ?? null };
}

/**
 * Parse the repo's CircleCI config into recovered jobs. Malformed YAML is skipped
 * (not fatal) — CI recovery is best-effort, always subordinate to manifest detection.
 */
export async function analyzeCircleCi(repoPath: string): Promise<CircleCiAnalysis> {
  const files = await configFiles(repoPath);
  const configs: CircleCiConfig[] = [];

  for (const file of files) {
    const raw = await readFileIfExists(file);
    if (raw === null) continue;
    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch {
      continue;
    }
    const parsed = parseConfig(doc);
    if (parsed === null) continue;
    configs.push({ file, ...parsed });
  }

  return { found: configs.length > 0, configs };
}
