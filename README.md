# ORCA

**Orchestrated Repository Comprehension Agent (ORCA)** _(working name)_

> An AI agent CLI that clones a messy student/hackathon repo, detects its stack,
> generates Docker + docker-compose configs, shows a service-graph diagram for human
> approval **before** running anything, then builds/runs the containers with a
> self-healing retry loop that explains each fix in plain English.

> ⚠️ **Scaffold status:** this repository is a scaffold. Most source files are **stubs**
> that `throw new Error("not implemented")`. See [Scaffolding Summary](#scaffolding-summary).

## Why ORCA

Student and hackathon repos are notoriously hard to run: missing Dockerfiles, undocumented
env vars, wrong ports, "works on my machine." ORCA is deliberately **narrow** — it doesn't
try to containerize any repo, just the common stacks below — so it can be opinionated and
actually get them running.

## Three headline features

1. **Approve-before-build diagram** — ORCA renders the planned service graph as a Mermaid
   diagram and gates on your approval. Nothing is built or run until you say go.
2. **Explainable self-heal** — when a build/run fails, ORCA retries (up to 3 attempts),
   and logs an attempt-by-attempt, plain-English explanation of what broke and how it fixed it.
3. **A narrow, useful niche** — student / hackathon repos, not arbitrary codebases.

## Supported stacks

ORCA supports a small, fixed set (see [`docs/supported-stacks.md`](docs/supported-stacks.md)):

- **Frontend:** Node / React
- **Backend:** Node / Express **or** Python / Django
- **Database:** Postgres **or** MongoDB (Redis detected as an optional cache)
- **Package managers:** npm / yarn / pnpm (Node), pip / poetry (Python)

Anything outside this set is declined with a clear warning rather than guessed at.

## Usage (planned)

ORCA is **BYOK** — you supply your own Anthropic API key.

```bash
export ANTHROPIC_API_KEY=sk-ant-...

# Show the plan + service-graph diagram only; build nothing:
orca run <repo-url> --dry-run

# Full flow: detect → plan → approve → build/run → self-heal:
orca run <repo-url>
```

## Development

```bash
npm install
npm run build       # tsc
npm test            # vitest (LLM + docker mocked)
npm run lint        # eslint
npm run format      # prettier
```

- **ESM only** (`"type": "module"`), TypeScript with `NodeNext` resolution.
- Single npm package (intentionally **not** a monorepo).
- Detectors are standalone so they could later become separate agents.

---

## Scaffolding Summary

This section records exactly what the scaffold created, what is real vs. a stub, and the
assumptions made. It is a map of the repository as generated.

### Legend

- 🟢 **Real** — complete, working code/config you can rely on now.
- 🟡 **Stub** — top-of-file doc comment + typed signatures + `TODO(stage-N)` markers; bodies
  `throw new Error("not implemented")` (or return a typed placeholder).
- 📄 **Content** — real docs/templates/fixtures (prose or Handlebars), not executable logic.

### Real implementations (the shared data contracts)

These were written as complete, correct TypeScript up front because the whole pipeline
depends on them:

| File | What it defines |
| --- | --- |
| 🟢 [`src/detect/types.ts`](src/detect/types.ts) | `DetectionResult` and all detection sub-types (STAGE 2 contract) |
| 🟢 [`src/plan/types.ts`](src/plan/types.ts) | `ServicePlan` / `ServiceNode` service-graph model (STAGE 4 contract) |
| 🟢 [`src/core/context.ts`](src/core/context.ts) | `RunContext` shared state + `createRunContext()` factory + defaults |

Additional real code that snuck in for correctness (typed identity / constants only, no
business logic): 🟢 [`src/utils/errors.ts`](src/utils/errors.ts) (typed error classes),
🟢 [`src/config/settings.ts`](src/config/settings.ts) (real `DEFAULT_SETTINGS`; `loadSettings()`
is a stub), 🟢 [`src/ai/schema.ts`](src/ai/schema.ts) (real zod schemas; `validateAgainst()` is a stub),
and 🟢 [`src/types/index.ts`](src/types/index.ts) (real type re-exports).

### Real configuration files

| File | Purpose |
| --- | --- |
| 🟢 `package.json` | ESM package, `orca` bin, all deps declared, scripts (build/test/lint/format) |
| 🟢 `tsconfig.json` | Strict TS, `NodeNext` module + resolution, `dist/` output |
| 🟢 `eslint.config.js` | Flat config, typescript-eslint + prettier |
| 🟢 `.prettierrc` | Formatting rules |
| 🟢 `vitest.config.ts` | Node test env, coverage config |
| 🟢 `.gitignore` | node_modules, dist, coverage, `.env`, `.orca/` workspaces |
| 🟢 `.env.example` | `ANTHROPIC_API_KEY=` + optional overrides (BYOK) |
| 🟢 `LICENSE` | MIT |
| 🟢 `.devcontainer/devcontainer.json` | Dogfood devcontainer (Node + Docker-in-Docker) |

### Stub source files (by stage)

| Stage | Files (all 🟡 stubs) |
| --- | --- |
| 0/1 clone | `src/clone/workspace.ts` |
| 1 templates | `src/templates/registry.ts` (+ 📄 `.hbs` templates under `dockerfiles/`, `compose/`) |
| 2 detect | `src/detect/{language,framework,packageManager,services,entrypoint,ports,index}.ts` |
| 3 ai | `src/ai/{client,fillTemplate,inferEnv}.ts`, `src/ai/prompts/{fill,infer-env,heal}.ts` |
| 4 plan | `src/plan/{servicePlan,diagram,review}.ts` |
| 5 build | `src/build/{docker,runner,selfHeal,diagnosisLog}.ts`, `src/generate/writeConfigs.ts` |
| 6 orchestrate | `src/orchestrate/{healthchecks,dependsOn,envFiles}.ts` |
| 7 cli | `src/cli/index.ts`, `src/cli/commands/run.ts`, `src/cli/output/index.ts` |
| core | `src/core/pipeline.ts` |
| utils | `src/utils/{fs,logging}.ts` |

### Content files (docs, templates, fixtures)

| Path | What it is |
| --- | --- |
| 📄 `src/templates/dockerfiles/node.Dockerfile.hbs` | Node/React/Express Dockerfile skeleton |
| 📄 `src/templates/dockerfiles/python.Dockerfile.hbs` | Python/Django Dockerfile skeleton |
| 📄 `src/templates/compose/docker-compose.hbs` | Compose skeleton rendered from a `ServicePlan` |
| 📄 `examples/README.md` + `examples/mern-sample/`, `examples/django-postgres-sample/` | Sample target repos (placeholders) |
| 📄 `tests/detect/`, `tests/ai/`, `tests/build/` | Vitest specs using `it.todo` (LLM + docker to be mocked) |
| 📄 `tests/fixtures/README.md` | Describes the fake repo trees for detection tests |
| 📄 `docs/{architecture,supported-stacks,demo}.md` | Project docs |
| 📄 `scripts/{dev,clean}.sh` | Dev helper scripts (placeholders) |

### Assumptions made during scaffolding

- **Working name kept as "ORCA"** everywhere (acronym: _Orchestrated Repository
  Comprehension Agent_, preserved from the original README). The published npm package +
  CLI bin are the lowercase `orca` (npm package names can't be uppercase); the prompt's
  `ORCA run` is the `orca run` command.
- **Root = repo root.** Files were generated directly into the existing `ORCA/` git repo
  (no nested `ORCA/ORCA/`).
- **A few files beyond the three required contracts were written as real code** where a stub
  would have been pointless or error-prone: typed error classes, zod schemas, settings
  defaults, and type re-exports. Their _logic_ entry points (e.g. `loadSettings`,
  `validateAgainst`) remain stubs.
- **Dependency versions** are recent, plausible pins (`@anthropic-ai/sdk`, `commander`,
  `handlebars`, `zod`, `chalk`, `ora`, `cli-table3`, `execa`, `simple-git`, `vitest`,
  `typescript-eslint`); `npm install` was intentionally **not** run, so versions are declared
  but unverified against the registry.
- **`NodeNext` ESM** means intra-project imports use explicit `.js` extensions in the `.ts`
  sources — this is deliberate, not a mistake.
- **Extra small files** (`src/cli/output/index.ts`, `tests/**`, `examples/**/README.md`,
  `scripts/*`) were added to make otherwise directory-only entries in the target tree real,
  committable paths.
- **No logic, no API calls, no docker execution** were implemented, per scope.
