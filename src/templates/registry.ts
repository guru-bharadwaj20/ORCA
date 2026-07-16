/**
 * Maps a (previously-computed) `DetectionResult` / `DetectedComponent` to a template
 * selection plus sane default `DockerfileVars`. Pure switch/lookup logic — it runs NO
 * detection itself (that's Stage 2) and makes NO AI calls (that's Stage 3). The defaults
 * produced here are the fallback values the AI layer will later refine.
 *
 * STAGE: 1 (templates) — REAL code.
 * Inputs: a `DetectedComponent` (imported type; detection logic stays stubbed).
 * Outputs: the `.hbs` template filename to use + a default `DockerfileVars`.
 */

import type {
  DetectedComponent,
  PackageManager as DetectedPackageManager,
} from '../detect/types.js';
import type { DockerfileVars, PackageManager } from './types.js';

/** The two Dockerfile templates Stage 1 ships. */
export type DockerfileTemplateName = 'node.Dockerfile.hbs' | 'python.Dockerfile.hbs';

/**
 * A resolved template choice for one component: which `.hbs` to render plus the default
 * render-context. This is what the Stage 3 AI layer receives and then refines (it fills /
 * overrides `defaults` from the README + detection before rendering).
 */
export interface TemplateDescriptor {
  template: DockerfileTemplateName;
  defaults: DockerfileVars;
}

/** True when the component is part of the Python toolchain (Django, for our scope). */
function isPython(component: DetectedComponent): boolean {
  return component.language === 'python';
}

/**
 * Pick the Dockerfile template for a component. Python components (Django) get the
 * Python template; everything else (React client / Express server) gets the Node one.
 */
export function selectDockerfileTemplate(component: DetectedComponent): DockerfileTemplateName {
  return isPython(component) ? 'python.Dockerfile.hbs' : 'node.Dockerfile.hbs';
}

/** Resolve the concrete template `PackageManager`, defaulting when detection was unsure. */
function resolvePackageManager(
  detected: DetectedPackageManager,
  python: boolean
): PackageManager {
  if (detected === 'unknown') return python ? 'pip' : 'npm';
  return detected;
}

/** The manifest/lock files to copy first, per package manager (for layer caching). */
function dependencyFilesFor(pm: PackageManager): string[] {
  switch (pm) {
    case 'npm':
    case 'yarn':
    case 'pnpm':
      // Intentionally just package.json: messy student repos often omit the lockfile,
      // and `COPY`-ing a missing lockfile would break the build.
      return ['package.json'];
    case 'pip':
      return ['requirements.txt'];
    case 'poetry':
      return ['pyproject.toml'];
  }
}

/** The dependency install command, per package manager. */
function installCommandFor(pm: PackageManager): string {
  switch (pm) {
    case 'npm':
      return 'npm install';
    case 'yarn':
      return 'yarn install';
    case 'pnpm':
      return 'pnpm install';
    case 'pip':
      return 'pip install -r requirements.txt';
    case 'poetry':
      return 'poetry install';
  }
}

/** Default in-container port, by framework, when detection didn't find one. */
function defaultPortFor(framework: DetectedComponent['framework']): number {
  switch (framework) {
    case 'react':
      return 5173;
    case 'django':
      return 8000;
    case 'express':
      return 3000;
    default:
      return 3000;
  }
}

/** The dev start command, by framework. */
function startCommandFor(framework: DetectedComponent['framework'], python: boolean): string {
  if (framework === 'django') return 'python manage.py runserver 0.0.0.0:8000';
  if (framework === 'react' || framework === 'express') return 'npm run dev';
  // Unknown framework: fall back to the toolchain's conventional dev command.
  return python ? 'python manage.py runserver 0.0.0.0:8000' : 'npm run dev';
}

/**
 * Assemble default `DockerfileVars` for a detected component. These are deterministic,
 * AI-free fallbacks; Stage 3 later overrides any of them from the README / detection.
 *
 * NOTE (detection-shape gap): `DetectedComponent` does not expose whether a
 * lockfile exists, so `dependencyFiles` conservatively copies only the manifest. If a
 * later detection field records the lockfile, prefer it here for better layer caching.
 */
export function defaultDockerfileVars(component: DetectedComponent): DockerfileVars {
  const python = isPython(component);
  const pm = resolvePackageManager(component.packageManager, python);
  const port = component.ports[0]?.port ?? defaultPortFor(component.framework);

  const vars: DockerfileVars = {
    baseImage: python ? 'python:3.12-slim' : 'node:20-slim',
    workdir: '/app',
    packageManager: pm,
    dependencyFiles: dependencyFilesFor(pm),
    installCommand: installCommandFor(pm),
    startCommand: startCommandFor(component.framework, python),
    port,
  };

  // Django + Postgres needs libpq/build deps and a migrate-then-run entrypoint.
  if (component.framework === 'django') {
    vars.systemPackages = ['libpq-dev', 'gcc'];
    vars.entrypointScript = 'entrypoint.sh';
  }

  return vars;
}

/**
 * Convenience: resolve both the template choice and its default vars for a component in
 * one call. This is the `TemplateDescriptor` the Stage 3 AI layer starts from.
 */
export function describeComponent(component: DetectedComponent): TemplateDescriptor {
  return {
    template: selectDockerfileTemplate(component),
    defaults: defaultDockerfileVars(component),
  };
}
