<h1 align="center">ORCA</h1>

<p align="center"><strong>Orchestrated Repository Comprehension Agent</strong><br>
A CLI that takes a repo you've never seen before and gets it running in Docker.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/orca-agent-cli"><img alt="npm" src="https://img.shields.io/npm/v/orca-agent-cli.svg"></a>
  <a href="https://github.com/VivianSobers/ORCA/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/VivianSobers/ORCA/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<p align="center">
  <img src="docs/CLI.png" alt="ORCA's interactive CLI menu" width="720">
</p>

## What this is

You've cloned somebody's project and now you want to actually run it. There's no
Dockerfile. The README stops after `npm install`. Nobody wrote down which environment
variables matter or which port the API expects. You spend forty minutes reading source
files to reconstruct what the author already knew.

ORCA does that reading for you. Point it at a repo and it works out what the project is,
writes the Docker and Compose files, shows you the plan, and then starts everything once
you approve.

The important part is that it explains itself. Every conclusion carries a confidence
score and the evidence behind it, so when ORCA says a service listens on 8000 you can see
whether it read that from a Dockerfile, a source file, or a guess.

## Quick start

```bash
npm install -g orca-agent-cli
orca
```

That opens the interactive menu. If you'd rather go straight at a repo:

```bash
orca run https://github.com/someone/their-project --dry-run
```

A dry run is the safe way to start. It clones into a temp directory, works out the plan,
prints the Dockerfiles and Compose file it _would_ write, and stops there. Nothing is
built, nothing is written to your disk, and you don't need Docker or an API key for it.

When the plan looks right, drop the flag and let it build:

```bash
orca run https://github.com/someone/their-project
```

Local paths work too, so `orca run .` is fine.

## What you need

Node 20 or newer, and Docker if you want ORCA to actually build and start things. An API
key is optional. Without one ORCA falls back to its deterministic templates and the run
still completes; with one it can fill in gaps and repair failed builds.

If you want the AI features, put a key in your environment before running:

```bash
export QWEN_API_KEY=...        # primary
export ANTHROPIC_API_KEY=...   # automatic fallback
```

Keys are read from the environment only. There is no flag to pass one, deliberately, so
they don't end up in your shell history.

## Commands

```bash
orca                                   # interactive menu
orca run <repo>                        # clone, plan, approve, build, start
orca run <repo> --dry-run              # plan and preview only
orca run <repo> --dry-run --auto-approve
```

| Flag                      | What it does                                                                  |
| :------------------------ | :---------------------------------------------------------------------------- |
| `--dry-run`               | Work out the plan and print the configs. Writes nothing, builds nothing.      |
| `--auto-approve`          | Skip the approval prompt. Use this in CI.                                     |
| `--model <id>`            | Pick a model. Anything starting `claude` routes to Anthropic, `qwen` to Qwen. |
| `--cost-cap <usd>`        | Hard ceiling on what the run may spend on LLM calls.                          |
| `--max-heal-attempts <n>` | How many repair attempts before giving up. Defaults to 3.                     |
| `--verbose`               | Verbose debug logging.                                                        |

Settings resolve as flag first, then `ORCA_*` environment variables, then the default.

Logs go to stderr and the plan goes to stdout, so you can pipe the useful part somewhere
without the noise. Exit codes are `0` for success, `2` if you reject the plan at the
approval gate, and `1` for everything else.

## What it can run

ORCA started out handling three stacks. It now covers 56 build recipes across eight
ecosystems, and adding another one is a data change rather than new code.

| Ecosystem | Covered                                                                                                    |
| :-------- | :--------------------------------------------------------------------------------------------------------- |
| Node      | react, express, next, nest, angular, vite, fastify, koa, hapi, hono, remix, nuxt, sveltekit, astro, adonis |
| Python    | django, fastapi, flask, litestar, starlette, quart, sanic, bottle, streamlit                               |
| PHP       | composer, laravel, symfony                                                                                 |
| Ruby      | bundler, rails, sinatra                                                                                    |
| Go        | go modules, built to a distroless image                                                                    |
| Rust      | cargo                                                                                                      |
| JVM       | maven, gradle                                                                                              |
| .NET      | dotnet sdk                                                                                                 |

Python recipes come in uv, poetry, and pip variants, picked by whichever lockfile the
project actually ships.

If a project doesn't match any of those, ORCA falls back to what it does know. A Node or
Python repo with a manifest and a start script gets a working container even when the
framework is one nobody has written a recipe for. Postgres, MongoDB, and Redis are
detected from your dependencies and wired into the Compose file with health checks.

