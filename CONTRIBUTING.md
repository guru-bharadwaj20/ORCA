# Contributing to ORCA

Thanks for working on ORCA. This page is the one-stop orientation: how to get set up,
the ground rules for a change, and the **project roadmap** so you can see what's done,
what's underway, and what's free to pick up.

## Getting set up

```bash
npm install
npm run build        # tsc + copy templates into dist/
npm test             # vitest (hermetic — no keys, no Docker)
npm run lint
npm run typecheck
npm run format:check
```

ESM-only TypeScript with `NodeNext` resolution; intra-project imports use explicit `.js`
extensions. The repo is an npm-workspaces monorepo — the root package is the publishable
`orca-agent-cli`, and `vscode-extension/` consumes it through its subpath exports.

## Ground rules

- **Green before every push.** `typecheck`, `lint`, `format:check`, and the full test
  suite must all pass. Tests stay hermetic (temp-dir fixtures, injected AI facade — no
  network, no Docker, no VS Code).
- **Small, focused PRs.** One coherent unit per branch; branch off `main`, open a PR.
  With several people active, PRs (not direct-to-`main` pushes) keep everyone's work
  from colliding.
- **Adding a stack is adding data, not editing an enum.** New frameworks/ecosystems land
  as a `BuildRecipe` + matcher + test, never as new control flow. See
  [`docs/universal-understanding-plan.md`](docs/universal-understanding-plan.md).
- **Commit messages:** short (4–6 words), a conventional prefix
  (`feat:`/`fix:`/`chore:`/`test:`/`refactor:`/`docs:`), written like an engineer wrote
  them.

## Roadmap

At-a-glance status. The full architecture and rationale are in
[`docs/universal-understanding-plan.md`](docs/universal-understanding-plan.md).

### Legend

Each item has **one** stub. A completed item is green; a not-started item is red; an
item someone is **actively working on** shows **that person's** colour instead.

| Stub | Meaning              |
| ---- | -------------------- |
| 🟢   | Completed            |
| 🔴   | Yet to be done       |
| 🟠   | In progress — Diya   |
| 🟣   | In progress — Guru   |
| 🔵   | In progress — Harsha |
| ⚪   | In progress — Vivian |

### Universal Repository Understanding — phases

| Stub | Phase                          | What it delivers                                                                                                                   |
| :--: | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
|  🟢  | **A — Foundation**             | Evidence model (`Claim`/`Evidence`/`Detector`), confidence combination, `BuildRecipe` as data, seed stacks re-expressed as recipes |
|  🟢  | **B — Widen detection**        | Runtime detectors + recipes per ecosystem (19 recipes), framework signature table (23), open runtime taxonomy                      |
|  🟢  | **C — Repo & CI analysis**     | GitHub Actions / task-runner recovery, existing-Dockerfile detection, cross-tier confidence                                        |
|  🟢  | **D — AI inference**           | LLM gap-filler when the deterministic ladder is thin, confidence-capped, reasoning trail                                           |
|  🟢  | **E — Docker synthesis**       | Multi-stage Dockerfiles synthesized from any recipe (compiled → slim runtime; interpreted → single stage)                          |
|  🟢  | **F — Recipe-aware self-heal** | Heal loop gets recipe context; learned overrides persisted per repo signature (`~/.orca`) and replayed next run                    |
|  🟢  | **G — Dynamic probing**        | Tier-4 `Prober` seam + security contract (execution deferred by design)                                                            |

### Ecosystem recipe coverage

| Stub | Ecosystem | Recipes                                               |
| :--: | --------- | ----------------------------------------------------- |
|  🟢  | Node      | react · express · next · nest · angular · vite        |
|  🟢  | Python    | django · fastapi · flask (uv / poetry / pip variants) |
|  🟢  | PHP       | composer · laravel                                    |
|  🟢  | Ruby      | bundler · rails · sinatra                             |
|  🟢  | Go        | go-mod (distroless)                                   |
|  🟢  | Rust      | cargo                                                 |
|  🟢  | JVM       | maven · gradle                                        |
|  🟢  | .NET      | dotnet-sdk                                            |

### Remaining work — free to pick up

