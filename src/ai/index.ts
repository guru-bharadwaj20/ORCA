/**
 * Public subpath `orca-cli/ai`: the provider-agnostic facade, the router (for
 * run-scoped configuration), and the validated output schemas.
 *
 * STAGE: 3 (ai) — REAL code (re-exports only).
 */

export { ai, aiFor, type AIFacade } from './client.js';
export {
  AIRouter,
  providerFactories,
  resolveRouterConfig,
  routerConfigForRun,
  type ProviderFactories,
  type RouterCallOptions,
  type RouterConfig,
  type RouterPrompt,
} from './router.js';
export {
  envResolveKey,
  type AIProvider,
  type CompletionOptions,
  type ProviderCompletion,
  type ResolveKey,
} from './providers/types.js';
export {
  FilledTemplateVarsSchema,
  HealSuggestionSchema,
  InferredEnvSchema,
  type FilledTemplateVars,
  type HealSuggestion,
  type InferredEnv,
} from './schema.js';
