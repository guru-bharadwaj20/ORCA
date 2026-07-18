/**
 * Public entry for `orca-agent-cli/ai`: the provider-agnostic facade + the router an
 * embedder uses to build a run-scoped AI client (with its own key resolver / cost
 * cap / cancel signal).
 *
 * STAGE: 3 (ai, library surface) — REAL code.
 */

export * from './client.js';
export * from './router.js';
