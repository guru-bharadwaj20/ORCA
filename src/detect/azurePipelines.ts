/**
 * CI/CD intelligence (Phase-4 spec, Azure Pipelines extension): parse
 * `azure-pipelines.yml` the same way `ci.ts` parses GitHub Actions workflows —
 * recovering stages, jobs, their scripts, and any pool/container image, so an
 * Azure-Pipelines repo's build recipe is understood too.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Structured YAML parsing via the `yaml`
 * package. No AI.
 */

import { dirname, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  classifyCommand,
  parseRuntimeFromImage,
  type CiCommand,
  type CiRuntimeVersion,
} from './ci.js';
import { readFileIfExists, resolveWithinRoot } from '../utils/fs.js';

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

/** Runaway (non-cyclic) template chains stop here — a backstop, not the primary guard. */
const MAX_TEMPLATE_DEPTH = 10;

/** A stage-list or job-list entry that's a `template:` reference rather than a real entry. */
interface TemplateRef {
  template: string;
  parameters?: Record<string, unknown>;
}

function isTemplateRef(entry: unknown): entry is TemplateRef {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof (entry as { template?: unknown }).template === 'string'
  );
}

/**
 * Literal `${{ parameters.name }}` substitution on the template file's raw YAML text,
 * before parsing — the simplest way to handle a parameter landing anywhere (an image
 * tag, a pool name), and the only approach that works for the common "prefix + parameter"
 * idiom (`container: node:${{ parameters.imageTag }}`): quoting/escaping the replacement
 * would corrupt that case (`node:"20"` is not `node:20`), since the parameter is only
 * part of the value, not the whole scalar. A value containing YAML-hostile characters
 * (a colon followed by a space, a leading quote) can still produce invalid YAML after
 * substitution — that's an accepted best-effort limitation, not silently "fixed": the
 * caller's `parseYaml` try/catch already turns a resulting parse failure into a graceful
 * skip (that template's jobs are dropped, nothing crashes, nothing else is corrupted).
 * Azure's expression language (`${{ if }}`, `${{ each }}`) is out of scope; an
 * un-substituted expression is simply left as-is.
 */
