/**
 * CI/CD intelligence (Phase-4 spec, GitLab CI extension): parse `.gitlab-ci.yml` the
 * same way `ci.ts` parses GitHub Actions workflows — recovering stages, jobs, their
 * scripts, and any pinned image, so a GitLab-CI repo's build recipe is understood too.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Structured YAML parsing via the `yaml`
 * package. No AI.
 */

import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  classifyCommand,
  parseRuntimeFromImage,
  type CiCommand,
  type CiRuntimeVersion,
} from './ci.js';
import { readFileIfExists, resolveWithinRoot } from '../utils/fs.js';

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

/** Runaway (non-cyclic) include chains stop here — a backstop, not the primary guard. */
const MAX_INCLUDE_DEPTH = 10;

/**
 * Every `local:` include path from a GitLab `include:` value — a bare string, or a list
 * of strings/`{ local: ... }` objects (GitLab also allows `project:`/`remote:`/`template:`
 * entries, but those need network access to resolve, which no detector in this codebase
 * does; they're silently skipped, contributing nothing rather than erroring).
 */
function localIncludePaths(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  const paths: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      paths.push(entry);
      continue;
    }
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as { local?: unknown }).local === 'string'
    ) {
      paths.push((entry as { local: string }).local);
    }
  }
  return paths;
}

/**
 * GitLab `include:local` paths are repo-root-relative, whether or not they start with
 * `/`. `includePath` is repo-controlled content, so a value like
 * `../../../../etc/some-file.yml` must not escape `repoPath` — stripping only the
 * leading slash (GitLab's own root-relative convention) is not enough on its own to
 * reject an embedded `../`. Returns null (treated as a missing include) when it would.
 */
function resolveIncludePath(repoPath: string, includePath: string): string | null {
  return resolveWithinRoot(repoPath, includePath.replace(/^\/+/, ''));
}

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

/** One parsed document's own stages/jobs/image, plus its unresolved `include:` paths. */
interface ParsedDocument {
  stages: string[];
  jobs: GitlabCiJob[];
  image: string | null;
  includes: string[];
}

/**
 * Parse one GitLab CI document into its stages, jobs (name/stage/commands/image), and
 * top-level image hint. Any top-level key that isn't a reserved keyword and isn't a
 * hidden job (`.name`, GitLab's template convention) is treated as a job. Does not
 * resolve `include:` — that's `collectJobs`'s job, since it needs repo-relative path
 * resolution and cycle tracking this pure function has no business doing.
 */
function parseDocument(doc: unknown): ParsedDocument | null {
  if (doc === null || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;

  const stages = Array.isArray(root.stages)
    ? root.stages.filter((s): s is string => typeof s === 'string')
    : [];
  const topImage = imageName(root.image);
  const includes = localIncludePaths(root.include);

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

  return { stages, jobs, image: topImage, includes };
}

/**
 * Read + parse one file (root config or an included one) and recursively merge in its
 * `include:`s, producing the full expanded job list. `stack` is the current include
 * ancestry (not an ever-visited set) so a legitimately repeated, non-cyclic include is
 * still resolved — only a true cycle (a file including itself, directly or transitively)
 * is refused. `depth` is a backstop for pathological non-cyclic chains.
 *
 * Precedence on a duplicate job name: whichever file's own jobs are merged FIRST wins —
 * concretely, a file's own jobs always beat anything pulled in via ITS includes, and
 * among includes, the first one listed beats a later one that redeclares the same name.
 * This is a deliberate simplification, not full GitLab CI override-precedence semantics.
 */
async function collectJobs(
  repoPath: string,
  filePath: string,
  stack: Set<string>,
  depth: number
): Promise<Omit<GitlabCiConfig, 'file'> | null> {
  const absPath = resolve(filePath);
  if (stack.has(absPath) || depth >= MAX_INCLUDE_DEPTH) return null;
  stack.add(absPath);

  try {
    const raw = await readFileIfExists(filePath);
    if (raw === null) return null;
    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch {
      return null;
    }
    const parsed = parseDocument(doc);
    if (parsed === null) return null;

    const jobs: GitlabCiJob[] = [...parsed.jobs];
    const seenJobNames = new Set(jobs.map((j) => j.name));
    const stages = [...parsed.stages];
    const seenStages = new Set(stages);

    for (const includePath of parsed.includes) {
      const resolvedPath = resolveIncludePath(repoPath, includePath);
      if (resolvedPath === null) continue;
      const included = await collectJobs(repoPath, resolvedPath, stack, depth + 1);
      if (included === null) continue;

      for (const job of included.jobs) {
        if (seenJobNames.has(job.name)) continue;
        seenJobNames.add(job.name);
        jobs.push(job);
      }
      for (const stage of included.stages) {
        if (seenStages.has(stage)) continue;
        seenStages.add(stage);
        stages.push(stage);
      }
    }

    // The top-level image hint is this file's own — an include's image never bubbles up,
    // so a root config without its own `image:` reports null even if an include has one.
    return { stages, jobs, image: parsed.image };
  } finally {
    stack.delete(absPath);
  }
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
    const collected = await collectJobs(repoPath, file, new Set(), 0);
    if (collected === null) continue;
    configs.push({ file, ...collected });
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
