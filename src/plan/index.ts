/**
 * Public subpath `orca-cli/plan`: the service-graph model, the plan builder, the
 * Mermaid renderer, and the terminal review gate (embedders usually replace the
 * gate via `PipelineIO.approvePlan` but need its `ReviewOutcome` contract).
 *
 * STAGE: 4 (plan) — REAL code (re-exports only).
 */

export * from './types.js';
export { buildServicePlan, refinedComponentVars } from './servicePlan.js';
export { renderDiagram } from './diagram.js';
export { reviewPlan, type ReviewIO, type ReviewOutcome } from './review.js';
