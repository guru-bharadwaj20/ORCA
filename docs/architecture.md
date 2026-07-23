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

## Repository layout

```
src/
├── clone/        temp-workspace clone/copy + cleanup
├── detect/       static, AI-free stack detection
├── templates/    Handlebars Dockerfile/Compose templates + registry
├── ai/           multi-provider router (Qwen primary, Claude fallback), BYOK
├── plan/         service plan, Mermaid diagram, approval gate
├── generate/     writes configs into the workspace
├── orchestrate/  healthchecks, startup order, explainable .env generation
├── build/        docker build/run + the explainable self-heal loop
├── core/         RunContext + runPipeline (the embeddable engine)
├── cli/          the `orca` binary, interactive menu, output rendering
├── config/       ORCA_* settings parsing + validation
└── utils/        errors, filesystem helpers, logging

scripts/          build/clean helpers (template packaging, workspace cleanup)
examples/         runnable sample apps + golden reference configs
tests/            vitest suites (nothing mocked beyond the Docker/AI boundaries)
vscode-extension/ the VS Code front end (workspace member)
docs/             architecture, supported stacks, demo
```

The package entry point is `src/core/index.ts` (`orca-agent-cli`); `plan/`, `config/`,
and `ai/` each expose a barrel for their subpath export.

## Data contracts (stable up front)

- `src/detect/types.ts` — `DetectionResult`
- `src/plan/types.ts` — `ServicePlan` / `ServiceNode`
- `src/core/context.ts` — `RunContext`

## Planned

Sequence diagram, error-handling model, and the cost/heal budget flow.
