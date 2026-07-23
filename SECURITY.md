# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/VivianSobers/ORCA/security/advisories/new)
rather than opening a public issue. You should receive a response within a week.

## Security model

ORCA clones untrusted repositories and asks LLMs to help containerize them, so it is
built around a few hard boundaries:

### What ORCA does with the target repo

- The repo is cloned/copied into a **temporary workspace**; the original checkout is
  never modified.
- Detection (Stage 2) is **static**: ORCA reads manifests and source text. It never
  executes code from the target repo on the host.
- The repo's code only ever runs **inside the docker containers you approved**.

### The approval gate

Nothing is built, run, or written until the plan (service graph, images, ports,
volumes) is shown and approved. Non-interactive sessions **reject** by default;
`--auto-approve` is an explicit opt-in.

### AI output is never trusted

- Every model response is schema-validated (zod) before use; invalid output is
  retried/escalated, never executed.
- The target repo's README is fed to the model as evidence, so it is **untrusted input
  to a prompt**. Values that end up inside a Dockerfile are therefore constrained by
  schema, not by the prompt: build/start commands must be a single invocation of a
  known binary (npm, pip, python, …) with no shell metacharacters, chaining, pipes,
  substitution or redirects; base images must be official `node:*` / `python:*` tags;
  and file paths must stay inside the build context. A response that violates any of
  these is discarded and the run falls back to ORCA's deterministic template defaults.
- The same constraint covers **tier-3 inferred build recipes**, whose commands are
  synthesized into a Dockerfile and executed: install/build commands must name a
  supported toolchain (npm, pip, python, cargo, go, mvn, gradle, java, dotnet), and an
  inferred entrypoint may additionally be an executable path inside the image
  (`./target/release/app`, `/app/server`) but may not climb out of it. A violating
  inference is dropped and detection simply proceeds without it.
- Self-heal patches are restricted by a **code-enforced allowlist**: a patch may only
  touch files ORCA itself generated (Dockerfiles, docker-compose.yml, .dockerignore,
  .env, entrypoint script). Paths are canonicalized against the workspace root —
  application source, `../` traversal, and absolute paths are rejected in
  `src/build/selfHeal.ts` regardless of what the model returns.
- Inferred `.env` values are local-dev placeholders; review them before reusing a
  generated stack anywhere non-local.

### Keys and spend

- **BYOK**: `QWEN_API_KEY` / `ANTHROPIC_API_KEY` are read from your environment,
  used only to call the respective APIs, and never written to disk or logs.
- Repo content (manifests, README excerpts, generated configs, build error output)
  **is sent to the configured LLM providers** during AI stages. Keyless runs send
  nothing anywhere.
- Every run has a hard LLM cost cap (`--cost-cap`, default $1) enforced before each
  call, across all providers.

### Known limitations

- ORCA builds and runs the approved containers with your local docker daemon —
  review the plan (and the previewed configs via `--dry-run`) for untrusted repos;
  a malicious repo's code still runs inside those containers once approved.
- Generated stacks use well-known dev credentials (user/password `orca`) and bind
  ports on localhost; they are for local development only.

## Supported versions

Only the latest release receives security fixes.
