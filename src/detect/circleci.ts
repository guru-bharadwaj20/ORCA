/**
 * CI/CD intelligence (Phase-4 spec, CircleCI extension): parse `.circleci/config.yml`
 * the same way `ci.ts` parses GitHub Actions workflows — recovering jobs, their `run`
 * steps, and any docker image, so a CircleCI repo's build recipe is understood too.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Structured YAML parsing via the `yaml`
 * package. No AI.
 *
 * STAGES, FOR A PROVIDER THAT HAS NONE. CircleCI has no `stages:` key — `workflows:` is
 * its analog, and it expresses order as a DAG (`requires:`) rather than a list. So
 * `stages` here is the recovered execution ORDER: each entry is `<workflow>:<job>`, in
 * topological order. The qualifier is what keeps multiple workflows recoverable as
 * separate sequences instead of one merged list, which a bare job name could not do.
 * A config with no `workflows:` section still yields `stages: []`, exactly as before.
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

/** A job recovered from a CircleCI config. */
export interface CircleCiJob {
  name: string;
  /**
   * The workflow this job runs in, or null when no `workflows:` section references it.
   * CircleCI's nearest equivalent to a GitLab stage name — a job listed in several
   * workflows reports the first that names it.
   */
  stage: string | null;
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
  /** Runtime versions recovered from every job's docker/executor image, deduped across configs. */
  runtimeVersions: CiRuntimeVersion[];
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
    if (
      first !== null &&
      typeof first === 'object' &&
      typeof (first as { image?: unknown }).image === 'string'
    ) {
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

/** One job as a workflow lists it: its (possibly aliased) name and its declared deps. */
interface WorkflowJob {
  name: string;
  requires: string[];
}

/** A `requires:` value is a bare job name or a list of them. */
function requiresList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * A workflow's `jobs:` list. Each entry is either a bare job name or a single-key map
 * carrying that job's config (`- test: { requires: [build] }`). CircleCI lets a config
 * re-use one job under a different `name:`, which is what makes the alias the identity
 * other jobs' `requires:` refer to.
 */
function workflowJobs(list: unknown): WorkflowJob[] {
  if (!Array.isArray(list)) return [];
  const jobs: WorkflowJob[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      jobs.push({ name: entry, requires: [] });
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const key = Object.keys(entry as Record<string, unknown>)[0];
    if (key === undefined) continue;
    const raw = (entry as Record<string, unknown>)[key];
    const config =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    jobs.push({
      name: typeof config.name === 'string' ? config.name : key,
      requires: requiresList(config.requires),
    });
  }
  return jobs;
}

/**
 * The order CircleCI would start a workflow's jobs, as a flat topological sequence.
 *
 * This implements CircleCI's OWN rule, which is worth stating because it is easy to
 * assume otherwise: a job with no `requires:` starts IMMEDIATELY, in parallel with every
 * other unblocked job — it does not implicitly wait for the jobs declared above it. So
 * `[a, b, c(requires a,b)]` resolves to a and b together, then c; declaration order only
 * breaks ties inside one level.
 *
 * A `requires:` naming a job outside this workflow is ignored, so dependencies stay
 * within the workflow. A cycle (which CircleCI itself would reject) cannot be ordered, so
 * the unresolved remainder is appended in declaration order rather than dropped — losing
 * jobs would be worse than reporting an imperfect order for a config that cannot run.
 */
function topologicalOrder(jobs: readonly WorkflowJob[]): string[] {
  const known = new Set(jobs.map((j) => j.name));
  const remaining = [...jobs];
  const settled = new Set<string>();
  const order: string[] = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((job) =>
      job.requires.every((dep) => !known.has(dep) || settled.has(dep))
    );
    if (ready.length === 0) {
      for (const job of remaining) order.push(job.name);
      break;
    }
    // Collect the whole level before settling it, so jobs at the same level never
    // satisfy each other's dependencies.
    for (const job of ready) order.push(job.name);
    for (const job of ready) {
      settled.add(job.name);
      remaining.splice(remaining.indexOf(job), 1);
    }
  }
  return order;
}

/** Top-level `workflows:` keys that configure the section rather than declare a workflow. */
const RESERVED_WORKFLOW_KEYS = new Set(['version']);

/** Every declared workflow, in declaration order, with its jobs. */
function parseWorkflows(root: Record<string, unknown>): { name: string; jobs: WorkflowJob[] }[] {
  const section = root.workflows;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return [];

  const workflows: { name: string; jobs: WorkflowJob[] }[] = [];
  for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
    if (RESERVED_WORKFLOW_KEYS.has(name)) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const jobs = workflowJobs((value as Record<string, unknown>).jobs);
    if (jobs.length === 0) continue;
    workflows.push({ name, jobs });
  }
  return workflows;
}

/** Parse one CircleCI document's `jobs:` map into name/commands/image, plus workflow order. */
function parseConfig(doc: unknown): Omit<CircleCiConfig, 'file'> | null {
  if (doc === null || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;
  if (root.jobs === null || typeof root.jobs !== 'object') return null;

  const workflows = parseWorkflows(root);

  // Each workflow contributes its own ordered sequence, qualified by workflow name, so a
  // config with several workflows stays recoverable as several sequences rather than one
  // merged list.
  const stages: string[] = [];
  const workflowOf = new Map<string, string>();
  for (const workflow of workflows) {
    for (const jobName of topologicalOrder(workflow.jobs)) {
      stages.push(`${workflow.name}:${jobName}`);
      if (!workflowOf.has(jobName)) workflowOf.set(jobName, workflow.name);
    }
  }

  const jobs: CircleCiJob[] = [];
  for (const [name, value] of Object.entries(root.jobs as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const job = value as Record<string, unknown>;
    jobs.push({
      name,
      stage: workflowOf.get(name) ?? null,
      commands: jobCommands(job.steps),
      image: jobImage(job),
    });
  }

  return { stages, jobs, image: jobs.find((j) => j.image !== null)?.image ?? null };
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
