/**
 * CI/CD intelligence (Phase-4 spec, GitLab CI extension): parse `.gitlab-ci.yml` the
 * same way `ci.ts` parses GitHub Actions workflows — recovering stages, jobs, their
 * scripts, and any pinned image, so a GitLab-CI repo's build recipe is understood too.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Structured YAML parsing via the `yaml`
 * package. No AI.
 */

import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  classifyCommand,
  parseRuntimeFromImage,
  type CiCommand,
  type CiRuntimeVersion,
} from './ci.js';
import { readFileIfExists } from '../utils/fs.js';

/** A job recovered from a GitLab CI config. */
export interface GitlabCiJob {
  name: string;
  stage: string | null;
  commands: CiCommand[];
  image: string | null;
}

/** One parsed `.gitlab-ci.yml`/`.gitlab-ci.yaml` file. */
export interface GitlabCiConfig {
  file: string;
  stages: string[];
  jobs: GitlabCiJob[];
  image: string | null;
}

/** Everything the GitLab CI analysis recovered from a repo. */
export interface GitlabCiAnalysis {
  found: boolean;
  configs: GitlabCiConfig[];
  /** Runtime versions recovered from every job's `image:` tag, deduped across configs. */
  runtimeVersions: CiRuntimeVersion[];
}

/** Top-level keys that are GitLab CI configuration, never job definitions. */
const RESERVED_KEYS = new Set([
  'stages',
  'variables',
  'default',
  'include',
  'image',
  'before_script',
  'after_script',
  'workflow',
  'cache',
  'services',
]);

/** The candidate `.gitlab-ci.yml`/`.gitlab-ci.yaml` files at the repo root. */
async function configFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of ['.gitlab-ci.yml', '.gitlab-ci.yaml']) {
    if ((await readFileIfExists(join(repoPath, name))) !== null) files.push(join(repoPath, name));
  }
  return files;
}

/** A GitLab `image:` value is either a bare string or `{ name: ... }`. */
function imageName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { name?: unknown }).name === 'string'
  ) {
    return (value as { name: string }).name;
  }
  return null;
}

/** A GitLab `script:`/`before_script:`/`after_script:` value is a string or a list of strings. */
function scriptLines(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((line): line is string => typeof line === 'string');
  return [];
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

/**
 * Parse one GitLab CI document into its stages, jobs (name/stage/commands/image), and
 * top-level image hint. Any top-level key that isn't a reserved keyword and isn't a
 * hidden job (`.name`, GitLab's template convention) is treated as a job.
 */
function parseConfig(doc: unknown): Omit<GitlabCiConfig, 'file'> | null {
  if (doc === null || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;

  const stages = Array.isArray(root.stages)
    ? root.stages.filter((s): s is string => typeof s === 'string')
    : [];
  const topImage = imageName(root.image);

  const jobs: GitlabCiJob[] = [];
  for (const [name, value] of Object.entries(root)) {
    if (RESERVED_KEYS.has(name) || name.startsWith('.')) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const job = value as Record<string, unknown>;

    const stage = typeof job.stage === 'string' ? job.stage : null;
    const commands = toCommands([
      ...scriptLines(job.before_script),
      ...scriptLines(job.script),
      ...scriptLines(job.after_script),
    ]);
    const image = imageName(job.image) ?? topImage;
    jobs.push({ name, stage, commands, image });
  }

  return { stages, jobs, image: topImage };
}

/**
 * Parse the repo's GitLab CI config(s) into recovered stages/jobs. Malformed YAML is
 * skipped (not fatal) — CI recovery is best-effort, always subordinate to manifest
 * detection.
 */
export async function analyzeGitlabCi(repoPath: string): Promise<GitlabCiAnalysis> {
  const files = await configFiles(repoPath);
  const configs: GitlabCiConfig[] = [];

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

  const runtimeVersions: CiRuntimeVersion[] = [];
  const seenVer = new Set<string>();
  for (const config of configs) {
    for (const job of config.jobs) {
      if (job.image === null) continue;
      const parsed = parseRuntimeFromImage(job.image);
      if (parsed === null) continue;
      const key = `${parsed.runtime}:${parsed.version}`;
      if (seenVer.has(key)) continue;
      seenVer.add(key);
      runtimeVersions.push(parsed);
    }
  }

  return { found: configs.length > 0, configs, runtimeVersions };
}
