/**
 * The single decision point for "how do we produce this component's Dockerfile?":
 *   - seed stacks (React/Express/Django) → the hand-verified Handlebars templates,
 *   - everything else with a matched/inferred `BuildRecipe` → the generic synthesizer.
 *
 * Isolating the choice here keeps `writeConfigs` from growing a second code path and
 * gives the eventual open-role plan integration one tested seam to call. Pure: it takes
 * the already-resolved inputs and returns Dockerfile text.
 *
 * STAGE: 5 (generate) / PHASE E — REAL code.
 */

import type { DockerfileVars } from '../templates/types.js';
import type { BuildRecipe } from '../model/recipe.js';
import { renderDockerfile } from '../templates/render.js';
import { synthesizeDockerfile, type SynthesisOptions } from './synthesizeDockerfile.js';

/** A seed-stack component: render its template. */
export interface TemplateSource {
  kind: 'template';
  vars: DockerfileVars;
}

/** An ecosystem/inferred component: synthesize from its recipe. */
export interface RecipeSource {
  kind: 'recipe';
  recipe: BuildRecipe;
  options?: SynthesisOptions;
}

/** How a component's Dockerfile should be produced. */
export type DockerfileSource = TemplateSource | RecipeSource;

/**
 * Produce the Dockerfile text for a component from whichever source applies. The seed
 * stacks keep their exact prior output (the templates are unchanged); recipe-sourced
 * components get a synthesized multi-stage image.
 */
export function dockerfileFor(source: DockerfileSource): string {
  return source.kind === 'template'
    ? renderDockerfile(source.vars)
    : synthesizeDockerfile(source.recipe, source.options ?? {});
}
