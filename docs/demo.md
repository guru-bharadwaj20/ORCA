# ORCA Demo

> STAGE 8 doc — the intended end-to-end demo flow. Placeholder script.

## The 60-second story

1. `export ANTHROPIC_API_KEY=...` (BYOK).
2. `orca run https://github.com/some-team/hackathon-project`
3. ORCA clones the repo and **detects** the stack (e.g. React + Express + MongoDB).
4. ORCA generates Docker + docker-compose and prints a **Mermaid service-graph
   diagram** — then pauses for **your approval**. Nothing has run yet.
5. You approve (or edit ports/env).
6. ORCA builds and runs the stack. On failure, the **self-heal loop** kicks in:
   each attempt prints a plain-English explanation of what broke and how it was fixed.
7. Containers are up; ORCA prints the URLs.

## Try it against the bundled examples

```bash
orca run ./examples/mern-sample --dry-run     # show the plan + diagram only
orca run ./examples/django-postgres-sample
```

<!-- TODO(stage-8): record an asciinema cast and embed sample diagram + heal-log output. -->