Monorepos are handled properly. Three services in one repo become three containers, not
one guess.

## How it works

```
clone → detect → plan → you approve → generate → build → repair if needed
```

Detection is layered, strongest evidence first. Manifests and lockfiles come first, then
CI configs, Makefiles, and README commands, and only then AI inference, which is capped
so it can never outrank something ORCA read directly from a file. If the deterministic
layers already explain the project, no API call happens at all.

There is a fourth layer that actually runs the project to see what it does, but it is off
unless you ask for it. See [Probing](#probing-off-by-default) below.

Nothing touches your disk before you approve. ORCA renders the planned service graph as a
diagram plus a table, and waits.

When a build fails, the repair loop diagnoses the error, patches, and retries, printing
what it changed and why on each attempt. It can only edit files ORCA generated itself.
Your repo is never modified.

More detail lives in [`docs/architecture.md`](docs/architecture.md).

## Probing (off by default)

Everything above reads the project without running it. Probing is the exception: it starts
the container ORCA planned and reads what actually happened, which settles questions
static analysis can only guess at, like whether the app really binds the port it appears
to.

It is **off unless you turn it on**, because it is the only part of ORCA that executes code
from the repo:

```bash
export ORCA_ENABLE_PROBING=true
```

When enabled, a probe container is locked down: no network, a read-only root filesystem,
512 MB of memory, one CPU, 256 processes, and a 60 second ceiling per Docker call. The
approval gate tells you probing is on before you approve anything.

| Variable                | Default | What it controls                 |
| :---------------------- | :------ | :------------------------------- |
| `ORCA_ENABLE_PROBING`   | `false` | Whether probing runs at all      |
| `ORCA_PROBE_NETWORK`    | `none`  | Network for the probe container  |
| `ORCA_PROBE_READONLY`   | `true`  | Read-only root filesystem        |
| `ORCA_PROBE_MEMORY`     | `512m`  | Memory cap                       |
| `ORCA_PROBE_CPUS`       | `1`     | CPU cap                          |
| `ORCA_PROBE_PIDS_LIMIT` | `256`   | Process cap, the fork-bomb guard |
| `ORCA_PROBE_TIMEOUT_MS` | `60000` | Wall clock per Docker call       |
| `ORCA_PROBE_SETTLE_MS`  | `3000`  | Settle time before reading state |

Relaxing `ORCA_PROBE_NETWORK` or `ORCA_PROBE_READONLY` is supported, since a container
whose database is unreachable may die before it binds anything, but both defaults exist
for a reason. Loosen them only for a repo you trust.

## Safety

Worth knowing before you run this on someone else's code:

The cloned repo is read only. ORCA works in a temp directory and never writes back to it.
The repair loop is restricted to files ORCA created, enforced in code rather than asked
for in a prompt. Anything an LLM proposes, base images, build commands, file paths, is
checked against an allowlist before it can reach a Dockerfile. Generated `.env` files are
written `0600` because that's where real credentials end up.

Nothing executes code from the repo unless you set `ORCA_ENABLE_PROBING`, and a build you
approve is still a build: `docker build` runs the project's own Dockerfile instructions.
Read a plan before approving it.

Full detail in [`SECURITY.md`](SECURITY.md).

## VS Code extension

[`vscode-extension/`](vscode-extension/) wraps the same core in an editor UI, with
progress per phase, cancellation, and the approval diagram in a native webview. Keys go
in VS Code's encrypted secret storage rather than `settings.json`.

## Try it on something real

The repo ships sample projects that actually run:

```bash
cd examples/mern-sample            && docker compose up --build
cd examples/django-postgres-sample && docker compose up --build
```

See [`examples/README.md`](examples/README.md).

## Working on ORCA

```bash
npm install
npm run build       # tsc, plus copying templates into dist/
npm test            # vitest, fully hermetic: no keys, no Docker, no network
npm run lint
npm run typecheck
```

ESM only TypeScript on `NodeNext` resolution, so intra project imports carry explicit
`.js` extensions. It's an npm workspaces monorepo: the root package is the publishable
`orca-agent-cli`, and the extension consumes it through subpath exports.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the setup, the ground rules, and a roadmap
showing what's done and what's free to pick up. The design document behind the detection
engine is [`docs/universal-understanding-plan.md`](docs/universal-understanding-plan.md).

## License

MIT. See [LICENSE](LICENSE).
