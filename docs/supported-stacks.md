# Supported Stacks

> STAGE 8 doc — the exact, intentionally-narrow scope ORCA supports. Anything outside
> this list is declined with a clear warning rather than guessed at.

ORCA targets **student / hackathon repos**, not arbitrary codebases.

## Frontend

- **Node / React** (Create React App, Vite, or similar dev server)

## Backend (pick one)

- **Node / Express**
- **Python / Django**

## Database (pick one)

- **Postgres**
- **MongoDB**

## Also detected

- **Redis** — recognized as a cache service when present in dependencies.

## Package managers

- Node: `npm`, `yarn`, `pnpm`
- Python: `pip`, `poetry`

## Out of scope (by design)

- Any other language/framework (Go, Rails, Spring, Next.js SSR, etc.)
- Multi-service microservice meshes beyond frontend + backend + db (+ optional redis)
- Kubernetes / cloud deployment (ORCA produces Docker + docker-compose only)

<!-- TODO(stage-8): document detection heuristics + confidence thresholds per stack. -->
