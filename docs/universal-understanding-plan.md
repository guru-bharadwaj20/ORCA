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
  though today it's a single hardcoded heuristic in `index.ts`.
- **AI already only refines, never originates.** `registry.ts` produces deterministic
  default `DockerfileVars`; the AI layer (`ai/fillTemplate.ts`) overrides fields on
  top. This is exactly the "AI as fallback" philosophy — it just needs generalizing.
- **The `ServicePlan` contract** (`src/plan/types.ts`) is already a clean,
  compose-shaped IR that the diagram, review gate, config writer, and build loop all
  read. It is a good target for a generic synthesizer to emit into.

What blocks the vision (the real constraints, with file references):

- **Closed union types.** `src/detect/types.ts` hardcodes the entire supported world:
  `Language = 'javascript'|'typescript'|'python'|'unknown'`,
  `FrontendFramework = 'react'|'unknown'`,
  `BackendFramework = 'express'|'django'|'unknown'`. Every new ecosystem today means
  editing these unions — the opposite of extensible.
- **Roles are hardcoded to frontend/backend/database.** `detect/index.ts` and the
  pipeline's `COMPONENT_ROLES` assume a web-app shape. A Rust CLI, a Go worker, or a
  Java batch job has no "frontend"; the model can't represent them.
- **`registry.ts` is a `switch` statement**, not data. `selectDockerfileTemplate`,
  `installCommandFor`, `startCommandFor`, `defaultPortFor` are all hardcoded control
  flow over the closed enums.
- **Detection is single-pass and static-only.** There is no notion of CI parsing,
  README understanding as a _detection source_, or an inference ladder that escalates
  when deterministic signals run out.
- **`isSupported: boolean` is binary.** The pipeline hard-throws `UnsupportedStackError`
  when false. There's no "I'm 60% sure this is a Go/Gin service, here's my reasoning,
  approve to proceed" middle ground — which is the entire point of universal support.

---

## 2. The core architectural shift

### 2.1 From closed enums to an open, evidence-based model

Replace the closed unions with an **open taxonomy** plus a uniform evidence record.
The key type every detector produces and every later stage consumes:

```ts
/** One piece of evidence for a claim, so every inference is explainable. */
interface Evidence {
  detector: string;           // "manifest:cargo", "ci:github-actions", "ai:inference"
  signal: string;             // human-readable: "Cargo.toml present", "CI runs `cargo build`"
  weight: number;             // contribution to confidence, 0..1
}

/** A scored claim about the repo. Detectors emit these; the aggregator ranks them. */
interface Claim<T> {
  value: T;
  confidence: number;         // 0..1, derived from evidence (see §4)
  evidence: Evidence[];       // the reasoning trail — never empty
  source: 'deterministic' | 'ci' | 'ai' | 'probe';  // which tier produced it
}
```

`runtime`, `framework`, `packageManager`, `ports`, `buildCommand`, `startCommand`
all become `Claim<T>` (or `Claim<T>[]` when ranked). The example JSON from the brief
falls straight out of this:

```json
{ "runtime": "rust", "confidence": 0.92,
  "reasoning": ["Cargo.toml detected", "Binary crate present", "CI executes cargo build"] }
```

That object is just `Claim<Runtime>` with `evidence[].signal` projected to strings.

### 2.2 The BuildRecipe: the generic build model (Phase 2, the linchpin)

The abstraction that replaces `registry.ts`'s switch. A **recipe** is _data_, not code:

