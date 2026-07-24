# ORCA: Universal Repository Understanding — Architecture & Roadmap

Design document for evolving ORCA from a three-framework template system into a
generic repository-understanding engine. Written against the **actual** codebase
(commit at time of writing), so every "today" claim below is checked against the
real seams, and every proposed contract extends one that already exists.

> **North star:** _"Give ORCA any public repository, and it figures out how to
> build, containerize, and run it."_

**Three decisions frame this whole document** (made up front, not deferred):

1. **Generic engine, templates become data.** The runtime/build/run model is the
   primary abstraction. The current React/Express/Django logic is re-expressed as
   data-driven **recipes** inside it — not kept as a parallel hardcoded path.
2. **Dynamic probing (Phase 6) is designed-for but deferred.** We cut the seams so
   sandboxed execution can slot in later; we do **not** build arbitrary-code
   execution in the near-term roadmap. Static + CI + AI inference reaches the large
   majority of repos without that security surface.
3. **Deterministic-first stays sacred.** AI is a fallback that _fills gaps and
   ranks_, never the primary source of truth. Every output carries a confidence
   score and a reasoning trail.

---

## 1. Where ORCA actually is today

The current pipeline (`src/core/pipeline.ts`):

```
Clone → detectStack → [AI fill vars] → buildServicePlan → approve → writeConfigs → build+selfHeal
         (STAGE 2)      (STAGE 3)        (STAGE 4)                     (STAGE 5)
```

What's genuinely good and worth preserving:

- **Detectors are already standalone.** `src/detect/index.ts` composes independent
  detectors (`framework`, `language`, `ports`, `entrypoint`, `services`,
  `packageManager`, `manifest`). The header comment even says each "could later
  become its own agent." The plugin architecture is _latent_ here already.
- **Confidence scoring already exists** — `scoreConfidence()` returns a 0..1 number,
  though at time of writing it was a single hardcoded heuristic in `index.ts`.
  (Since replaced by the evidence-combination model of §4: `confidenceEvidence()` emits
  weighted `Evidence`, and `combineConfidence()` folds it into the score.)
- **AI already only refines, never originates.** `registry.ts` produces deterministic
  default `DockerfileVars`; the AI layer (`ai/fillTemplate.ts`) overrides fields on
  top. This is exactly the "AI as fallback" philosophy — it just needs generalizing.
- **The `ServicePlan` contract** (`src/plan/types.ts`) is already a clean,
  compose-shaped IR that the diagram, review gate, config writer, and build loop all
  read. It is a good target for a generic synthesizer to emit into.

What blocked the vision when this document was written (the real constraints, with file
references). **These are kept verbatim as the original diagnosis**; each now carries its
current status, so the reasoning that motivated the roadmap is not lost:

- **Closed union types.** `src/detect/types.ts` hardcodes the entire supported world:
  `Language = 'javascript'|'typescript'|'python'|'unknown'`,
  `FrontendFramework = 'react'|'unknown'`,
  `BackendFramework = 'express'|'django'|'unknown'`. Every new ecosystem today means
  editing these unions — the opposite of extensible.
  → **Resolved (Phase A/B).** `Runtime` and `PackageManager` are open (known-set + string);
  `Language` covers 9 ecosystems. `FrontendFramework`/`BackendFramework` remain closed but
  are no longer load-bearing — framework identification runs through the data-driven
  signature table in `detect/frameworkSignatures.ts`, and build behavior comes from
  `BuildRecipe`s, not from these unions.
- **Roles are hardcoded to frontend/backend/database.** `detect/index.ts` and the
  pipeline's `COMPONENT_ROLES` assume a web-app shape. A Rust CLI, a Go worker, or a
  Java batch job has no "frontend"; the model can't represent them.
  → **Resolved (§2.3).** `ComponentRole` is now
  `frontend|backend|database|worker|cli|library|job`, and `worker`/`cli` have real
  deterministic detectors (`detect/componentRole.ts`).
- **`registry.ts` is a `switch` statement**, not data. `selectDockerfileTemplate`,
  `installCommandFor`, `startCommandFor`, `defaultPortFor` are all hardcoded control
  flow over the closed enums.
  → **Largely resolved (Phase A/E).** 19 recipes are data behind `RecipeRegistry.match()`,
  and `synthesizeDockerfile` emits images from them. `templates/registry.ts` still serves
  the three seed stacks through their hand-tuned Handlebars templates — deliberate, not
  pending: they are hand-verified goldens and the generic path does not improve them.
- **Detection is single-pass and static-only.** There is no notion of CI parsing,
  README understanding as a _detection source_, or an inference ladder that escalates
  when deterministic signals run out.
  → **Resolved (Phase C/D).** GitHub Actions parsing, task-runner recovery, Dockerfile
  parsing, README/shell-script parsing, and a tier-3 AI rung all exist and are wired into
  `insights` + the confidence trail.
- **`isSupported: boolean` is binary.** The pipeline hard-throws `UnsupportedStackError`
  when false. There's no "I'm 60% sure this is a Go/Gin service, here's my reasoning,
  approve to proceed" middle ground — which is the entire point of universal support.
  → **Partially resolved.** `isSupported` is still a boolean on `DetectionResult`, but it
  is no longer the end of the line: when it is false and an API key is present, the
  pipeline runs tier-3 inference and promotes a confident result into a buildable
  component, hard-stopping only when even inference fails. The graded
  `{ recipe, tier }` outcome described in §4 is **not** implemented — see §10.

