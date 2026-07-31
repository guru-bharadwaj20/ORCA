/**
 * The adapter that finishes decision #1: it turns a seed component's `DockerfileVars`
 * into a `BuildRecipe`, so seed and ecosystem components reach the SAME renderer.
 *
 * Until this existed there were two renderers. Seed stacks (React/Express/Django) rendered
 * `.hbs` templates through `renderDockerfile`; everything else synthesized from a recipe
 * through `synthesizeDockerfile`. The DATA path had already been unified — recipes drive
 * both — but two renderers emit different text from the same data, which is the part that
 * kept the seed goldens and the ecosystem goldens on separate footings and left every
 * synthesizer improvement applying to only half the repos ORCA supports.
 *
 * WHY VARS STILL EXIST. `DockerfileVars` is the AI-refinement surface: `fillTemplate`
 * validates the model's proposals against `FilledTemplateVarsSchema` and `refineVars`
 * overlays them. That contract is worth keeping exactly as it is — it is narrow, strictly
 * validated, and the model understands it. So rather than teaching the AI a new shape,
 * the refined vars are folded back onto the component's recipe here, and the recipe is
 * what gets rendered. Vars are an OVERLAY on a recipe now, not an input to a second engine.
 *
 * STAGE: 5 (generate) — REAL code. Pure: vars in, Dockerfile text out.
 */

import type { DetectedComponent } from '../detect/types.js';
import type { BuildRecipe } from '../model/recipe.js';
import { recipeForComponent } from '../model/recipes/index.js';
import type { DockerfileVars } from '../templates/types.js';
import { synthesizeDockerfile } from './synthesizeDockerfile.js';

/**
 * Overlay resolved `DockerfileVars` onto the recipe they were derived from.
 *
 * `base` supplies what vars cannot express — the recipe's identity (which names the image
 * in its header comment) and its `env`. Everything else comes from the vars, because by
 * this point they are the authority: `dockerfileVarsFor` already sourced them FROM this
 * recipe, and `refineDockerfileVars` may then have refined them with schema-validated AI
 * proposals. Reading a field off `base` instead would silently discard that refinement.
 */
export function recipeFromVars(base: BuildRecipe, vars: DockerfileVars): BuildRecipe {
  const recipe: BuildRecipe = {
    ...base,
    packageManager: vars.packageManager,
    dependencyFiles: [...vars.dependencyFiles],
    installCommands: [vars.installCommand],
    startCommand: vars.startCommand,
    // `ports` is the full published set and `port` only its primary, so an absent `ports`
    // (hand-built vars from an older call site) falls back to the primary alone — the
    // same rule the `exposeLines` template helper applied.
    defaultPorts: vars.ports !== undefined && vars.ports.length > 0 ? [...vars.ports] : [vars.port],
    baseImages: { build: vars.baseImage, runtime: vars.baseImage },
  };

  // Optional fields are assigned or removed rather than set to undefined, because
  // `exactOptionalPropertyTypes` makes those two different things — and because a recipe
  // carrying `systemPackages: undefined` would defeat the synthesizer's presence checks.
  if (vars.buildCommand !== undefined && vars.buildCommand !== '') {
    recipe.buildCommands = [vars.buildCommand];
  } else {
    delete recipe.buildCommands;
  }
  if (vars.systemPackages !== undefined && vars.systemPackages.length > 0) {
    recipe.systemPackages = [...vars.systemPackages];
  } else {
    delete recipe.systemPackages;
  }
  if (vars.entrypointScript !== undefined && vars.entrypointScript !== '') {
    recipe.entrypointScript = vars.entrypointScript;
  } else {
    delete recipe.entrypointScript;
  }

  return recipe;
}

/**
 * The Dockerfile for a seed component, from its (possibly AI-refined) vars — via the one
 * renderer every other component already uses.
 */
export function dockerfileFromVars(component: DetectedComponent, vars: DockerfileVars): string {
  return synthesizeDockerfile(recipeFromVars(recipeForComponent(component), vars), {
    workdir: vars.workdir,
  });
}