| Stub | Item                             | Notes                                                                                                                                                                                                                                                                                                  |
| :--: | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|  🟢  | Flaky `hostPorts` test           | Now allocates real free ports from the OS instead of hardcoding — deterministic in CI                                                                                                                                                                                                                  |
|  🟢  | Ecosystem example repos          | Go/Rust/JVM/.NET/PHP/Ruby samples shipped, each pinned by a synthesizer golden test (Phase B3)                                                                                                                                                                                                         |
|  🟢  | `PackageManager` open taxonomy   | Now an open string + `KNOWN_PACKAGE_MANAGERS` set, mirroring `Runtime` — a new manager is data, not an enum edit                                                                                                                                                                                       |
|  🟢  | Per-ecosystem entrypoints        | Synthesizer now honors `recipe.entrypointScript` (COPY + chmod + ENTRYPOINT) for any recipe, seed or ecosystem                                                                                                                                                                                         |
|  🟢  | Plan-doc reconciliation          | `docs/universal-understanding-plan.md` now reflects Phase F persistence, 19 recipes, examples, open PkgManager                                                                                                                                                                                         |
|  🟢  | Container-file port detection    | `detectPorts` now reads EXPOSE from any Containerfile / `Dockerfile.*` variant (not just a bare `Dockerfile`) and keeps every exposed port, sharing the name/EXPOSE parsing with `analyzeDockerfiles`                                                                                                  |
|  🟢  | pnpm `dir/**` workspace globs    | `expandWorkspaceGlobs` now expands the ubiquitous `packages/**` / `apps/**` form to immediate subdirectories, so real pnpm monorepos promote their packages instead of detecting none                                                                                                                  |
|  🟢  | Kotlin-DSL Gradle language       | `detectLanguages` now treats `build.gradle.kts` / `settings.gradle{,.kts}` as JVM signals, matching the runtime detector and manifest reader — a `.kts`-only module is no longer missed                                                                                                                |
|  🟢  | Cargo dependency subtables       | `readRustDependencies` now reads `[dependencies.<name>]` subtables (features / git / path / optional deps) and target-specific tables — crates declared this way were previously dropped entirely                                                                                                      |
|  🟢  | Route Node frameworks to recipes | `node-next`/`nest`/`angular`/`vite` recipes exist but are unreachable: a Next.js repo detects as seed `react`, never routing to `node-next`. Needs the seed/ecosystem boundary to defer to a framework recipe when one matches                                                                         |
|  🟢  | Symfony-aware PHP recipe         | Symfony repos fall to the generic `php-composer` recipe; its `public/` front controller works but a dedicated recipe could run `symfony server` and detect the framework as an insight (parallel to Laravel)                                                                                           |
|  🟢  | Multi-port service plan wiring   | `detectPorts` now surfaces every EXPOSE'd port, but the plan/compose layer still publishes the first — thread the extra ports through to `ServiceSpec.ports`                                                                                                                                           |
|  🟢  | Broader component roles          | `detectComponentRole` assigns `worker`/`cli` from Procfile / queue libs / npm `bin`, all gated on "declares no port"; only listening roles get a default port and publish one (`docs` §2.3)                                                                                                            |
|  🟢  | Multi-provider CI detection      | GitLab CI, Azure Pipelines, and CircleCI parsers feed `insights.ciProviders` as structured stages/jobs alongside the existing GitHub Actions path                                                                                                                                                      |
|  🟢  | README / shell-script parsing    | `readme.ts` + `shellScript.ts` recover build/run commands and ports from README fenced-shell blocks and shipped `*.sh` as deterministic tier-1 signals (`insights.scriptSources`), no longer AI-only                                                                                                   |
|  🟢  | Consume `ciProviders` in plan    | `buildRecovery.ts` folds CI (all providers), task runners, and README/scripts into one ranked `insights.recoveredBuild` claim; the plan overlays it onto the matched recipe and carries `commandOrigins` provenance                                                                                    |
|  🟢  | Emit `readme` port source        | `detectPorts` now emits `source: 'readme'` for ports a component's own README declares (`-p`, `--port`, `PORT=`, `EXPOSE`, `localhost:`), merged last through the existing tier logic and filtered of known service ports                                                                              |
|  🟢  | `library` / `job` role detectors | `detectors/role.ts` adds `jobDetector` (cron table, or a Procfile `release:`/`cron:` with no long-lived process) and `libraryDetector` (per-ecosystem "nothing to run" rules for Node/Go/Rust/Python; JVM/PHP/.NET/Ruby decline rather than guess). Neither role takes a port                          |
|  🟢  | CircleCI `workflows` ordering    | `circleci.ts` now parses `workflows:`, resolves each workflow's `requires:` DAG topologically, and fills `stages` with workflow-qualified `<workflow>:<job>` entries; each job also reports the workflow that runs it                                                                                  |
|  🟢  | CircleCI reusable `commands`     | `circleci.ts` expands the top-level `commands:` block as a pre-processing pass before collecting a job's steps, substituting simple scalar parameters (and their defaults) and inlining nested references; orb and unresolvable commands are skipped cleanly, contributing nothing rather than garbage |
|  🟢  | Azure/GitLab `include` expansion | Azure `template:`/`extends:` and GitLab `include:` pull job definitions from other files; both parsers read only the entry document, so an `include`-driven pipeline recovers no commands. Resolve local includes                                                                                      |
|  🟢  | CI runtime versions cross-tier   | GitHub Actions pins feed `insights.ciRuntimeVersions`, but the GitLab/Azure/CircleCI parsers never populate it (their image tags carry the runtime version) — extract e.g. `node:20`/`python:3.12` from provider images                                                                                |
|  🔴  | Probing implementation           | Phase G execution behind the existing seam — deferred by design decision #2                                                                                                                                                                                                                            |

**When you start on a red item, change its stub to your colour; when you finish, make it
green.**
