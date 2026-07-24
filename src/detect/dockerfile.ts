/**
 * Tier-1 Dockerfile analysis: parse existing Dockerfiles as ground truth build
 * recipes. This is deterministic, best-effort, and intentionally lightweight so it
 * can run alongside CI and task-runner recovery without any model calls.
 */

import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { classifyCommand } from './ci.js';
import type { Runtime } from '../model/recipe.js';
import { readFileIfExists } from '../utils/fs.js';

export interface DockerfileAnalysis {
  found: boolean;
  dockerfiles: DockerfileDetection[];
}

export interface DockerfileDetection {
  rootDir: string;
  file: string;
  baseImage: string;
  exposedPorts: number[];
  installCommands: string[];
  buildCommands: string[];
  startCommand: string;
  workingDir: string;
}

// Matches `Dockerfile`/`dockerfile` (+ any `.suffix`) and `Containerfile`, the
// OCI/Podman/Buildah equivalent with identical syntax. Case-insensitive so `DOCKERFILE`
// and `containerfile` are caught too.
const DOCKERFILE_NAME = /^(?:dockerfile|containerfile)(?:\..+)?$/i;

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

function normalizeCommand(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')) {
        return parsed.join(' ');
      }
    } catch {
      // Fall through to the shell form below.
    }
  }
  return trimmed;
}

function logicalLines(raw: string): string[] {
  const lines = raw.split('\n');
  const out: string[] = [];
  let current = '';
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (trimmed === '' || (trimmed.startsWith('#') && current === '')) continue;
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

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parsePorts(value: string): number[] {
  const ports: number[] = [];
  for (const match of value.matchAll(/\b(\d{1,5})\b/g)) {
    const port = Number(match[1]);
    if (isValidPort(port)) ports.push(port);
  }
  return [...new Set(ports)];
}

function classifyRun(command: string): 'install' | 'build' | null {
  const kind = classifyCommand(command);
  return kind === 'install' || kind === 'build' ? kind : null;
}

/** Best-effort runtime inference from the final Dockerfile base image. */
export function runtimeFromBaseImage(baseImage: string): Runtime {
  const image = baseImage.toLowerCase();
  if (image.includes('node')) return 'node';
  if (image.includes('python')) return 'python';
  if (image.includes('golang') || image.includes('go:')) return 'go';
  if (image.includes('rust')) return 'rust';
  if (image.includes('mcr.microsoft.com/dotnet') || image.includes('dotnet')) return 'dotnet';
  if (image.includes('maven') || image.includes('gradle') || image.includes('openjdk')) {
    return 'jvm';
  }
  if (image.includes('php')) return 'php';
  if (image.includes('ruby')) return 'ruby';
  return 'unknown';
}

function parseDockerfile(raw: string): Omit<DockerfileDetection, 'rootDir' | 'file'> | null {
  let baseImage = '';
  const exposedPorts: number[] = [];
  const installCommands: string[] = [];
  const buildCommands: string[] = [];
  let startCommand = '';
  let workingDir = '.';

  for (const line of logicalLines(raw)) {
    const match = /^(FROM|RUN|CMD|ENTRYPOINT|WORKDIR|EXPOSE)\b\s*(.*)$/i.exec(line);
    if (match === null) continue;
    const directive = (match[1] ?? '').toUpperCase();
    const value = (match[2] ?? '').trim();

    if (directive === 'FROM') {
      const image = value
        .replace(/^--\S+\s+/, '')
        .replace(/\s+AS\s+.+$/i, '')
        .trim();
      if (image !== '') baseImage = image.split(/\s+/)[0] ?? baseImage;
      continue;
    }

    if (directive === 'EXPOSE') {
      for (const port of parsePorts(value)) exposedPorts.push(port);
      continue;
    }

    if (directive === 'WORKDIR') {
      workingDir = normalizeCommand(value);
      continue;
    }

    if (directive === 'CMD' || directive === 'ENTRYPOINT') {
      const command = normalizeCommand(value);
      if (command !== '') startCommand = command;
      continue;
    }

    if (directive === 'RUN') {
      const command = normalizeCommand(value);
      const kind = classifyRun(command);
      if (kind === 'install') installCommands.push(command);
      if (kind === 'build') buildCommands.push(command);
    }
  }

  if (baseImage === '' || startCommand === '') return null;
  return {
    baseImage,
    exposedPorts: [...new Set(exposedPorts)],
    installCommands: [...new Set(installCommands)],
    buildCommands: [...new Set(buildCommands)],
    startCommand,
    workingDir,
  };
}

async function dockerfileFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && DOCKERFILE_NAME.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function candidateDirs(repoPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(repoPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = ['.'];
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name);
  }
  return dirs;
}

/**
 * Exposed ports declared by any Dockerfile/Containerfile variant in a single directory,
 * deduplicated and in declaration order. Shares the name matching and EXPOSE parsing with
 * `analyzeDockerfiles`, so a component's port lookup honors `Containerfile`, `Dockerfile.prod`,
 * JSON-array EXPOSE, and multi-port lines — not just a bare `Dockerfile` with one number.
 */
export async function dockerfilePortsAt(dir: string): Promise<number[]> {
  const ports: number[] = [];
  for (const file of await dockerfileFiles(dir)) {
    const raw = await readFileIfExists(file);
    if (raw === null) continue;
    // Read EXPOSE directly rather than via `parseDockerfile`: a `FROM` + `EXPOSE` file with
    // no explicit CMD (common for nginx/postgres-based images) is not a full recipe but still
    // declares a real port. Port lookup must not require a start command.
    for (const line of logicalLines(raw)) {
      const match = /^EXPOSE\b\s*(.*)$/i.exec(line);
      if (match) ports.push(...parsePorts(match[1] ?? ''));
    }
  }
  return [...new Set(ports)];
}

/** Parse every Dockerfile-like file at the repo root and common first-level subdirs. */
export async function analyzeDockerfiles(repoPath: string): Promise<DockerfileAnalysis> {
  const detections: DockerfileDetection[] = [];
  const seen = new Set<string>();

  for (const dir of await candidateDirs(repoPath)) {
    const absDir = dir === '.' ? repoPath : join(repoPath, dir);
    for (const file of await dockerfileFiles(absDir)) {
      const key = toPosix(relative(repoPath, file)).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const raw = await readFileIfExists(file);
      if (raw === null) continue;
      const parsed = parseDockerfile(raw);
      if (parsed === null) continue;

      detections.push({
        rootDir: toPosix(relative(repoPath, absDir)) || '.',
        file: basename(file),
        ...parsed,
      });
    }
  }

  return { found: detections.length > 0, dockerfiles: detections };
}
