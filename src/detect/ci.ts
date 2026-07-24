/**
 * CI/CD intelligence (Phase-4 spec): parse GitHub Actions workflows to recover how a
 * repo is actually built, tested, and started, plus the runtime versions it pins.
 * CI files are the most reliable non-manifest signal — they encode the maintainer's
 * own build recipe — so this is a tier-2 detector, above AI, below manifests.
 *
 * STAGE: 2 (detect) / PHASE C — REAL code. Structured YAML parsing via the `yaml`
 * package. No AI.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { readFileIfExists } from '../utils/fs.js';

/** A command recovered from a CI `run:` step, classified by intent. */
export interface CiCommand {
  /** The raw shell line, e.g. "npm run build". */
  command: string;
  /** Best-effort classification from keywords in the command. */
  kind: 'install' | 'build' | 'test' | 'start' | 'other';
}

/** A pinned runtime version recovered from a `setup-*` action. */
export interface CiRuntimeVersion {
  /** Runtime family, e.g. "node", "python", "go", "java", "dotnet". */
  runtime: string;
  /** The version string as written, e.g. "20", "3.12", "1.23". */
  version: string;
}

/** Everything the CI analysis recovered from a repo's workflows. */
export interface CiAnalysis {
  /** True when at least one workflow file was found and parsed. */
  found: boolean;
  commands: CiCommand[];
  runtimeVersions: CiRuntimeVersion[];
}

/** Maps a `setup-*` action name to the runtime it provisions + the `with:` version key. */
const SETUP_ACTIONS: Record<string, { runtime: string; versionKey: string }> = {
  'actions/setup-node': { runtime: 'node', versionKey: 'node-version' },
  'actions/setup-python': { runtime: 'python', versionKey: 'python-version' },
  'actions/setup-go': { runtime: 'go', versionKey: 'go-version' },
  'actions/setup-java': { runtime: 'java', versionKey: 'java-version' },
  'actions/setup-dotnet': { runtime: 'dotnet', versionKey: 'dotnet-version' },
};

/** Classify a shell command by intent from leading keywords. */
export function classifyCommand(command: string): CiCommand['kind'] {
  const c = command.toLowerCase();
  if (/\b(install|ci\b|restore|mod download|cargo fetch|go-offline)\b/.test(c)) return 'install';
  if (/\b(build|compile|bootjar|publish|package|bundle)\b/.test(c)) return 'build';
  if (/\b(test|pytest|vitest|jest|go test|cargo test)\b/.test(c)) return 'test';
  if (/\b(start|serve|runserver|run dev|uvicorn|gunicorn)\b/.test(c)) return 'start';
  return 'other';
}

/** Runtime name substrings recognized in an image's repo path (before the tag). */
function runtimeFromImageName(repoPath: string): string | null {
  const lower = repoPath.toLowerCase();
  if (lower.includes('node')) return 'node';
  if (lower.includes('python')) return 'python';
  if (lower.includes('golang')) return 'go';
  if (lower.includes('dotnet')) return 'dotnet';
  if (lower.includes('openjdk') || lower.includes('temurin') || lower.includes('jdk') || lower.includes('jre')) {
    return 'java';
  }
  // Bare "go" only matches as an exact path segment — `.includes('go')` would
  // false-positive on "django", "mongo", "gogs", etc.
  if (lower.split('/').includes('go')) return 'go';
  return null;
}

/** Leading dotted-number version from a tag, ignoring OS/variant suffixes (e.g. "20-slim" -> "20"). */
function versionFromTag(tag: string): string | null {
  return /^(\d+(?:\.\d+){0,3})/.exec(tag)?.[1] ?? null;
}

/**
 * Recover a runtime + version pin from a Docker image tag, e.g. "node:20-slim" ->
 * {runtime:"node", version:"20"}, "cimg/node:20.10" -> {runtime:"node", version:"20.10"}.
 * Returns null for anything that doesn't cleanly parse — no tag at all, an unversioned
 * tag ("latest"), or an unrecognized image — best-effort, matching every other CI parser
 * in this codebase. The runtime vocabulary matches `SETUP_ACTIONS`'s keys so entries from
 * either source merge into `insights.ciRuntimeVersions` without a naming mismatch.
 */
export function parseRuntimeFromImage(image: string): CiRuntimeVersion | null {
  const trimmed = image.trim();
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon === -1) return null;

  const runtime = runtimeFromImageName(trimmed.slice(0, lastColon));
  if (runtime === null) return null;

  const version = versionFromTag(trimmed.slice(lastColon + 1));
  if (version === null) return null;

  return { runtime, version };
}

/** Every `.yml`/`.yaml` under `.github/workflows`, or [] when the dir is absent. */
async function workflowFiles(repoPath: string): Promise<string[]> {
  const dir = join(repoPath, '.github', 'workflows');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** A GitHub Actions step is either a `run:` shell step or a `uses:` action step. */
interface WorkflowStep {
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

/** Walk every step of every job in one parsed workflow document. */
function* stepsOf(doc: unknown): Generator<WorkflowStep> {
  const jobs = (doc as { jobs?: Record<string, { steps?: WorkflowStep[] }> } | null)?.jobs;
  if (!jobs) return;
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) yield step;
  }
}

/** Normalize a `uses:` value to its action ref without the version, e.g. "actions/setup-node". */
function actionName(uses: string): string {
  return uses.split('@')[0] ?? uses;
}

/**
 * Parse the repo's GitHub Actions workflows into recovered commands + runtime
 * versions. Malformed YAML in one file is skipped (not fatal) — CI recovery is
 * best-effort, always subordinate to manifest detection.
 */
export async function analyzeCi(repoPath: string): Promise<CiAnalysis> {
  const files = await workflowFiles(repoPath);
  const commands: CiCommand[] = [];
  const runtimeVersions: CiRuntimeVersion[] = [];
  const seenCmd = new Set<string>();
  const seenVer = new Set<string>();

  for (const file of files) {
    const raw = await readFileIfExists(file);
    if (raw === null) continue;
    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch {
      continue;
    }

    for (const step of stepsOf(doc)) {
      if (typeof step.run === 'string') {
        // A run step may hold multiple shell lines; classify each.
        for (const line of step.run.split('\n')) {
          const command = line.trim();
          if (command === '' || command.startsWith('#')) continue;
          if (seenCmd.has(command)) continue;
          seenCmd.add(command);
          commands.push({ command, kind: classifyCommand(command) });
        }
      }
      if (typeof step.uses === 'string') {
        const setup = SETUP_ACTIONS[actionName(step.uses)];
        const version = setup ? step.with?.[setup.versionKey] : undefined;
        if (setup && (typeof version === 'string' || typeof version === 'number')) {
          const key = `${setup.runtime}:${version}`;
          if (!seenVer.has(key)) {
            seenVer.add(key);
            runtimeVersions.push({ runtime: setup.runtime, version: String(version) });
          }
        }
      }
    }
  }

  return { found: files.length > 0, commands, runtimeVersions };
}
