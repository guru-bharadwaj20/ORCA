/**
 * Renders a `ServicePlan` to a Mermaid diagram string so the user can eyeball the
 * service graph (nodes + dependency edges + exposed ports) before approving.
 *
 * STAGE: 4 (plan) — headline feature: approve-before-build diagram
 * Inputs: a `ServicePlan`.
 * Outputs: a Mermaid `graph`/`flowchart` source string.
 */

import type { ServicePlan } from './types.js';

// TODO(stage-4): emit one Mermaid node per service and edges from dependsOn, labeling
// exposed ports and database links.
export function renderDiagram(_plan: ServicePlan): string {
  throw new Error('not implemented');
}