---

## 2. The core architectural shift

### 2.1 From closed enums to an open, evidence-based model

Replace the closed unions with an **open taxonomy** plus a uniform evidence record.
The key type every detector produces and every later stage consumes:

```ts
/** One piece of evidence for a claim, so every inference is explainable. */
interface Evidence {
  detector: string; // "manifest:cargo", "ci:github-actions", "ai:inference"
  signal: string; // human-readable: "Cargo.toml present", "CI runs `cargo build`"
  weight: number; // contribution to confidence, 0..1
}

/** A scored claim about the repo. Detectors emit these; the aggregator ranks them. */
interface Claim<T> {
  value: T;
  confidence: number; // 0..1, derived from evidence (see §4)
  evidence: Evidence[]; // the reasoning trail — never empty
  source: 'deterministic' | 'ci' | 'ai' | 'probe'; // which tier produced it
}
```

`runtime`, `framework`, `packageManager`, `ports`, `buildCommand`, `startCommand`
all become `Claim<T>` (or `Claim<T>[]` when ranked). The example JSON from the brief
falls straight out of this:

```json
{
  "runtime": "rust",
  "confidence": 0.92,
  "reasoning": ["Cargo.toml detected", "Binary crate present", "CI executes cargo build"]
}
```

That object is just `Claim<Runtime>` with `evidence[].signal` projected to strings.

### 2.2 The BuildRecipe: the generic build model (Phase 2, the linchpin)

The abstraction that replaces `registry.ts`'s switch. A **recipe** is _data_, not code:

```ts
interface BuildRecipe {
  id: string; // "node-vite", "rust-cargo", "python-fastapi"
  runtime: Runtime; // open string, e.g. "node" | "python" | "rust" | "go" | "jvm" | ...
  packageManager?: PackageManager;
  installCommands: string[]; // ["cargo fetch"] or ["npm ci"]
  buildCommands: string[]; // ["cargo build --release"]
  startCommand: string; // "./target/release/{{binary}}" (templated)
  artifacts?: string[]; // produced files a runtime stage copies (multi-stage builds)
  defaultPorts: number[];
  baseImages: { build: string; runtime: string }; // multi-stage: builder + slim runtime
  needsSystemPackages?: string[]; // apt deps (libpq-dev, etc.)
}
```

Two ways a recipe gets chosen, in strict priority order:

