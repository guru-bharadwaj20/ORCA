/**
 * The evidence-based detection model — public surface of ORCA's Universal Repository
 * Understanding foundation (docs/universal-understanding-plan.md).
 *
 * PHASE: A (foundation) — REAL code (re-exports only).
 */

export {
  AI_CONFIDENCE_CEILING,
  bestClaim,
  claim,
  combineConfidence,
  reasoning,
  type Claim,
  type ClaimSource,
  type Evidence,
} from './claim.js';
export { DetectorRegistry, type Detector, type RepoContext } from './detector.js';
export {
  RecipeRegistry,
  SEED_RECIPES,
  type BuildRecipe,
  type MatchFacts,
  type RecipeEntry,
  type RecipeMatcher,
  type Runtime,
} from './recipe.js';
