/**
 * Public entry for `orca-agent-cli/plan`: the service-graph model, the Mermaid renderer,
 * and the review-gate contracts. The extension renders `renderDiagram` in its webview
 * and returns a `ReviewOutcome` from its Approve/Reject panel.
 *
 * STAGE: 4 (plan, library surface) — REAL code.
 */

export * from './types.js';
export * from './diagram.js';
export * from './review.js';
export * from './servicePlan.js';