1. **A matched recipe** from the registry — the deterministic path. The current
   React/Express/Django logic becomes ~5 seed recipes expressed as data (decision #1).
2. **A synthesized recipe** — assembled from `Claim`s when no registry recipe matches
   (Phases 2/5). This is where AI inference lands: it proposes recipe _fields_, each
   validated against a zod schema and shown with reasoning before use.

Crucially, the plan approval gate now shows the **recipe** (build/run commands,
base images, ports) — so "reviewable, explainable" holds even for a repo ORCA has
never seen, because the user reviews the concrete commands before anything runs.

### 2.3 Component roles become open — **LANDED**

`ComponentRole` widens beyond `frontend|backend|database`. As shipped, the union is:

```ts
type ComponentRole = 'frontend' | 'backend' | 'database' | 'worker' | 'cli' | 'library' | 'job';
```

The widening is **additive** — `frontend`/`backend`/`database` behave exactly as before,
and no existing repo was reclassified. What changed downstream:

- **Only `frontend`/`backend` are assumed to listen** (`LISTENING_ROLES` in
  `detect/types.ts`). `defaultPortFor` returns `null` for every other role instead of
  fabricating 3000, and `ecosystemServiceNode` publishes no port for them — necessary
  because every shipped ecosystem recipe carries `defaultPorts: [8080]`, written for web
  services, which a worker would otherwise advertise with nothing bound to it.
- **`detect/componentRole.ts`** assigns a role from deterministic evidence. Its master
  gate is "does it listen?": a component declaring a port in `.env`, a Dockerfile
  `EXPOSE`, or its own source is a service regardless of anything else. That is what stops
  a Django app which merely depends on Celery from being demoted to a worker.
- The role rides on `insights.ecosystemComponents[].role` and is propagated by
  `ecosystemComponentsFrom` into the plan.

Which roles have detectors, and which are vocabulary only:

| Role      | Status       | Signal                                                                                                                                                                                            |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker`  | **detected** | Procfile `worker:` with no `web:`; a worker start command; or a queue library (Celery/Sidekiq/BullMQ/asynq…) with no web framework — all gated on no declared port                                |
| `cli`     | **detected** | `package.json` `bin` with no `start`/`dev`/`serve` script and no port                                                                                                                             |
| `library` | **detected** | Per-ecosystem "nothing to run" rules (Node: no bin/server script/entry module; Go: no `package main`; Rust: lib target only; Python: packaged with no runnable module). JVM/PHP/.NET/Ruby decline |
| `job`     | **detected** | A cron table, or a Procfile `release:`/`cron:`/`scheduler:` process with no `web:`/`worker:` beside it — all gated on no declared port                                                            |

`job` and `library` are `Detector` plugins in `detect/detectors/role.ts` (`ROLE_DETECTORS`),
consulted by `detectComponentRole` only after its positive worker/cli rules decline, so
positive evidence always outranks negative. They are kept out of `defaultDetectorRegistry()`
on purpose: that registry's tier-1 claims are read as `Claim<Runtime>`, and mixing claim
value types in one registry would corrupt runtime detection.

`library` rests on negative evidence, so its rules are **per-ecosystem rather than generic**.
A first draft used one "no recognizable entry file" heuristic and mislabelled real services —
a Maven app entered through `src/main/java/.../App.java`, a PHP app served from
`public/index.php`. Ecosystems without a reliable library convention now decline instead of
guessing, which is decision #3 applied to a detector rather than to a whole role.

The `ServicePlan` synthesizer maps roles onto compose services. A `cli`/`job` currently
becomes an ordinary (portless) `'service'` node; surfacing it as "runnable but not a
long-lived service" — a one-shot `restart: no` node, or a distinct plan affordance — is
**not** implemented (see §10).

> NOTE: `core/pipeline.ts` has its own local `ComponentRole` that shadows this one. It is
> intentionally narrower — the two seed-stack slots (`.frontend`/`.backend`) that get an
> AI template fill and a rendered Dockerfile — and must NOT be widened alongside the
> shared type. Worker/CLI components never flow through it.

---

## 3. Target architecture (the inference ladder)

The brief's target pipeline, mapped onto ORCA's stages. The spine is an **escalating
ladder**: each rung runs only when the rungs above leave confidence below a threshold.
Deterministic-first means the cheap, certain tiers always run first and AI/probe only
fill the gaps.

```
Clone
  ↓
Manifest Detection      ── deterministic, tier 1  (Phase 1)  — always runs            [LANDED]
  ↓
Repository Analysis     ── deterministic, tier 1  (Phase 3)  — README/Makefile/justfile/scripts/Dockerfile
  ↓                                                                                    [LANDED]
CI Analysis             ── deterministic, tier 2  (Phase 4)  — often the ground truth for commands
  ↓                                                                       [LANDED: GitHub Actions only]
────────── confidence gate: is the recipe complete & above threshold? ──────────
  ↓ (only if gaps remain)                                        [PARTIAL — see §4 note]
AI Inference            ── fallback, tier 3       (Phase 5)  — proposes claims, schema-validated
  ↓                                                                                    [LANDED]
[Dynamic Probing]       ── tier 4, DESIGNED, DEFERRED (Phase 6) — seam only, not built now
  ↓                                                                               [SEAM ONLY]
Docker Synthesis        ── generic, recipe-driven (Phase 7)                            [LANDED]
  ↓
Build → Observe → Self-Heal (Phase 8, recipe-aware)                                    [LANDED]
  ↓
Final Plan (already exists as ServicePlan + review gate)
```

Tier-1 repository analysis is the broadest rung as shipped. It covers, in
`src/detect/`: `dockerfile.ts` (existing Dockerfiles as ground-truth recipes),
`taskRunners.ts` (Makefile / Taskfile / justfile / package scripts), and
`readme.ts` + `shellScript.ts` (fenced shell blocks in a README; `start.sh`, `run.sh`,
`dev.sh`, `scripts/*.sh`, `bin/*.sh`).

The README/shell rung is deliberately the **weakest** member of tier 1: it is strictly
gap-filling, contributing confidence only when neither a Dockerfile nor CI already spoke,
and it can never promote an unsupported repo. Placement is by ladder rung (when a source
runs); reliability is expressed separately through `Evidence.weight` (§4).

Every rung writes `Claim`s into a shared `RepoModel`; it never mutates another
detector's output. The aggregator (§4) merges and ranks. This is the plugin
architecture the brief asks for: **a detector is a function `(RepoContext) → Claim[]`**,
registered in a list, independently testable, independently extensible.

```ts
interface Detector {
  id: string;
  tier: 1 | 2 | 3 | 4; // ladder rung
  detect(ctx: RepoContext): Promise<Claim<unknown>[]>;
}
```

`detect/index.ts` already _almost_ does this — it composes standalone detectors and
aggregates. The refactor formalizes the interface and makes the registry a list you
push to, rather than a hardcoded `Promise.all`.

---

## 4. Confidence & explainability model

Confidence is computed, never guessed, and always traceable:

- Each `Evidence` carries a `weight`. A claim's confidence is a saturating combination
  of its evidence weights (e.g. `1 - Π(1 - wᵢ)`), capped at 1.0. Independent signals
  agreeing (manifest **and** CI **and** imports all say "rust") drive confidence up;
  a lone weak signal stays low.
- **Cross-tier agreement is the strongest signal.** If deterministic detection says
  `cargo build` and CI analysis independently finds `cargo build --release`,
  confidence should exceed either alone — this is why CI analysis (Phase 4) is high
  value even though it's "just parsing YAML."
- **AI claims are capped.** An AI-sourced claim can never exceed a ceiling (say 0.7)
  on its own, enforcing "AI is fallback, not primary." It can _raise_ a deterministic
  claim's confidence by agreeing, but can't outrank determinism by fiat.
- The `reasoning[]` array in the brief's example is `evidence.map(e => e.signal)`.
  Nothing is ever presented to the user without it.

`isSupported: boolean` is **replaced** by a graded outcome:
`{ recipe: Claim<BuildRecipe>, tier: 'confident' | 'inferred' | 'guess' | 'unknown' }`.
The pipeline stops hard-throwing; instead the review gate communicates uncertainty
("ORCA is 62% confident — here's the reasoning; approve to build") and lets the human
decide. That single change is what turns "3 supported frameworks" into "attempt any
repo, honestly."

> **STATUS: not implemented — this paragraph remains aspirational.** `DetectionResult`
> still carries `isSupported: boolean` and `confidence: number`, and the review gate does
> not surface a confidence tier. What _did_ land is the escape hatch beneath it: an
> unsupported repo with an API key goes to tier-3 inference and builds from the inferred
> recipe rather than hard-stopping, and `reasoning[]` is populated and logged on every
> run. The typed graded outcome is tracked in §10.

The explicit **confidence gate** in §3 ("only if gaps remain") is also only partly real:
tier-3 inference is gated on `!detection.isSupported`, i.e. a binary did-we-place-it
check, not on a confidence threshold or on per-field recipe completeness. A repo that is
placed but poorly understood never escalates.

---

## 5. Phased roadmap

Sequenced by dependency, not by the brief's numbering. Each phase is independently
shippable and leaves the product working.

### Phase A — Foundation refactor (no new ecosystems yet)

_The enabling work everything else depends on._

- [x] Introduce `Claim<T>` / `Evidence` / `Detector` contracts in a new `src/model/`.
- [x] Refactor the existing 7 detectors to emit `Claim`s (behavior-preserving).
- [x] Replace `scoreConfidence()` with the evidence-combination model (§4).
- [x] Convert `registry.ts`'s switch into 3 seed **recipes as data** (react, express,
      django) behind a `RecipeRegistry.match()` — proving decision #1 with zero
      capability change. Existing tests must stay green (115 when this was
      written; 410 today).
- **Exit criterion (met):** the three current stacks run identically, but now through the
  generic engine. Pure refactor, fully covered by the existing hermetic suite.

### Phase B — Widen deterministic detection (brief's Phase 1 + 2)

_Now that adding a stack = adding data, not editing enums._

- [x] Open the taxonomy (`Runtime`, `PackageManager` become open strings + a known-set).
- [x] Add manifest detectors + recipes per ecosystem, in ROI order:
      **Node ecosystem** (Next/Vite/Nest/Angular/monorepos via `turbo.json`/`nx.json`/
      `pnpm-workspace.yaml`) → **Python** (FastAPI/Flask/Poetry/uv) → **Go** → **Rust**
      → **Java** (Maven/Gradle/Spring) → **C#/PHP/Ruby**.
- [x] Each ecosystem ships with: a manifest detector, ≥1 recipe, a golden-file test,
      and an example repo under `examples/`.
- **Exit criterion (met):** deterministic-only coverage of the listed frameworks, each with
  a passing golden test. No AI required for these. 19 recipes ship today.

### Phase C — Repository & CI analysis (brief's Phase 3 + 4)

_The tier-1/tier-2 signals that dramatically raise confidence and fill command gaps._

- [x] Repository-analysis detectors: `Makefile`, `Taskfile.yml`, `justfile`, package
      scripts, existing `Dockerfile`(s), shell scripts, README build sections.
- [x] CI parsers: `.github/workflows/*` (`detect/ci.ts`), plus `.gitlab-ci.yml`,
      `azure-pipelines.yml`, and `.circleci/config.yml` feeding `insights.ciProviders` as
      structured stages/jobs. Build/test/start commands and (for GitHub Actions) `setup-*`
      runtime versions are recovered. Env-var-name extraction is still not implemented, and
      the non-GitHub parsers have known depth gaps — see §10 and CONTRIBUTING.
- [x] Wire cross-tier agreement into confidence (§4).
- **Exit criterion (met):** for a repo with a Makefile, a CI config, or a README build
  block, ORCA now _prefers_ the repo's own declared commands over the matched recipe's
  defaults, and the plan node cites the file each command came from
  (`ServiceSource.commandOrigins`). Precedence is explicit in `applyRecoveredBuild`: a
  Dockerfile-derived recipe is never overridden (tier 1 outranks tier 2), build/start
  commands are replaced, install commands are only filled in, and a recovered image fills
  only a blank base image.

### Phase D — AI inference as the gap-filler (brief's Phase 5)

_Only runs when the ladder above leaves the recipe incomplete/low-confidence._

- [x] A `synthesizeRecipe` AI task: given the repo tree + manifests + README + CI +
      the partial `RepoModel`, propose the missing recipe fields.
- [x] Reuse the existing router/schema machinery (`ai/router.ts`, `ai/schema.ts`) —
      every field zod-validated, confidence-capped (§4), shown with reasoning.
- [x] Extend the existing `ai/fillTemplate.ts` pattern; do not build a parallel AI stack.
- **Exit criterion (met, with a caveat):** a repo that matches no recipe still produces a
  reviewable plan built from the inferred recipe, logged as AI-inferred with its reasoning.
  The human can approve or reject it; _correcting_ it at the gate is not supported.

### Phase E — Generic Docker synthesis (brief's Phase 7)

_Dockerfiles generated from the recipe, not from `.hbs` templates keyed on framework._

- [x] A synthesizer that turns a `BuildRecipe` into a multi-stage Dockerfile
      (builder stage → slim runtime stage copying `artifacts`), inferring base image,
      package-manager install, system packages, ports, and a healthcheck.
- [x] Keep the handful of hand-tuned `.hbs` templates only where a recipe explicitly
      references one; default path is synthesis.
- **Exit criterion (met):** the Go/Rust/Java recipes from Phase B produce working multi-stage
  images with no per-framework template file, pinned byte-for-byte by
  `tests/examples/ecosystem-golden.test.ts`.

### Phase F — Recipe-aware self-healing (brief's Phase 8)

- [x] Extend the existing `selfHeal.ts` loop to be recipe-aware: failures feed back as
      recipe corrections (wrong install cmd, missing system package, wrong port),
      and successful fixes are recorded as **learned recipe overrides** keyed by repo
      signature, so the next run starts from the healed recipe.
- **Exit criterion (met):** a build that fails on a missing `libpq-dev` self-corrects and
  the correction persists for that repo shape (`healStore.ts` + `repoSignature.ts`).

### Phase G — Dynamic probing (brief's Phase 6) — SEAMS ONLY, then STOP

_Per decision #2: design the interface, do not build execution now._

- [x] Define the `Prober` interface and its `Claim<T>` outputs (observed ports,
      processes, logs, artifacts) so tier-4 has a home on the ladder. — landed in
      `src/model/prober.ts` (`Prober`, `ProbeContext`, `ProbeObservation`), mirroring the
      `Detector` seam. No shipped prober, no runner: seam only.
- [x] Document the security model that a future build must satisfy: untrusted code runs
      **only** inside a network-isolated, resource-capped, ephemeral container; never on
      host; behind an explicit opt-in flag; with the same approve-before-run gate. —
      written as the SECURITY CONTRACT block in `prober.ts`, with two of its halves pinned
      by code: `tier: 4` and "`enabled === false` ⇒ no claims" (`tests/model/prober.test.ts`).
- **Exit criterion (met):** the ladder has a tier-4 slot and a written security contract.
  No arbitrary execution ships. Revisit build/no-build as a separate decision later.

---

## 6. Design requirements — how each is satisfied

| Brief requirement                         | Where it's met                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- |
| 1. Modular plugin architecture            | `Detector`/`Prober` interfaces + registry list (§3)                   |
| 2. Each detector independently extensible | detectors are pure `(ctx) → Claim[]`, registered, unit-testable (§3)  |
| 3. Confidence scoring                     | evidence-combination model, computed not guessed (§4)                 |
| 4. Deterministic-first                    | tiered ladder; tiers 1–2 always run before AI (§3)                    |
| 5. AI is fallback, not primary            | AI runs only on confidence gaps; claims capped ≤0.7 (§4, Phase D)     |
| 6. All actions explainable                | `Evidence[]` on every claim; recipe shown at approval gate (§2.2, §4) |
| 7. Every inference includes reasoning     | `reasoning[] = evidence.map(e => e.signal)`; never empty (§4)         |

---

## 7. Risks & the honest caveats

- **Scope is genuinely multi-month.** Phases A–G are ~a quarter-plus of focused work.
  Phase A alone (the foundation refactor) is the highest-leverage, lowest-risk start
  and is where I'd begin.
- **"Overwhelming majority of GitHub" is aspirational.** Realistically A–E gets the
  common web/service/CLI repos. The long tail (native builds needing exotic toolchains,
  GPU/ML images, monorepos with 20 services) stays hard and may always need probing or
  human input. The graded-confidence model (§4) is what keeps ORCA _honest_ about that
  rather than silently wrong.
- **AI cost & latency.** Tier-3 is deliberately last so most repos never pay for it.
  The existing cost-cap/ledger machinery already bounds this.
- **Probing security is a real gate, not a footnote.** Running untrusted repo code is
  the single most dangerous capability in the whole vision; deferring its _build_ (not
  just its design) is a safety decision, not only a scheduling one.

---

## 8. Recommended first step

**Phase A, the foundation refactor** — introduce `Claim`/`Evidence`/`Detector`, port the
existing detectors onto it, and re-express the three current stacks as data recipes,
all behind the then-115-test suite so nothing regresses. It changes no user-visible
behavior, but it converts "add a framework = edit closed enums + a switch" into "add a
framework = add a detector + a recipe," which is the unlock for every later phase.

I can start Phase A on request — it's a well-bounded, test-guarded refactor.

---

## 9. Implementation log & known follow-ups

Landed on `feat/universal-understanding` (behind the full test suite):

- **Phase A** — `Claim`/`Evidence`/`Detector` model, `RecipeRegistry` with the three
  seed stacks as data, confidence reworked onto evidence-combination with a reasoning
  trail on `DetectionResult`.
- **Phase B** — tier-1 runtime detectors (Go/Rust/JVM/.NET), ecosystem `BuildRecipe`s,
  the `Language` union widened to 9 ecosystems, a data-driven framework signature table
  (Next/Vite/Nest/FastAPI/Flask/Gin/Spring/Blazor/…), non-JS/Py manifest dependency
  readers, and monorepo topology detection.
- **Phase C** — GitHub Actions CI analysis (recovered build/test/start commands +
  pinned runtime versions), wired into `DetectionResult.insights` and the confidence
  trail (CI corroboration reinforces an already-detected stack, never manufactures it).
- **Phase 3 (repo understanding)** — task recovery from Makefile / Taskfile / justfile /
  package scripts, classified by intent and folded into `insights.taskCommands`.
- **Explainability wiring** — the reasoning trail and all `insights` signals (frameworks,
  runtimes, monorepo tooling, CI commands/versions, maintainer tasks) are logged by the
  pipeline on every run, so ORCA's understanding of a repo is visible to the user and to
  the VS Code OutputChannel.
- **Phase 5 (AI-assisted inference)** — a tier-3 `inferBuild` fallback over the existing
  router (Qwen→Claude, cost-capped, ledgered): it proposes a runtime + build/run commands
  for an under-determined repo, schema-validated and wrapped as an `ai`-sourced `Claim`
  whose confidence is mechanically capped below determinism. Wired into the pipeline as a
  diagnostic on the unsupported-stack path — when a key is present, ORCA logs a graded
  "here's what I think this is and how it'd build, with reasoning" before the hard stop,
  delivering the "honest about uncertainty" promise. (Driving a real build from an
  inferred recipe is Phase E — the generic Dockerfile synthesizer.)

- **Phase E (generic Dockerfile synthesis)** — `synthesizeDockerfile(recipe)` turns any
  `BuildRecipe` (registry-matched or AI-inferred) into an actual Dockerfile: multi-stage
  (builder → slim runtime) for compiled runtimes, single-stage for interpreted ones, with
  system-package blocks, `EXPOSE`, and `{{binary}}`/`{{jar}}`/`{{dll}}` placeholder
  resolution. The seed stacks keep their handwritten Handlebars templates; everything else
  flows through here. Verified end-to-end producing idiomatic Rust and Go (distroless)
  images.

- **Open-role containerization (landed)** — ecosystem components now flow end-to-end:
  detection surfaces them (`insights.ecosystemComponents`: root + matched recipe id),
  `buildServicePlan` places them as open `'service'` nodes (`ServiceKind` widened; the
  build source carries a `recipeId`), and both `writeConfigs` and the dry-run preview
  synthesize their multi-stage Dockerfiles via the `dockerfileFor` recipe branch. A repo
  with a matched ecosystem recipe is now `isSupported`, so e.g. a Rust or Go repo
  containerizes without a seed frontend/backend. Verified end-to-end through `runPipeline`
  on the Rust fixture (dry-run preview shows the synthesized cargo multi-stage image).

- **Inline recipes + AI-inferred build path (landed)** — the plan node now carries its
  `BuildRecipe` inline on the build source (not by id lookup), so AI-inferred `ai-*`
  recipes — which never live in the shipped registry — synthesize identically to shipped
  ones. `runPipeline` promotes a tier-3 inference on a deterministically-unsupported repo
  into an open `'service'` node instead of hard-stopping: a repo with no matched recipe
  but a confident AI understanding now containerizes. The synthesizer fills blank base
  images (the shape `inferBuild` returns) from a per-runtime default table, so an inferred
  recipe never emits a bare `FROM`. Verified end-to-end through `runPipeline` (unknown
  fixture + injected AI facade → synthesized cargo image in the preview).

- **Ecosystem DB/service wiring (landed)** — a detected database is a repo-wide
  dependency, so each ecosystem `'service'` node now receives the same connection env and
  health-gated `depends_on` a seed backend would (`connectionEnv` + `dbDeps` applied in
  `buildServicePlan`). No database → the service stays unwired (empty env, no deps).

- **Recipe-aware self-healing (Phase F, landed — full)** — the self-heal loop already heals
  any ORCA-generated file, so a synthesized ecosystem/inferred Dockerfile is in scope for
  free. On top of that, `buildHealPrompt` now receives each synthesized service's recipe
  context (runtime + intended install/build/start commands) so a fix stays faithful to the
  runtime and never silently switches, say, a Rust service to Node. Seed-stack (template)
  runs pass no recipe context, so their heal prompt is unchanged. **Persistence closed the
  exit criterion:** `healStore.ts` writes each successful fix as a learned override keyed by
  repo signature (`repoSignature.ts`) under `~/.orca`, and the pipeline replays it on the
  next run (lookup → apply → evict-on-failure → save-on-success), so a missing-`libpq-dev`
  correction survives across runs for that repo shape.

  Concretely, the persistence layer is: a single `heal-overrides.json` under ORCA's home
  dir — `$ORCA_HOME` when set, else `~/.orca` — keyed by `signatureFor(repoId)`, where
  `normalizeRepoId` canonicalizes the repo URL so the same repo cloned over SSH or HTTPS
  shares one entry. Each record carries a `recipeFingerprint` (`repoShapeFrom` +
  `recipeFingerprint`); on lookup the pipeline compares it against the freshly-detected
  shape and **evicts rather than applies** when it has drifted, so a repo that changed its
  stack starts clean instead of replaying a stale fix. An override that is applied and
  still fails to produce a healthy stack is also evicted.

- **Dynamic-probing seam (Phase G, landed — seam only)** — the tier-4 `Prober` contract
  (`src/model/prober.ts`) gives probing a home on the ladder: `Prober`/`ProbeContext`/
  `ProbeObservation` mirror the `Detector` seam and emit ordinary evidence-backed
  `Claim<ProbeObservation>`s. The security contract (isolation, opt-in, approve-before-run,
  ephemerality, explainability) is written into the file, with two halves code-enforced
  (`tier: 4`; a disabled context yields no claims). No prober implementation and no runner
  ship — per decision #2 this is the interface, not execution.

- **README / shell-script parsing (landed, Phase 3 / tier 1)** — `detect/readme.ts` and
  `detect/shellScript.ts` recover build/run commands and advertised ports from the two
  places a maintainer states them in plain sight: fenced shell blocks in `README.md`, and
  the repo's own `start.sh` / `run.sh` / `dev.sh` / `scripts/*.sh` / `bin/*.sh`. Both share
  one extraction core and reuse `ci.ts`'s `classifyCommand`, supplemented locally for the
  run-shaped forms that classifier has no keyword for (`python app.py`, `docker run`,
  `docker-compose up`, `go run`, `rails server`) — `classifyCommand` itself is untouched so
  commands already recovered from CI, Dockerfiles, and task runners are unaffected.
  Results land in `insights.scriptSources`.

  The parser is **conservative by construction**: a line survives only if its leading token
  is on a known-tool allowlist AND an intent can be classified: `git clone`, `cd`, `export`,
  `curl`, `sudo` and friends are dropped, non-shell fenced blocks (`json`, `js`, `toml`,
  `yaml`) are rejected wholesale including any ports inside them, and prose is never parsed.
  A README that states nothing parseable yields nothing — that repo is left to tier-3 rather
  than guessed at, which `tests/fixtures/readme-ambiguous-repo` pins as a false-positive
  guard. This source is also strictly **gap-filling**: it contributes confidence only when
  no Dockerfile and no CI already spoke, and it can never make an unsupported repo
  supported.

- **Build recovery (landed, Phase C)** — `detect/buildRecovery.ts` is the consumer the
  recovered-command fields never had. `ciCommands`, `ciProviders`, `taskCommands`, and
  `scriptSources` were all previously read only by `logInsights`; they are now normalized
  into ranked `RecoveredCommand`s that retain their ORIGIN, combined into an
  evidence-backed `Claim` on `insights.recoveredBuild`, and overlaid onto the matched
  recipe by the pipeline. The plan node carries `commandOrigins`, so a build command can
  be traced back to `gitlab:.gitlab-ci.yml#compile` or `makefile:build`.

  CI providers are handled as DATA: `ciProviders` is walked uniformly and the `provider`
  field is a label inside the provenance string, never a branch — a fifth provider needs
  a parser and no change here. Ranking is `ci` > `task` > `script`, reusing the weights
  those families already carry in the confidence model.

- **CircleCI workflow ordering (landed)** — `circleci.ts` parsed `jobs:` but ignored
  `workflows:`, so `stages` was always `[]` and every `requires:` edge was lost.
  `workflows:` is CircleCI's analog of GitLab stages, except it expresses order as a DAG
  rather than a list, so `stages` now carries the recovered execution order as
  `<workflow>:<job>` entries — qualified by workflow so a config with several workflows
  stays several sequences instead of one merged list. Each job also reports the workflow
  that runs it in `stage`, which was previously hardcoded `null`.

  Ordering implements CircleCI's OWN rule rather than a heuristic: a job with no
  `requires:` starts immediately, in parallel with every other unblocked job — it does not
  implicitly wait for the jobs declared above it. Declaration order only breaks ties within
  a level. A `requires:` naming a job outside the workflow is ignored, and a cyclic graph
  (which CircleCI itself rejects) appends its unresolved remainder rather than dropping
  jobs. Orb jobs that never appear under `jobs:` are still recorded in the order.

- **README-sourced ports (landed)** — `DetectedPort.source` had declared `'readme'` since
  the type was written without any detector emitting it; README ports existed only inside
  `insights.scriptSources`, with no port-level record of origin. `detectPorts` now reads a
  component's own README (`-p 8080:8080`, `--port`, `PORT=`, a pasted `EXPOSE`, or a
  `localhost:` URL) and emits real `DetectedPort`s carrying that provenance, which the
  reasoning trail reports as "backend port 8080 read from the README".

  It reuses the existing merge rather than adding a parallel list: README is simply the
  LAST source `declaredPorts` consults, so `add()`'s first-claimant rule means a port a
  Dockerfile `EXPOSE` or the source code also declares keeps its stronger origin — no
  precedence rule was needed. Known service ports are filtered exactly as `portsFromCode`
  filters them, so a README documenting `docker run -p 5432:5432 postgres` describes the
  app's dependency without publishing the app on 5432.

- **Component-role widening (landed, §2.3)** — `ComponentRole` now carries
  `worker | cli | library | job` alongside the original three, with `worker` and `cli`
  detected deterministically and `library`/`job` left as vocabulary. See §2.3 for the
  detection rules, the "does it listen?" master gate, and the port consequences.

Since then, the deterministic surface widened further: **19 recipes** across Node
(react/express/next/nest/angular/vite), Python (django/fastapi/flask × uv/poetry/pip),
PHP (composer/laravel), Ruby (bundler/rails/sinatra), Go, Rust, JVM (maven/gradle) and
.NET; existing-Dockerfile detection; the `PackageManager` taxonomy opened to a string +
known-set (mirroring `Runtime`); and runnable **ecosystem example repos** under
`examples/` (go/rust/jvm/dotnet) pinned by synthesizer golden tests.

Note on the Node recipes: `node-next` runs the maintainer's own `npm run build` /
`npm run start` and publishes **3000**, matching what `next start` actually binds — the
Next.js port correction. `node-vite` is registered last among the Node entries so a
React + Vite repo still resolves to `node-react`, while Vue/Svelte/Solid/vanilla Vite
repos get a recipe instead of nothing.

Remaining toward "build any repo": a probing _implementation_ (deferred by decision #2 —
the seam exists, execution is a separate later call), and per-ecosystem entrypoint scripts
(e.g. a JVM/.NET migrate-then-run analogue to the Django entrypoint) — deferred until a
recipe actually needs one, to avoid unused machinery.

Test coverage across these: **410 tests** (407 passing + 3 skipped) across 54 files — was
115 at the start of the branch — all hermetic (temp-dir fixtures, injected AI facade, no
network, no Docker, no VS Code).

Known follow-ups surfaced during integration:

- **Monorepo package globs → candidate roots (resolved).** `expandWorkspaceGlobs` now
  promotes workspace globs like `services/*` to candidate roots, so a package two levels
  deep is detected.
- **Ecosystem components are containerized (resolved, Phase E).** Go/Rust/JVM/.NET and
  AI-inferred stacks flow through the generic multi-stage synthesizer end-to-end
  (detection → plan → generate/preview → self-heal). See the landed entries above.
- **Ecosystem example repos (resolved, Phase B3).** `examples/{go,rust,jvm-maven,dotnet}-sample`
  are runnable and pinned by `tests/examples/ecosystem-golden.test.ts`, which asserts each
  synthesized Dockerfile byte-for-byte.
- **`PackageManager` opened (resolved).** Now a known-set + open string in
  `templates/types.ts`, mirroring `Runtime`; detection layers `'unknown'` on top.
- **`cli` role was initially unreachable (resolved during §2.3).** Node roots never become
  ecosystem components, so a `bin` package would have carried a role nothing ever read.
  Role detection therefore also runs on the Dockerfile-derived path in
  `ecosystemComponentsFrom`, which is the route such a repo actually takes.

---

## 10. Still open — what this document describes but the code does not do

Collected here so §1–§8 can stay as the original design argument while remaining honest
about the gap. Nothing below is implemented on this branch.

| #   | Gap                                                                                                                                                                                                                                                                                                                                           | Where the doc claims it   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | ~~**Multi-provider CI.**~~ **RESOLVED.** GitLab CI, Azure Pipelines, and CircleCI are parsed into `insights.ciProviders` and consumed by build recovery. Depth gaps remain (CircleCI `workflows`, reusable `commands`, `include:` expansion) — tracked in CONTRIBUTING.                                                                       | §5 Phase C                |
| 2   | **Graded `{ recipe, tier }` outcome.** `isSupported: boolean` is still the contract; the review gate shows no confidence tier.                                                                                                                                                                                                                | §4                        |
| 3   | **A real confidence gate.** Tier-3 escalation triggers on `!isSupported`, not on a threshold or on recipe-field completeness — a placed-but-poorly-understood repo never escalates.                                                                                                                                                           | §3, §5 Phase D            |
| 4   | ~~**Recovered commands don't drive the build.**~~ **RESOLVED.** `detect/buildRecovery.ts` folds CI (GitHub Actions + every `ciProviders` entry), task runners, and README/scripts into a ranked `Claim` on `insights.recoveredBuild`; the pipeline overlays it onto the matched recipe and the plan node carries `commandOrigins` provenance. | §5 Phase C exit criterion |
| 5   | **`AI claims capped ≤0.7`** is asserted as a mechanism but is not enforced by a shared, tested cap in `claim.ts`.                                                                                                                                                                                                                             | §4, §6 row 5              |
| 6   | **Correcting an AI-inferred plan at the gate.** The reviewer can approve or reject, not edit.                                                                                                                                                                                                                                                 | §5 Phase D exit criterion |
| 7   | **`cli`/`job` as one-shot services.** They become ordinary portless `'service'` nodes; there is no `restart: no` / "runnable, not long-lived" affordance.                                                                                                                                                                                     | §2.3                      |
| 8   | **`library` and `job` detection.** Vocabulary only, deliberately — see §2.3.                                                                                                                                                                                                                                                                  | §2.3                      |
| 9   | **Probing implementation.** Seam only, by decision #2. This one is a _choice_, not a gap.                                                                                                                                                                                                                                                     | §5 Phase G                |

`DetectedPort.source`'s remaining unused member is `'inferred'` — no detector emits it,
since nothing currently infers a port without a declaring source. `'readme'` is now live.

Two things the doc names that are **partly** true and worth stating precisely:

- **PHP framework coverage.** `php-laravel` and `php-composer` ship as recipes. There is
  **no `php-symfony` recipe** — Symfony exists only as a row in the framework _signature_
  table (`detect/frameworkSignatures.ts`), so a Symfony repo is identified but builds
  through the generic `php-composer` recipe.
- **`FrontendFramework`/`BackendFramework` are still closed unions.** They no longer gate
  what ORCA can build, but they do still gate what the seed frontend/backend detector will
  place, which is why a Node CLI or a Vue app reaches the plan through the ecosystem/
  Dockerfile paths rather than as a first-class component.