```ts
interface BuildRecipe {
  id: string;                       // "node-vite", "rust-cargo", "python-fastapi"
  runtime: Runtime;                 // open string, e.g. "node" | "python" | "rust" | "go" | "jvm" | ...
  packageManager?: PackageManager;
  installCommands: string[];        // ["cargo fetch"] or ["npm ci"]
  buildCommands: string[];          // ["cargo build --release"]
  startCommand: string;             // "./target/release/{{binary}}" (templated)
  artifacts?: string[];             // produced files a runtime stage copies (multi-stage builds)
  defaultPorts: number[];
  baseImages: { build: string; runtime: string };  // multi-stage: builder + slim runtime
  needsSystemPackages?: string[];   // apt deps (libpq-dev, etc.)
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

### 2.3 Component roles become open

`ComponentRole` widens beyond `frontend|backend|database`. A component is
`{ rootDir, runtime, recipe: Claim<BuildRecipe>, role: ComponentRole }` where role
grows to include `service | worker | cli | library | job`. The `ServicePlan`
synthesizer maps these onto compose services (a `cli`/`job` becomes a one-shot
service or is surfaced as "runnable but not a long-lived service").

---

## 3. Target architecture (the inference ladder)

The brief's target pipeline, mapped onto ORCA's stages. The spine is an **escalating
ladder**: each rung runs only when the rungs above leave confidence below a threshold.
Deterministic-first means the cheap, certain tiers always run first and AI/probe only
fill the gaps.

```
Clone
  ↓
Manifest Detection      ── deterministic, tier 1  (Phase 1)  — always runs
  ↓
Repository Analysis     ── deterministic, tier 1  (Phase 3)  — README/Makefile/justfile/scripts
  ↓
CI Analysis             ── deterministic, tier 2  (Phase 4)  — often the ground truth for commands
  ↓
────────── confidence gate: is the recipe complete & above threshold? ──────────
  ↓ (only if gaps remain)
AI Inference            ── fallback, tier 3       (Phase 5)  — proposes claims, schema-validated
  ↓
[Dynamic Probing]       ── tier 4, DESIGNED, DEFERRED (Phase 6) — seam only, not built now
  ↓
Docker Synthesis        ── generic, recipe-driven (Phase 7)
  ↓
Build → Observe → Self-Heal (Phase 8, recipe-aware)
  ↓
Final Plan (already exists as ServicePlan + review gate)
```

Every rung writes `Claim`s into a shared `RepoModel`; it never mutates another
detector's output. The aggregator (§4) merges and ranks. This is the plugin
architecture the brief asks for: **a detector is a function `(RepoContext) → Claim[]`**,
registered in a list, independently testable, independently extensible.

```ts
interface Detector {
  id: string;
  tier: 1 | 2 | 3 | 4;                        // ladder rung
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

---

## 5. Phased roadmap

Sequenced by dependency, not by the brief's numbering. Each phase is independently
shippable and leaves the product working.

### Phase A — Foundation refactor (no new ecosystems yet)
_The enabling work everything else depends on._
- [ ] Introduce `Claim<T>` / `Evidence` / `Detector` contracts in a new `src/model/`.
- [ ] Refactor the existing 7 detectors to emit `Claim`s (behavior-preserving).
- [ ] Replace `scoreConfidence()` with the evidence-combination model (§4).
- [ ] Convert `registry.ts`'s switch into 3 seed **recipes as data** (react, express,
      django) behind a `RecipeRegistry.match()` — proving decision #1 with zero
      capability change. Existing 115 tests must stay green.
- **Exit criterion:** the three current stacks run identically, but now through the
  generic engine. Pure refactor, fully covered by the existing hermetic suite.

### Phase B — Widen deterministic detection (brief's Phase 1 + 2)
_Now that adding a stack = adding data, not editing enums._
- [ ] Open the taxonomy (`Runtime`, `PackageManager` become open strings + a known-set).
- [ ] Add manifest detectors + recipes per ecosystem, in ROI order:
      **Node ecosystem** (Next/Vite/Nest/Angular/monorepos via `turbo.json`/`nx.json`/
      `pnpm-workspace.yaml`) → **Python** (FastAPI/Flask/Poetry/uv) → **Go** → **Rust**
      → **Java** (Maven/Gradle/Spring) → **C#/PHP/Ruby**.
- [ ] Each ecosystem ships with: a manifest detector, ≥1 recipe, a golden-file test,
      and an example repo under `examples/`.
- **Exit criterion:** deterministic-only coverage of the listed frameworks, each with
  a passing golden test. No AI required for these.

### Phase C — Repository & CI analysis (brief's Phase 3 + 4)
_The tier-1/tier-2 signals that dramatically raise confidence and fill command gaps._
- [ ] Repository-analysis detectors: `Makefile`, `Taskfile.yml`, `justfile`, package
      scripts, existing `Dockerfile`(s), shell scripts, README build sections.
