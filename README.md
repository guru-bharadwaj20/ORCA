# ORCA

**Orchestrated Repository Comprehension Agent** — an AI CLI that takes a messy
student or hackathon repository and gets it running in Docker. It clones the repo,
detects the stack, generates Docker + Compose configs, shows you the planned service
graph **for approval before anything runs**, then builds and starts the containers
with a self-healing retry loop that explains each fix in plain English.

Published as **`orca-agent-cli`** on npm (the `orca` and `orca-cli` names were taken);
the installed binary is `orca`. A companion [VS Code extension](vscode-extension/)
wraps the same engine in the editor.

## Why

Student and hackathon repos are notoriously hard to run: missing Dockerfiles,
undocumented env vars, wrong ports, "works on my machine." ORCA is deliberately
**narrow** — it targets a small set of common stacks rather than trying to
containerize anything — so it can be opinionated and actually get them running.

## Highlights

- **Approve before build.** ORCA renders the planned service graph as a Mermaid
  diagram and a service table, and gates on your approval. Nothing is built, run, or
  written to disk until you say go.
- **Explainable self-heal.** When a build or start fails, ORCA asks the model to
  diagnose and patch, retries (up to `--max-heal-attempts`, default 3), and prints an
  attempt-by-attempt, plain-English log of what broke and how it was fixed.
- **Keyless-capable, bring-your-own-key.** AI refinement is optional — with no key,
  ORCA falls back to deterministic template defaults and the run still completes. Qwen3-Coder
  is the primary model; Claude is the automatic fallback.
- **Safe by construction.** The original repo is never modified (ORCA works in a temp
  workspace), and the self-heal loop may only patch files ORCA itself generated — an
  allowlist enforced in code, not in the prompt.

## Supported stacks

| Layer            | Supported                                                     |
| ---------------- | ------------------------------------------------------------- |
| Frontend         | Node / React (Vite dev server)                                |
| Backend          | Node / Express **or** Python / Django                         |
| Database         | Postgres **or** MongoDB (Redis detected as an optional cache) |
| Package managers | npm / yarn / pnpm · pip / poetry                              |

Anything outside this set is declined with a clear warning rather than guessed at.
See [`docs/supported-stacks.md`](docs/supported-stacks.md) for details.

## Where ORCA is heading — Universal Repository Understanding

The stacks above are the _deterministic-first_ core. The next evolution generalizes
ORCA from a three-framework template system into a **generic repository-understanding
engine**: give it any public repo, and it infers how to build, containerize, and run
it — from manifests, repo files, CI pipelines, and (as a fallback) AI inference, with
every inference carrying a confidence score and a reasoning trail.

The full architecture and phased roadmap live in
[`docs/universal-understanding-plan.md`](docs/universal-understanding-plan.md). The
foundation and deterministic-detection layers have landed: an open, evidence-based
detection model where **adding a framework is adding data, not editing an enum**.

| Concept                 | What it is                                                                             | Status                |
| ----------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| `Claim<T>` / `Evidence` | Every detected fact carries computed confidence + a traceable reasoning trail          | ✅ Landed             |
| `Detector` plugins      | Standalone `(ctx) → Claim[]` units, registered in a list, independently testable       | ✅ Landed             |
| `BuildRecipe`           | The generic build/run model; 3 seed stacks + Go/Rust/JVM/.NET re-expressed as **data** | ✅ Landed             |
| Deterministic detection | 9 languages, framework signatures, monorepo topology, non-JS/Py manifest readers       | ✅ Landed             |
| CI & repo understanding | GitHub Actions + Makefile/Taskfile/justfile/scripts recovered into `insights`          | ✅ Landed             |
| AI-assisted inference   | LLM fallback when deterministic tiers are thin, capped below determinism               | 📋 Next               |
| Dynamic probing         | Observe real runtime behavior in an isolated sandbox                                   | 📋 Designed, deferred |

> ORCA stays **honest about uncertainty**: an unfamiliar repo yields a graded,
> reviewable plan ("62% confident this is a Go/Gin service — here's why") rather than
> a silent guess or a hard rejection.

## Install

```bash
npm install -g orca-agent-cli
```

Until then, run straight from a checkout:

```bash
npm install && npm run build
```

## Usage

```bash
# Detect, plan, and preview the generated compose + Dockerfiles — nothing is built,
# run, or written to disk (no Docker, no API keys required):
orca run examples/mern-sample --dry-run

# Non-interactive (CI / scripting):
orca run <repo-url-or-path> --dry-run --auto-approve

# Full flow: build + start the stack with self-heal (needs Docker; a key to self-heal):
orca run <repo-url-or-path>
```

