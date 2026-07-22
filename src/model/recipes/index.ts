/**
 * Composition point for the recipe registry: seed stacks (React/Express/Django) plus
 * the Phase-B ecosystem recipes (Go/Rust/JVM/.NET). `defaultRecipeRegistry()` is what
 * the pipeline uses; tests can build narrower registries from the exported entry lists.
 *
 * PHASE: B — REAL code.
 */

import { RecipeRegistry, SEED_RECIPES } from '../recipe.js';
import { ECOSYSTEM_RECIPES } from './ecosystems.js';

export { ECOSYSTEM_RECIPES } from './ecosystems.js';

/** Every recipe ORCA ships, seed stacks first (most-specific), then ecosystems. */
export const ALL_RECIPES = [...SEED_RECIPES, ...ECOSYSTEM_RECIPES];

/** The registry the pipeline uses: all seed + ecosystem recipes, in priority order. */
export function defaultRecipeRegistry(): RecipeRegistry {
  return new RecipeRegistry(ALL_RECIPES);
}
