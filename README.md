# ORCA

**Orchestrated Repository Comprehension Agent (ORCA)** _(working name)_

> An AI agent CLI that clones a messy student/hackathon repo, detects its stack,
> generates Docker + docker-compose configs, shows a service-graph diagram for human
> approval **before** running anything, then builds/runs the containers with a
> self-healing retry loop that explains each fix in plain English.

> 🏗️ **Build status:** early days. **Stage 0** (scaffold), **Stage 1** (the manual
> container foundation — real templates, runnable samples, golden snapshot tests),
> **Stage 2** (static, AI-free stack detection), **Stage 3** (AI template-filling +
> env inference, BYOK), and **Stage 4** (service plan + Mermaid diagram + approval
> gate) are done. Later stages (build/self-heal, orchestrate, CLI) are still stubs
> that `throw new Error("not implemented")`.
> See [Stage progress](#stage-progress).

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

- **Frontend:** Node / React (Vite dev server)
- **Backend:** Node / Express **or** Python / Django
- **Database:** Postgres **or** MongoDB (Redis detected as an optional cache)
- **Package managers:** npm / yarn / pnpm (Node), pip / poetry (Python)

Anything outside this set is declined with a clear warning rather than guessed at.

## Usage (planned)

ORCA is **BYOK** — you supply your own API keys. Qwen3-Coder is the primary model;
Claude is the automatic fallback (see `.env.example` for routing overrides).

```bash
export QWEN_API_KEY=sk-...        # primary (Qwen3-Coder via any OpenAI-compatible host)
export ANTHROPIC_API_KEY=sk-ant-... # fallback (Claude)

# Show the plan + service-graph diagram only; build nothing:
orca run <repo-url> --dry-run

# Full flow: detect → plan → approve → build/run → self-heal:
orca run <repo-url>
```

## Development

```bash
npm install
npm run build        # tsc
npm test             # vitest (all suites)
npm run lint         # eslint
npm run format       # prettier
npm run typecheck    # tsc --noEmit
```

Run just the Stage 1 template/golden tests:

```bash
npx vitest run tests/templates          # golden snapshot + YAML-parse + registry tests
npx vitest run tests/templates/golden.test.ts   # only the lossless-templatization snapshots
```

- **ESM only** (`"type": "module"`), TypeScript with `NodeNext` resolution.
- Single npm package (intentionally **not** a monorepo).
- Detectors are standalone so they could later become separate agents.

### Trying the sample apps (Stage 1)

The bundled samples are real and runnable with Docker (see
[`examples/README.md`](examples/README.md) for full manual-verification steps):

```bash
cd examples/mern-sample            && docker compose up --build   # React + Express + MongoDB
cd examples/django-postgres-sample && docker compose up --build   # Django + Postgres
```

---

## Stage 1 architecture — manual golden configs → templates → snapshot verification

Stage 1 is the **manual container foundation**. It contains no AI and no detection logic;
it establishes the deterministic core the later stages plug into, in three moves:

1. **Hand-write working configs (the golden files).** For each sample app we wrote concrete,
   runnable Dockerfiles + a `docker-compose.yml` by hand and proved they start with
   `docker compose up`. These live under each sample's `.orca-golden/` folder (and are
   mirrored into the sample's build locations so `docker compose up` just works).
2. **Extract them into Handlebars templates.** The golden files were generalized into
   `src/templates/**/*.hbs`, driven only by the render-context contract in
   `src/templates/types.ts` (`DockerfileVars` / `ComposeVars`). `src/templates/render.ts`
   is a pure renderer (compiles the `.hbs`, registers a few YAML/list helpers, returns a
   string — no file I/O). `src/templates/registry.ts` maps a detected component to the
   right template + sane default vars (the fallbacks the Stage 3 AI layer later refines).
3. **Prove the templates reproduce the golden files exactly.** The vitest suite in
   `tests/templates/` renders the known-good vars and asserts the output equals each
   `.orca-golden/` file byte-for-byte (trailing-whitespace normalized), parses the compose
   output as real YAML, and unit-tests the registry. If templatization ever drifts, a
   golden test fails.

```
DetectionResult ──▶ registry.ts ──▶ DockerfileVars / ComposeVars ──▶ render.ts ──▶ Dockerfile / compose.yml
 (Stage 2, stub)      (Stage 1)          (Stage 1 contract)            (Stage 1)         ‖  compared against
                                                                                        ‖  examples/*/.orca-golden/ (Stage 1 tests)
```

## Project structure (Stage 1 additions in **bold**)

```
src/templates/
├── types.ts                       ← REAL: DockerfileVars / ServiceSpec / ComposeVars contract
├── render.ts                      ← REAL: pure Handlebars renderer (renderDockerfile / renderCompose)
├── registry.ts                    ← REAL: DetectionResult → template + default vars
├── dockerfiles/
│   ├── node.Dockerfile.hbs        ← REAL template (React client / Express server)
│   └── python.Dockerfile.hbs      ← REAL template (Django app)
└── compose/
    └── docker-compose.hbs         ← REAL template (0..N services + db)

examples/
├── README.md                      ← samples index + manual-verification commands
├── mern-sample/                   ← runnable React+Vite / Express / MongoDB app
│   ├── client/ · server/          ← app source + in-place runnable Dockerfiles
│   ├── docker-compose.yml         ← in-place runnable stack
│   └── .orca-golden/              ← golden reference (snapshot-test target)
└── django-postgres-sample/        ← runnable Django / Postgres app
    ├── config/ · core/            ← Django project + one app/model/view/migration
    ├── Dockerfile · entrypoint.sh · docker-compose.yml   ← in-place runnable stack
    └── .orca-golden/              ← golden reference (snapshot-test target)

tests/templates/
├── sampleVars.ts                  ← known-good DockerfileVars/ComposeVars for the samples
├── golden.test.ts                 ← rendered output === .orca-golden/ files (lossless)
├── compose-yaml.test.ts           ← rendered compose parses as valid YAML
└── registry.test.ts              ← template selection + default vars
```

---

## Scaffolding Summary

This section records what exists and what is real vs. a stub. It is a map of the repository.

### Legend

- 🟢 **Real** — complete, working code/config you can rely on now.
- 🟡 **Stub** — top-of-file doc comment + typed signatures + `TODO(stage-N)` markers; bodies
  `throw new Error("not implemented")` (or return a typed placeholder).

### Stage progress

| Stage | Area                                                 | Status      |
| ----- | ---------------------------------------------------- | ----------- |
| 0     | Scaffold (structure, shared data contracts, configs) | 🟢 Complete |
| 1     | Templates + samples + golden snapshot tests          | 🟢 Complete |
| 2     | Detection (`src/detect/*`)                           | 🟢 Complete |
| 3     | AI template-filling (`src/ai/*`)                     | 🟢 Complete |
| 4     | Plan / approve (`src/plan/*`)                        | 🟢 Complete |
| 5     | Build + self-heal (`src/build/*`, `src/generate/*`)  | 🟡 Stub     |
| 6     | Orchestrate (`src/orchestrate/*`)                    | 🟡 Stub     |
| 7     | CLI (`src/cli/*`, `src/core/pipeline.ts`)            | 🟡 Stub     |

### Real implementations

**Shared data contracts (Stage 0):**

| File                                            | What it defines                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| 🟢 [`src/detect/types.ts`](src/detect/types.ts) | `DetectionResult` and all detection sub-types (STAGE 2 contract)     |
| 🟢 [`src/plan/types.ts`](src/plan/types.ts)     | `ServicePlan` / `ServiceNode` service-graph model (STAGE 4 contract) |
| 🟢 [`src/core/context.ts`](src/core/context.ts) | `RunContext` shared state + `createRunContext()` factory + defaults  |

**Stage 1 — the manual container foundation:**

| File                                                                                                    | What it does                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 🟢 [`src/templates/types.ts`](src/templates/types.ts)                                                   | **NEW** — `DockerfileVars` / `ServiceSpec` / `ComposeVars` render-context contract (the shape Stage 3 must produce)   |
| 🟢 [`src/templates/render.ts`](src/templates/render.ts)                                                 | **NEW** — pure Handlebars renderer: `renderDockerfile()` / `renderCompose()` (no output I/O)                          |
| 🟢 [`src/templates/registry.ts`](src/templates/registry.ts)                                             | `selectDockerfileTemplate()` + `defaultDockerfileVars()` + `describeComponent()` (pure lookup over `DetectionResult`) |
| 🟢 [`src/templates/dockerfiles/node.Dockerfile.hbs`](src/templates/dockerfiles/node.Dockerfile.hbs)     | Node template — covers the React client and the Express server                                                        |
| 🟢 [`src/templates/dockerfiles/python.Dockerfile.hbs`](src/templates/dockerfiles/python.Dockerfile.hbs) | Python template — Django app (systemPackages + migrate entrypoint)                                                    |
| 🟢 [`src/templates/compose/docker-compose.hbs`](src/templates/compose/docker-compose.hbs)               | Compose template — iterates services (build vs image), env, ports, depends_on, volumes, healthcheck                   |
| 🟢 `examples/mern-sample/**`                                                                            | Runnable React+Vite / Express / MongoDB app + `.orca-golden/` reference                                               |
| 🟢 `examples/django-postgres-sample/**`                                                                 | Runnable Django / Postgres app + `.orca-golden/` reference                                                            |
| 🟢 `tests/templates/**`                                                                                 | Golden snapshot, compose-YAML, and registry tests (18 assertions, nothing mocked)                                     |

**Stage 2 — static, AI-free stack detection:**

| File                                                              | What it does                                                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 🟢 [`src/detect/manifest.ts`](src/detect/manifest.ts)             | **NEW** — shared package.json / requirements.txt / pyproject.toml dependency readers                             |
| 🟢 [`src/detect/language.ts`](src/detect/language.ts)             | Languages from file extensions + manifest presence, evidence-ordered                                             |
| 🟢 [`src/detect/packageManager.ts`](src/detect/packageManager.ts) | Lockfiles in priority order (pnpm → yarn → npm, poetry), then manifest fallbacks                                 |
| 🟢 [`src/detect/framework.ts`](src/detect/framework.ts)           | react / express / django from dependency manifests                                                               |
| 🟢 [`src/detect/services.ts`](src/detect/services.ts)             | Client libraries → postgres / mongodb / redis (+ default ports + which lib revealed it)                          |
| 🟢 [`src/detect/entrypoint.ts`](src/detect/entrypoint.ts)         | Start command: package.json scripts (dev > start > serve) → Procfile → manage.py                                 |
| 🟢 [`src/detect/ports.ts`](src/detect/ports.ts)                   | Ports from `.env` / Dockerfile `EXPOSE` / code literals, else framework default                                  |
| 🟢 [`src/detect/index.ts`](src/detect/index.ts)                   | `detectStack()` — locates component roots, aggregates detectors, decides `isSupported` + `confidence` + warnings |
| 🟢 [`src/utils/fs.ts`](src/utils/fs.ts)                           | Filesystem helpers the detectors walk/read through (safe reads, ignore-aware walk)                               |
| 🟢 `tests/detect/` + `tests/fixtures/`                            | Fixture-driven tests: MERN repo, Django+Postgres repo, unsupported (Rust) repo                                   |

**Stage 3 — AI template-filling + env inference (multi-provider, BYOK, mocked in tests):**

Qwen3-Coder is the **primary** provider; Claude is the **fallback**. The router tries
Qwen (up to 2 attempts), validates every response, and escalates to Claude on thrown
errors, invalid JSON, schema failures, or self-reported low confidence. Orchestrators
call `ai.complete(prompt, schema, ledger)` and never learn which provider ran.

| File                                                                | What it does                                                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 🟢 [`src/ai/providers/types.ts`](src/ai/providers/types.ts)         | `AIProvider` interface + `recordUsage()` (per-provider cost slices on the run ledger)                                     |
| 🟢 [`src/ai/providers/qwen.ts`](src/ai/providers/qwen.ts)           | Qwen3-Coder over the OpenAI-compatible protocol (DashScope/vLLM/Ollama via `QWEN_BASE_URL`), built-in fetch, no new deps  |
| 🟢 [`src/ai/providers/anthropic.ts`](src/ai/providers/anthropic.ts) | Claude via the Anthropic SDK — the only module touching it; per-model pricing for the ledger                              |
| 🟢 [`src/ai/router.ts`](src/ai/router.ts)                           | Primary→retry→fallback policy, pre-call cost-cap gate (global across providers), low-confidence escalation                |
| 🟢 [`src/ai/client.ts`](src/ai/client.ts)                           | The `ai.complete()` facade orchestrators use + legacy Anthropic-direct `complete()`                                       |
| 🟢 [`src/ai/schema.ts`](src/ai/schema.ts)                           | `parseModelJson()` + `validateAgainst()` — fence-stripping JSON parse + zod; invalid AI output is rejected, never trusted |
| 🟢 [`src/ai/prompts/fill.ts`](src/ai/prompts/fill.ts)               | Fill-template prompt: strict JSON shape, refine-the-defaults framing, README/detection grounding                          |
| 🟢 [`src/ai/prompts/infer-env.ts`](src/ai/prompts/infer-env.ts)     | Infer-env prompt: compose-aware dev defaults (service-name hosts, placeholder secrets)                                    |
| 🟢 [`src/ai/prompts/heal.ts`](src/ai/prompts/heal.ts)               | Heal prompt (consumed by Stage 5): plain-English explanation + fix + full-file patches                                    |
| 🟢 [`src/ai/fillTemplate.ts`](src/ai/fillTemplate.ts)               | prompt → `ai.complete()` → validated `FilledTemplateVars`, anchored on the registry defaults                              |
| 🟢 [`src/ai/inferEnv.ts`](src/ai/inferEnv.ts)                       | prompt → `ai.complete()` → validated `InferredEnv`                                                                        |
| 🟢 `tests/ai/`                                                      | Qwen mocked at the fetch boundary, Claude at the SDK boundary; routing, cost, and validation run for real (15 tests)      |

**Stage 4 — service plan, Mermaid diagram, approval gate (+ pre-Stage-4 groundwork):**

| File                                                            | What it does                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 🟢 [`src/plan/servicePlan.ts`](src/plan/servicePlan.ts)         | Detection + refined vars → `ServiceNode`s with golden-config conventions (images, healthchecks, env, volumes, edges)     |
| 🟢 [`src/plan/diagram.ts`](src/plan/diagram.ts)                 | `ServicePlan` → Mermaid flowchart (cylinders for db/cache, labeled dependency edges, ports)                              |
| 🟢 [`src/plan/review.ts`](src/plan/review.ts)                   | Approve-before-build gate: diagram + service table, y/N prompt, `--auto-approve`, safe non-TTY rejection                 |
| 🟢 [`src/generate/composeVars.ts`](src/generate/composeVars.ts) | `planToComposeVars()` — the single owned plan → render-context mapping (conditions deferred to Stage 6)                  |
| 🟢 [`src/ai/refineVars.ts`](src/ai/refineVars.ts)               | Typed boundary: merges validated AI refinements onto the registry's deterministic defaults                               |
| 🟢 [`src/clone/workspace.ts`](src/clone/workspace.ts)           | Temp workspace + local-copy / shallow-clone + idempotent cleanup                                                         |
| 🟢 [`scripts/copy-templates.mjs`](scripts/copy-templates.mjs)   | Ships the `.hbs` templates in `dist/` (build step) so the published package can render                                   |
| 🟢 `tests/plan/` · `tests/clone/` · `tests/ai/refine.test.ts`   | Plan assembly, diagram, plan→compose YAML round-trip, approval gate via injected streams, workspace lifecycle (16 tests) |

Other real-but-thin Stage 0 code: 🟢 [`src/utils/errors.ts`](src/utils/errors.ts) (typed error
classes), 🟢 [`src/config/settings.ts`](src/config/settings.ts) (`DEFAULT_SETTINGS`; `loadSettings()`
is a stub), 🟢 [`src/types/index.ts`](src/types/index.ts) (type re-exports).

### Real configuration files

| File                                                              | Purpose                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 🟢 `package.json`                                                 | ESM package, `orca` bin, all deps declared (adds `yaml` for the compose-parse test)                                 |
| 🟢 `tsconfig.json`                                                | Strict TS, `NodeNext` module + resolution, `dist/` output                                                           |
| 🟢 `eslint.config.js` · `.prettierrc`                             | Lint + format                                                                                                       |
| 🟢 `vitest.config.ts`                                             | Node test env, coverage, `.js`→`.ts` extension-alias so tests can import the sources                                |
| 🟢 `.gitignore`                                                   | node_modules, dist, coverage, `.env`, `.orca/`, Python caches/venvs — **never** `.orca-golden/`, templates, samples |
| 🟢 `.env.example` · `LICENSE` · `.devcontainer/devcontainer.json` | BYOK key, MIT, dogfood devcontainer                                                                                 |

### Stub source files (later stages)

| Stage         | Files (all 🟡 stubs)                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| 5 build       | `src/build/{docker,runner,selfHeal,diagnosisLog}.ts`, `src/generate/writeConfigs.ts` |
| 6 orchestrate | `src/orchestrate/{healthchecks,dependsOn,envFiles}.ts`                               |
| 7 cli         | `src/cli/index.ts`, `src/cli/commands/run.ts`, `src/cli/output/index.ts`             |
| core          | `src/core/pipeline.ts`                                                               |
| utils         | `src/utils/logging.ts`                                                               |

The Stage 5 test specs (`tests/build/`) remain `it.todo` placeholders until that stage
is implemented.

### Assumptions & notes

- **`.orca-golden/` mirrors the in-place files.** Each sample commits its runnable
  Dockerfiles/compose in the normal build locations **and** byte-identical copies under
  `.orca-golden/`. The golden copies are the snapshot-test target; the in-place copies make
  `docker compose up` work with no copy step. (`.gitignore`'s `.orca/` rule matches only the
  runtime-workspace dir, not `.orca-golden/`.)
- **Dev-mode, not production images.** The samples target hot-reload dev servers with source
  bind-mounts (and an anonymous `/app/node_modules` volume for Node), per Stage 1's scope.
- **`dependencyFiles` copies only the manifest** (e.g. `package.json`, not the lockfile):
  messy student repos often lack a lockfile, and `COPY`-ing a missing file breaks the build.
- **`renderDockerfile` chooses node vs. python by `packageManager`** (pip/poetry → Python),
  since `DockerfileVars` carries no explicit language field.
- **Docker is not run in this environment** — Stage 1 is verified by the golden snapshot
  tests (`npm test`) and by the manual `docker compose up` steps documented in
  `examples/README.md`.
- **`NodeNext` ESM** means intra-project imports use explicit `.js` extensions in `.ts`
  sources; `vitest.config.ts` adds an `extensionAlias` so tests resolve them to `.ts`.
