# ORCA Architecture

> STAGE 8 doc — how the pipeline fits together. Placeholder to be expanded.

ORCA is a single npm package (not a monorepo) organized as a linear, stage-based
pipeline. Each stage reads from and writes to a shared `RunContext`, so stages stay
decoupled and independently testable. Detectors are deliberately standalone so they
could later become separate agents.

## Pipeline stages

| Stage | Directory              | Responsibility                                                            |
| ----- | ---------------------- | ------------------------------------------------------------------------- |
| 0/1   | `clone/`, `templates/` | Clone the repo into a temp workspace; hold hand-written config templates  |
| 2     | `detect/`              | Static, AI-free stack detection → `DetectionResult`                       |
| 3     | `ai/`                  | LLM fills template variables + infers env (structured output, validated)  |
| 4     | `plan/`                | Build the service graph, render a Mermaid diagram, gate on human approval |
| 5     | `build/`, `generate/`  | Write configs, build/run containers, self-heal on failure                 |
| 6     | `orchestrate/`         | Healthchecks, startup order, `.env` generation                            |
| 7     | `cli/`                 | Command parsing, flags, terminal output                                   |
| 8     | `docs/`                | This documentation                                                        |

## Data contracts (stable up front)

- `src/detect/types.ts` — `DetectionResult`
- `src/plan/types.ts` — `ServicePlan` / `ServiceNode`
- `src/core/context.ts` — `RunContext`

## Planned

Sequence diagram, error-handling model, and the cost/heal budget flow.