- [ ] CI parsers: `.github/workflows/*`, `.gitlab-ci.yml`, `azure-pipelines.yml`,
      `circle.yml`. Extract build/test/start commands, runtime versions, env var names.
- [ ] Wire cross-tier agreement into confidence (§4).
- **Exit criterion:** for a repo with a Makefile or CI, ORCA prefers the repo's own
  declared commands over recipe defaults, with evidence citing the source file.

### Phase D — AI inference as the gap-filler (brief's Phase 5)
_Only runs when the ladder above leaves the recipe incomplete/low-confidence._
- [ ] A `synthesizeRecipe` AI task: given the repo tree + manifests + README + CI +
      the partial `RepoModel`, propose the missing recipe fields.
- [ ] Reuse the existing router/schema machinery (`ai/router.ts`, `ai/schema.ts`) —
      every field zod-validated, confidence-capped (§4), shown with reasoning.
- [ ] Extend the existing `ai/fillTemplate.ts` pattern; do not build a parallel AI stack.
- **Exit criterion:** a repo that matches no recipe still produces a reviewable plan,
  clearly labelled as AI-inferred, that a human can approve or correct.

### Phase E — Generic Docker synthesis (brief's Phase 7)
_Dockerfiles generated from the recipe, not from `.hbs` templates keyed on framework._
- [ ] A synthesizer that turns a `BuildRecipe` into a multi-stage Dockerfile
      (builder stage → slim runtime stage copying `artifacts`), inferring base image,
      package-manager install, system packages, ports, and a healthcheck.
- [ ] Keep the handful of hand-tuned `.hbs` templates only where a recipe explicitly
      references one; default path is synthesis.
- **Exit criterion:** the Go/Rust/Java recipes from Phase B produce working multi-stage
      images with no per-framework template file.

### Phase F — Recipe-aware self-healing (brief's Phase 8)
- [ ] Extend the existing `selfHeal.ts` loop to be recipe-aware: failures feed back as
      recipe corrections (wrong install cmd, missing system package, wrong port),
      and successful fixes are recorded as **learned recipe overrides** keyed by repo
      signature, so the next run starts from the healed recipe.
- **Exit criterion:** a build that fails on a missing `libpq-dev` self-corrects and the
      correction persists for that repo shape.

### Phase G — Dynamic probing (brief's Phase 6) — SEAMS ONLY, then STOP
_Per decision #2: design the interface, do not build execution now._
- [ ] Define the `Prober` interface and its `Claim<T>` outputs (observed ports,
      processes, logs, artifacts) so tier-4 has a home on the ladder.
- [ ] Document the security model that a future build must satisfy: untrusted code runs
      **only** inside a network-isolated, resource-capped, ephemeral container; never on
      host; behind an explicit opt-in flag; with the same approve-before-run gate.
- **Exit criterion:** the ladder has a tier-4 slot and a written security contract. No
      arbitrary execution ships. Revisit build/no-build as a separate decision later.

---

## 6. Design requirements — how each is satisfied

| Brief requirement | Where it's met |
|---|---|
| 1. Modular plugin architecture | `Detector`/`Prober` interfaces + registry list (§3) |
| 2. Each detector independently extensible | detectors are pure `(ctx) → Claim[]`, registered, unit-testable (§3) |
| 3. Confidence scoring | evidence-combination model, computed not guessed (§4) |
| 4. Deterministic-first | tiered ladder; tiers 1–2 always run before AI (§3) |
| 5. AI is fallback, not primary | AI runs only on confidence gaps; claims capped ≤0.7 (§4, Phase D) |
| 6. All actions explainable | `Evidence[]` on every claim; recipe shown at approval gate (§2.2, §4) |
| 7. Every inference includes reasoning | `reasoning[] = evidence.map(e => e.signal)`; never empty (§4) |

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
all behind the existing 115-test suite so nothing regresses. It changes no user-visible
behavior, but it converts "add a framework = edit closed enums + a switch" into "add a
framework = add a detector + a recipe," which is the unlock for every later phase.

I can start Phase A on request — it's a well-bounded, test-guarded refactor.
```
