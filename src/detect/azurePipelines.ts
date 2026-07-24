/**
 * CI/CD intelligence (Phase-4 spec, Azure Pipelines extension): parse
 * `azure-pipelines.yml` the same way `ci.ts` parses GitHub Actions workflows —
 * recovering stages, jobs, their scripts, and any pool/container image, so an
 * Azure-Pipelines repo's build recipe is understood too.
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

/** A job recovered from an Azure Pipelines config. */
export interface AzurePipelinesJob {
  name: string;
  stage: string | null;
  commands: CiCommand[];
  image: string | null;
}

/** One parsed Azure Pipelines YAML file. */
export interface AzurePipelinesConfig {
  file: string;
  stages: string[];
  jobs: AzurePipelinesJob[];
  image: string | null;
}

/** Everything the Azure Pipelines analysis recovered from a repo. */
export interface AzurePipelinesAnalysis {
  found: boolean;
  configs: AzurePipelinesConfig[];
  /** Runtime versions recovered from every job's `image:` tag, deduped across configs. */
  runtimeVersions: CiRuntimeVersion[];
}

/** Candidate paths for the pipeline definition, root-level plus the common dotted alias. */
const CANDIDATE_FILES = ['azure-pipelines.yml', 'azure-pipelines.yaml', '.azure-pipelines.yml'];

async function configFiles(repoPath: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of CANDIDATE_FILES) {
    if ((await readFileIfExists(join(repoPath, name))) !== null) files.push(join(repoPath, name));
  }
  return files;
}

/** A `pool:` value's `vmImage`, the closest Azure equivalent of a base-image hint. */
function vmImageOf(pool: unknown): string | null {
  if (
    pool !== null &&
    typeof pool === 'object' &&
    typeof (pool as { vmImage?: unknown }).vmImage === 'string'
  ) {
    return (pool as { vmImage: string }).vmImage;
  }
  return null;
}

/** A `container:` value is either a bare image string or `{ image: ... }`. */
function containerImage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { image?: unknown }).image === 'string'
  ) {
    return (value as { image: string }).image;
  }
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

/** An Azure step is a `script`/`bash`/`pwsh`/`powershell` shell step, or a `task` step (ignored). */
function stepCommands(steps: unknown): CiCommand[] {
  if (!Array.isArray(steps)) return [];
  const lines: string[] = [];
  for (const step of steps) {
    if (step === null || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;
    const value = s.script ?? s.bash ?? s.pwsh ?? s.powershell;
    if (typeof value === 'string') lines.push(...value.split('\n'));
  }
  return toCommands(lines);
}

interface JobLike {
  job?: unknown;
  deployment?: unknown;
  pool?: unknown;
  container?: unknown;
  steps?: unknown;
}

function jobFrom(
  entry: JobLike,
  stage: string | null,
  fallbackImage: string | null
): AzurePipelinesJob {
  const name =
    typeof entry.job === 'string'
      ? entry.job
      : typeof entry.deployment === 'string'
        ? entry.deployment
        : 'default';
  const image = containerImage(entry.container) ?? vmImageOf(entry.pool) ?? fallbackImage;
  return { name, stage, commands: stepCommands(entry.steps), image };
}

/**
 * Parse one Azure Pipelines document into its stages, jobs (name/stage/commands/image),
 * and top-level image hint. Handles the three shapes the schema allows: `stages` (each
 * with nested `jobs`), bare `jobs`, or a bare top-level `steps` list (single implicit job).
 */
function parseConfig(doc: unknown): Omit<AzurePipelinesConfig, 'file'> | null {
  if (doc === null || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;
  const rootImage = containerImage(root.container) ?? vmImageOf(root.pool);

  const stages: string[] = [];
  const jobs: AzurePipelinesJob[] = [];

  if (Array.isArray(root.stages)) {
    for (const stageEntry of root.stages) {
      if (stageEntry === null || typeof stageEntry !== 'object') continue;
      const se = stageEntry as Record<string, unknown>;
      const stageName = typeof se.stage === 'string' ? se.stage : null;
      if (stageName !== null) stages.push(stageName);
      const stageImage = containerImage(se.container) ?? vmImageOf(se.pool) ?? rootImage;

      if (Array.isArray(se.jobs)) {
        for (const jobEntry of se.jobs) {
          if (jobEntry === null || typeof jobEntry !== 'object') continue;
          jobs.push(jobFrom(jobEntry as JobLike, stageName, stageImage));
        }
      } else if (Array.isArray(se.steps)) {
        jobs.push(jobFrom(se as JobLike, stageName, stageImage));
      }
    }
  } else if (Array.isArray(root.jobs)) {
    for (const jobEntry of root.jobs) {
      if (jobEntry === null || typeof jobEntry !== 'object') continue;
      jobs.push(jobFrom(jobEntry as JobLike, null, rootImage));
    }
  } else if (Array.isArray(root.steps)) {
    jobs.push(jobFrom({ steps: root.steps }, null, rootImage));
  }

  return { stages, jobs, image: rootImage };
}

/**
 * Parse the repo's Azure Pipelines config(s) into recovered stages/jobs. Malformed
 * YAML is skipped (not fatal) — CI recovery is best-effort, always subordinate to
 * manifest detection.
 */
export async function analyzeAzurePipelines(repoPath: string): Promise<AzurePipelinesAnalysis> {
  const files = await configFiles(repoPath);
  const configs: AzurePipelinesConfig[] = [];

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
