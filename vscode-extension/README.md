# ORCA for VS Code

Clone, containerize, and self-heal a messy student/hackathon repo — from the editor.
ORCA detects a repo's stack, generates Docker + docker-compose configs, shows you the
planned service graph **for approval before anything runs**, then builds and starts the
containers with a self-healing retry loop that explains each fix in plain English.

This extension is a thin front end over the [`orca-repo-agent`](../README.md) engine — all the
real work (detection, planning, build, self-heal) lives in the core.

## Features

- **Approve-before-build plan view** — a native webview renders the service-graph as a
  Mermaid diagram next to a service table, with **Approve** / **Reject**. Nothing is
  built or written until you approve.
- **Dry-run preview** — see the generated `docker-compose.yml` + Dockerfiles without
  building anything (no Docker, no API keys required).
- **Full run with explainable self-heal** — per-phase progress with a cancel button;
  when a build fails, each fix is retried and explained in the ORCA output channel.
- **Bring-your-own-key, keyless-capable** — AI refinement is optional; with no key ORCA
  falls back to its deterministic template defaults. Keys are stored in VS Code's
  encrypted secret storage, never in `settings.json`.

## Commands

| Command                          | What it does                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------- |
| **ORCA: Preview Repo (Dry Run)** | Detect + plan + approve, then show the generated configs. No Docker/keys needed. |
| **ORCA: Run Repo**               | The full flow: build + start the stack with self-heal. Requires Docker.          |
| **ORCA: Set API Key**            | Store a Qwen or Anthropic key in VS Code secret storage.                         |

## Requirements

- **VS Code** 1.90+.
- **Docker** (with the daemon running) — only for **Run Repo**; preview needs neither
  Docker nor keys.
- **An API key** (optional) — Qwen (primary) or Anthropic (fallback), set via
  **ORCA: Set API Key**. Without one, ORCA uses template defaults (a failed build can't
  self-heal without a key).

## Settings

| Setting                 | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `orca.model`            | Model id for AI stages (`claude-*` → Anthropic, `qwen*` → Qwen). |
| `orca.costCapUsd`       | Hard cap on LLM spend per run, in USD.                           |
| `orca.maxHealAttempts`  | Max self-heal attempts before giving up.                         |
| `orca.primaryProvider`  | AI provider tried first (`qwen` / `anthropic`).                  |
| `orca.fallbackProvider` | Fallback provider (`anthropic` / `qwen` / `none`).               |

Each setting overrides its `ORCA_*` environment variable; precedence is
**setting > env > default**.

## Supported stacks

React/Node (Vite) · Express **or** Django · Postgres / MongoDB (Redis as an optional
cache). Anything outside this set is declined with a clear warning rather than guessed
at.

## Demo

> _A demo GIF of the approval webview will be added here._

## License

MIT — see [LICENSE](LICENSE).