Running `orca` on its own in a terminal opens an interactive menu; the commands above
are always available directly. Logs go to stderr and the plan/preview to stdout, so
output stays pipeable. **Exit codes:** `0` success · `2` plan rejected at the gate ·
`1` anything else.

### Flags and configuration

| Flag                      | Effect                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`               | Plan and preview only; write and run nothing.                                                                                   |
| `--auto-approve`          | Skip the approval prompt (for CI).                                                                                              |
| `--model <id>`            | Model for the run — `claude-*` routes to Anthropic, `qwen*` to Qwen; unknown ids are ignored rather than sent to the wrong API. |
| `--cost-cap <usd>`        | Hard cap on total LLM spend for the run.                                                                                        |
| `--max-heal-attempts <n>` | Bound the self-heal loop (default 3).                                                                                           |

Precedence is **flag > `ORCA_*` env var > default**. AI keys are read from the
environment (never passed as flags):

```bash
export QWEN_API_KEY=sk-...           # primary — Qwen3-Coder via any OpenAI-compatible host
export ANTHROPIC_API_KEY=sk-ant-...  # fallback — Claude
```

See [`.env.example`](.env.example) for routing overrides.

## How it works

```
clone → detect → AI fill → plan → APPROVE → generate → build + self-heal
```

ORCA clones (or copies) the repo into a temporary workspace, runs static detectors to
identify the stack, and optionally refines the container templates with AI (degrading
to registry defaults if there's no key or the call fails). It assembles a service plan,
renders it for your approval, and only then writes the Dockerfiles, `.dockerignore`s,
Compose file, and — with a key — an explainable `.env` (each inferred variable annotated
with _why_). It runs `docker compose build` and `up -d --wait`; on failure it invokes
the allowlisted self-heal loop. On success the workspace and running stack are kept and
their path printed — stop it with `docker compose down`.

For the full design, see [`docs/architecture.md`](docs/architecture.md).

## VS Code extension

[`vscode-extension/`](vscode-extension/) (`orca-vscode`) is a thin editor front end over
the same core: an **ORCA: Preview Repo** dry run, an **ORCA: Run Repo** full flow with
per-phase progress and a cancel button, and a native webview that renders the approval
diagram and service table. Keys are stored in VS Code's encrypted secret storage, never
in `settings.json`. See its [README](vscode-extension/README.md) and
[RELEASING.md](vscode-extension/RELEASING.md).

## Development

```bash
npm install
npm run build        # tsc + copy templates into dist/
npm test             # vitest (hermetic — no keys, no Docker)
npm run lint         # eslint
npm run format       # prettier
npm run typecheck    # tsc --noEmit
```

- **ESM-only** TypeScript with `NodeNext` resolution; intra-project imports use explicit
  `.js` extensions.
- **npm-workspaces monorepo**: the root package is the publishable `orca-cli`;
  `vscode-extension/` is a private workspace member that consumes the core through its
  subpath exports (`orca-cli`, `/plan`, `/config`, `/ai`) rather than reimplementing it.
- The bundled samples are real and runnable with Docker — see
  [`examples/README.md`](examples/README.md):

  ```bash
  cd examples/mern-sample            && docker compose up --build   # React + Express + MongoDB
  cd examples/django-postgres-sample && docker compose up --build   # Django + Postgres
  ```

## Project layout

```
src/
├── detect/       static, AI-free stack detection
├── templates/    Handlebars Dockerfile/Compose templates + registry
├── ai/           multi-provider router (Qwen primary, Claude fallback), BYOK
├── plan/         service plan, Mermaid diagram, approval gate
├── generate/     writes configs + explainable .env into the workspace
├── build/        docker build/run + the explainable self-heal loop
├── clone/        temp-workspace clone/copy + cleanup
├── core/         RunContext + runPipeline (the embeddable engine)
├── cli/          the `orca` binary, interactive menu, output rendering
└── config/       ORCA_* settings parsing + validation

examples/         runnable sample apps + golden reference configs
tests/            vitest suites (nothing mocked beyond the Docker/AI boundaries)
vscode-extension/ the VS Code front end (workspace member)
docs/             architecture, supported stacks, demo
```

## Security

The self-heal patch allowlist, the untouched-original-repo guarantee, the BYOK model,
and the approval gate are documented in [`SECURITY.md`](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
