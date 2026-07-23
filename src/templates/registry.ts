import type {
  DetectedComponent,
  PackageManager as DetectedPackageManager,
} from '../detect/types.js';
import type { DockerfileVars, PackageManager } from './types.js';

export type DockerfileTemplateName = 'node.Dockerfile.hbs' | 'python.Dockerfile.hbs';

export interface TemplateDescriptor {
  template: DockerfileTemplateName;
  defaults: DockerfileVars;
}

function isPython(component: DetectedComponent): boolean {
  return component.language === 'python';
}

export function selectDockerfileTemplate(component: DetectedComponent): DockerfileTemplateName {
  return isPython(component) ? 'python.Dockerfile.hbs' : 'node.Dockerfile.hbs';
}

function resolvePackageManager(detected: DetectedPackageManager, python: boolean): PackageManager {
  if (detected === 'unknown') return python ? 'pip' : 'npm';
  return detected;
}

function dependencyFilesFor(pm: PackageManager): string[] {
  switch (pm) {
    case 'npm':
    case 'yarn':
    case 'pnpm':
      return ['package.json'];
    case 'pip':
      return ['requirements.txt'];
    case 'poetry':
    case 'uv':
      return ['pyproject.toml'];
  }
}

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
    case 'uv':
      return 'uv sync --frozen';
  }
}

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

function startCommandFor(framework: DetectedComponent['framework'], python: boolean): string {
  if (framework === 'django') return 'python manage.py runserver 0.0.0.0:8000';
  if (framework === 'react' || framework === 'express') return 'npm run dev';
  return python ? 'python manage.py runserver 0.0.0.0:8000' : 'npm run dev';
}

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

  if (component.framework === 'django') {
    vars.systemPackages = ['libpq-dev', 'gcc'];
    vars.entrypointScript = 'entrypoint.sh';
  }

  return vars;
}

export function describeComponent(component: DetectedComponent): TemplateDescriptor {
  return {
    template: selectDockerfileTemplate(component),
    defaults: defaultDockerfileVars(component),
  };
}
