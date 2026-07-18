# Changelog

All notable changes to the ORCA VS Code extension are documented here.

## [Unreleased]

### Added

- **ORCA: Preview Repo (Dry Run)** — detect, plan, approve, and preview the generated
  Docker configs without building anything.
- **ORCA: Run Repo** — full pipeline (build + start the stack) with per-phase progress,
  a cancel button, and the explainable self-heal loop rendered live.
- **Plan approval webview** — Mermaid service-graph diagram + service table with
  Approve / Reject; bundled offline (no CDN).
- **ORCA: Set API Key** — Qwen / Anthropic keys stored in VS Code secret storage.
- Settings: `orca.model`, `orca.costCapUsd`, `orca.maxHealAttempts`,
  `orca.primaryProvider`, `orca.fallbackProvider`.
