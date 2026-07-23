<h1 align="center">ORCA</h1>

<p align="center"><strong>Orchestrated Repository Comprehension Agent</strong><br>
An AI CLI that takes a messy student or hackathon repo and gets it running in Docker.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/orca-agent-cli"><img alt="npm" src="https://img.shields.io/npm/v/orca-agent-cli.svg"></a>
  <a href="https://github.com/VivianSobers/ORCA/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/VivianSobers/ORCA/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<p align="center">
  <img src="docs/CLI.png" alt="ORCA's interactive CLI menu" width="720">
</p>

Student and hackathon repos are notoriously hard to run: missing Dockerfiles,
undocumented env vars, wrong ports, "works on my machine." ORCA clones the repo,
detects the stack, generates Docker + Compose configs, shows you the planned service
graph **for approval before anything runs**, then builds and starts the containers with
a self-healing retry loop that explains each fix in plain English.

It is deliberately **narrow** — a small set of common stacks rather than anything at all
— so it can be opinionated and actually get them running.

## Highlights

- **Approve before build.** The planned service graph is rendered as a Mermaid diagram
  and a service table. Nothing is built, run, or written to disk until you say go.
- **Explainable self-heal.** On a failed build or start, ORCA diagnoses, patches, and
  retries — printing an attempt-by-attempt log of what broke and how it was fixed.
- **Keyless-capable, bring-your-own-key.** With no key, ORCA falls back to deterministic
  template defaults and the run still completes. Qwen3-Coder is primary, Claude the
  automatic fallback.
- **Safe by construction.** The original repo is never modified; the self-heal loop may
  only patch files ORCA itself generated; and AI-proposed build commands, base images and
  paths are validated against a strict allowlist before they reach a Dockerfile — all
  enforced in code, not in the prompt.

## Supported stacks

| Layer            | Supported                                                     |
| ---------------- | ------------------------------------------------------------- |
| Frontend         | Node / React (Vite dev server)                                |
| Backend          | Node / Express **or** Python / Django                         |
| Database         | Postgres **or** MongoDB (Redis detected as an optional cache) |
| Package managers | npm / yarn / pnpm · pip / poetry                              |

Anything outside this set is declined with a clear warning rather than guessed at — see
[`docs/supported-stacks.md`](docs/supported-stacks.md).

## Install

```bash
npm install -g orca-agent-cli
```

## Usage

```bash
orca                                             # interactive menu
orca run <repo-url-or-path> --dry-run            # plan + preview only
orca run <repo-url-or-path> --dry-run --auto-approve   # non-interactive (CI)
orca run <repo-url-or-path>                      # build + start with self-heal
```

A dry run needs neither Docker nor an API key. Logs go to stderr and the plan/preview to
stdout, so output stays pipeable. **Exit codes:** `0` success · `2` plan rejected at the
gate · `1` anything else.

| Flag                      | Effect                                          |
| ------------------------- | ----------------------------------------------- |
| `--dry-run`               | Plan and preview only; write and run nothing    |
| `--auto-approve`          | Skip the approval prompt                        |
| `--model <id>`            | `claude-*` routes to Anthropic, `qwen*` to Qwen |
| `--cost-cap <usd>`        | Hard cap on total LLM spend for the run         |
| `--max-heal-attempts <n>` | Bound the self-heal loop (default 3)            |

Precedence is **flag > `ORCA_*` env var > default**. Keys are read from the environment
(`QWEN_API_KEY`, `ANTHROPIC_API_KEY`), never passed as flags; see
[`.env.example`](.env.example) for routing overrides.

## How it works

```
clone → detect → AI fill → plan → APPROVE → generate → build + self-heal
```

ORCA clones the repo into a temporary workspace and runs static detectors to identify
the stack, optionally refining the container templates with AI. It assembles a service
plan and renders it for approval, and only then writes the Dockerfiles, `.dockerignore`s,
Compose file, and — with a key — an explainable `.env`. It runs `docker compose build`
and `up -d --wait`; on failure the allowlisted self-heal loop takes over. On success the
workspace and running stack are kept and their path printed.

For the full design and repository layout, see
[`docs/architecture.md`](docs/architecture.md).

## VS Code extension

[`vscode-extension/`](vscode-extension/) is a thin editor front end over the same core:
**ORCA: Preview Repo**, **ORCA: Run Repo** with per-phase progress and cancellation, and
a native webview for the approval diagram. Keys live in VS Code's encrypted secret
storage, never in `settings.json`.

## Development

```bash
npm install
npm run build        # tsc + copy templates into dist/
npm test             # vitest (hermetic — no keys, no Docker)
npm run lint
npm run typecheck
```

ESM-only TypeScript with `NodeNext` resolution; intra-project imports use explicit `.js`
extensions. The repo is an npm-workspaces monorepo: the root package is the publishable
`orca-agent-cli`, and `vscode-extension/` consumes it through its subpath exports
(`orca-agent-cli`, `/plan`, `/config`, `/ai`).

The bundled samples are real and runnable — see [`examples/README.md`](examples/README.md):

```bash
cd examples/mern-sample            && docker compose up --build
cd examples/django-postgres-sample && docker compose up --build
```

## Security

The self-heal patch allowlist, the untouched-original-repo guarantee, the BYOK model,
and the approval gate are documented in [`SECURITY.md`](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