function substituteParameters(text: string, parameters: Record<string, unknown>): string {
  return text.replace(/\$\{\{\s*parameters\.(\w+)\s*\}\}/g, (match, name: string) => {
    const value = parameters[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Azure `template:` paths are relative to the directory of the file that references
 * them, but `templatePath` is repo-controlled content — a crafted
 * `template: ../../../../some/path/file.yml` must not escape `repoPath`. Returns null
 * (treated the same as a missing/unparseable template) when it would.
 */
function resolveTemplatePath(
  repoPath: string,
  fromFile: string,
  templatePath: string
): string | null {
  return resolveWithinRoot(repoPath, join(dirname(fromFile), templatePath));
}

/**
 * Load a referenced template file's top-level array — a job- or stage-template file's
 * own top level IS a list (no `jobs:`/`stages:` wrapper key) — with its `parameters:`
 * substituted first.
 */
async function loadTemplateArray(
  templateFile: string,
  parameters: Record<string, unknown>
): Promise<unknown[] | null> {
  const raw = await readFileIfExists(templateFile);
  if (raw === null) return null;
  const substituted = substituteParameters(raw, parameters);
  let doc: unknown;
  try {
    doc = parseYaml(substituted);
  } catch {
    return null;
  }
  return Array.isArray(doc) ? doc : null;
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
 * Expand a `jobs:` list (from the root file or a loaded job-template array), resolving
 * any `template:` entries into the jobs they contain — recursively, so a template's own
 * entries may reference further templates — and turning every plain job object into an
 * `AzurePipelinesJob` via `jobFrom`. `stack` is the current template ancestry (not an
 * ever-visited set): a legitimately repeated, non-cyclic template reference (the same
 * job template used twice with different `parameters:`, a normal Azure pattern) still
 * resolves both times; only a true cycle is refused. `depth` backstops non-cyclic chains.
 */
async function expandJobEntries(
  entries: unknown[],
  repoPath: string,
  fromFile: string,
  stage: string | null,
  fallbackImage: string | null,
  stack: Set<string>,
  depth: number
): Promise<AzurePipelinesJob[]> {
  const jobs: AzurePipelinesJob[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;

    if (isTemplateRef(entry)) {
      const templateFile = resolveTemplatePath(repoPath, fromFile, entry.template);
      if (templateFile === null || stack.has(templateFile) || depth >= MAX_TEMPLATE_DEPTH) continue;
      stack.add(templateFile);
      try {
        const templateEntries = await loadTemplateArray(templateFile, entry.parameters ?? {});
        if (templateEntries !== null) {
          jobs.push(
            ...(await expandJobEntries(
              templateEntries,
              repoPath,
              templateFile,
              stage,
              fallbackImage,
              stack,
              depth + 1
            ))
          );
        }
      } finally {
        stack.delete(templateFile);
      }
      continue;
    }

    jobs.push(jobFrom(entry as JobLike, stage, fallbackImage));
  }
  return jobs;
}

/** One stage's own name + its (already job-template-expanded) jobs. */
interface ExpandedStage {
  name: string | null;
  jobs: AzurePipelinesJob[];
}

/**
 * Expand a `stages:` list (from the root file or a loaded stage-template array), the
 * same way `expandJobEntries` expands a job list — `template:` entries resolved
 * recursively, real stage entries processed into a name plus their own (job-template-
 * expanded) jobs.
 */
async function expandStageEntries(
  entries: unknown[],
  repoPath: string,
  fromFile: string,
  rootImage: string | null,
  stack: Set<string>,
  depth: number
): Promise<ExpandedStage[]> {
  const stages: ExpandedStage[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;

    if (isTemplateRef(entry)) {
      const templateFile = resolveTemplatePath(repoPath, fromFile, entry.template);
      if (templateFile === null || stack.has(templateFile) || depth >= MAX_TEMPLATE_DEPTH) continue;
      stack.add(templateFile);
      try {
        const templateEntries = await loadTemplateArray(templateFile, entry.parameters ?? {});
        if (templateEntries !== null) {
          stages.push(
            ...(await expandStageEntries(
              templateEntries,
              repoPath,
              templateFile,
              rootImage,
              stack,
              depth + 1
            ))
          );
        }
      } finally {
        stack.delete(templateFile);
      }
      continue;
    }

    const se = entry as Record<string, unknown>;
    const stageName = typeof se.stage === 'string' ? se.stage : null;
    const stageImage = containerImage(se.container) ?? vmImageOf(se.pool) ?? rootImage;

    let jobs: AzurePipelinesJob[] = [];
    if (Array.isArray(se.jobs)) {
      jobs = await expandJobEntries(
        se.jobs,
        repoPath,
        fromFile,
        stageName,
        stageImage,
        stack,
        depth
      );
    } else if (Array.isArray(se.steps)) {
      jobs = [jobFrom(se as JobLike, stageName, stageImage)];
    }
    stages.push({ name: stageName, jobs });
  }
  return stages;
}

/**
 * Parse one Azure Pipelines document into its stages, jobs (name/stage/commands/image),
 * and top-level image hint. Handles the three shapes the schema allows: `stages` (each
 * with nested `jobs`), bare `jobs`, or a bare top-level `steps` list (single implicit job).
 * `template:` references at the stage-list or job-list level are resolved and expanded
 * inline before returning — the caller sees a complete job list either way.
 */
async function parseConfig(
  doc: unknown,
  repoPath: string,
  filePath: string,
  stack: Set<string>,
  depth: number
): Promise<Omit<AzurePipelinesConfig, 'file'> | null> {
  if (doc === null || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;
  const rootImage = containerImage(root.container) ?? vmImageOf(root.pool);

  const stages: string[] = [];
  const jobs: AzurePipelinesJob[] = [];

  if (Array.isArray(root.stages)) {
    const expanded = await expandStageEntries(
      root.stages,
      repoPath,
      filePath,
      rootImage,
      stack,
      depth
    );
    for (const stage of expanded) {
      if (stage.name !== null) stages.push(stage.name);
      jobs.push(...stage.jobs);
    }
  } else if (Array.isArray(root.jobs)) {
    jobs.push(
      ...(await expandJobEntries(root.jobs, repoPath, filePath, null, rootImage, stack, depth))
    );
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
    const parsed = await parseConfig(doc, repoPath, file, new Set(), 0);
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
