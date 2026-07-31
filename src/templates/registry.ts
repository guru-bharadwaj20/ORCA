import type {
  DetectedComponent,
  PackageManager as DetectedPackageManager,
} from '../detect/types.js';
import type { BuildRecipe } from '../model/recipe.js';
import { recipeForComponent } from '../model/recipes/index.js';
import type { DockerfileVars, PackageManager } from './types.js';

/**
 * Which runtime's image the AI is being asked to refine vars for. This used to name a
 * `.hbs` file; there are no Dockerfile templates any more (one synthesizer renders every
 * component), so it names the runtime instead — which is what the label was ever telling
 * the model anyway, and is now true rather than a stale filename.
 */
export type DockerfileTarget = 'node' | 'python';

export interface TemplateDescriptor {
  template: DockerfileTarget;
  defaults: DockerfileVars;
}

function isPython(component: DetectedComponent): boolean {
  return component.language === 'python';
}

export function selectDockerfileTemplate(component: DetectedComponent): DockerfileTarget {
  return isPython(component) ? 'python' : 'node';
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
/**
 * The start command for a seed component, by authority: the recipe's own, then the
 * command DETECTION resolved from the component's manifest, then a runtime convention.
 *
 * A recipe leaves `startCommand` empty when its framework ships no start convention
 * (fastify, koa, hapi, hono) — for those the maintainer's own script is the only correct
 * answer, and detection already found it (`Entrypoint.source: 'package-json-script'`,
 * weight 0.85). Before this, the recipe's guess won unconditionally and
 * `component.entrypoint` was computed, stored, surfaced in the reasoning trail, and then
 * ignored by the one consumer that most needed it.
 *
 * This mirrors `withStartCommand` in `pipeline.ts`, which does the same for ecosystem
 * components; the two paths now resolve a blank start command identically.
 */
function startCommandFor(recipe: BuildRecipe, component: DetectedComponent): string {
  if (recipe.startCommand.trim() !== '') return recipe.startCommand;
  const detected = component.entrypoint?.command.trim();
  if (detected !== undefined && detected !== '') return detected;
  return isPython(component) ? 'python main.py' : 'npm start';
}

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
    startCommand: startCommandFor(recipe, component),
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
