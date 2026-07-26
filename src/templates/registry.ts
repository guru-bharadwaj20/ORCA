import type {
  DetectedComponent,
  PackageManager as DetectedPackageManager,
} from '../detect/types.js';
import { recipeForComponent } from '../model/recipes/index.js';
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

// `PackageManager` is an open taxonomy, so these seed-stack helpers carry a `default`.
// Only known managers reach them here (seed components resolve to npm/yarn/pnpm/pip/…);
// the default keeps them total and picks the npm manifest as the safe fallback.
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
    case 'pipenv':
      // Matches the poetry/uv convention above: only the manifest is listed (not
      // Pipfile.lock), since a lockfile isn't guaranteed to be committed and a missing
      // COPY source would fail the Docker build outright.
      return ['Pipfile'];
    default:
      return ['package.json'];
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
    case 'pipenv':
      // No --deploy: dependencyFilesFor only COPYs the Pipfile (see above), so a
      // Pipfile.lock isn't guaranteed to be present in the build context for --deploy
      // to validate against. Plain --system installs from the Pipfile directly.
      return 'pipenv install --system';
    default:
      return 'npm install';
  }
}

/**
 * The default `DockerfileVars` for a seed frontend/backend component, driven by its
 * matched `BuildRecipe` (decision #1). The recipe supplies the framework-specific build
 * knowledge — base image, start command, default ports, system packages, entrypoint —
 * that the old `switch (framework)` used to hardcode; the package manager (and the
 * dependency files / install command it implies) is still resolved from what detection
 * actually found, and every detected port is honored over the recipe default. Output is
 * identical to the pre-recipe switch for react/express/django and for an unclassified
 * node/python component — this is a plumbing unification, not a behavior change.
 */
export function dockerfileVarsFor(component: DetectedComponent): DockerfileVars {
  const recipe = recipeForComponent(component);
  const python = isPython(component);
  const pm = resolvePackageManager(component.packageManager, python);
  // Every port detectPorts found (deduped, detection order preserved), not just the
  // first — the first stays `port`, the primary used for PORT/health/inter-service URLs.
  // The recipe's default ports apply only when detection found none.
  const ports =
    component.ports.length > 0
      ? [...new Set(component.ports.map((p) => p.port))]
      : [...recipe.defaultPorts];

  const vars: DockerfileVars = {
    baseImage: recipe.baseImages.runtime,
    workdir: '/app',
    packageManager: pm,
    dependencyFiles: dependencyFilesFor(pm),
    installCommand: installCommandFor(pm),
    startCommand: recipe.startCommand,
    port: ports[0]!,
    ports,
  };

  if (recipe.systemPackages !== undefined && recipe.systemPackages.length > 0) {
    vars.systemPackages = [...recipe.systemPackages];
  }
  if (recipe.entrypointScript !== undefined && recipe.entrypointScript !== '') {
    vars.entrypointScript = recipe.entrypointScript;
  }

  return vars;
}
