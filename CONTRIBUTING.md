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

| Stub | Item                           | Notes                                                                                                                                           |
| :--: | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
|  ⚪  | Flaky `hostPorts` test         | Binds real OS ports, so it fails randomly on busy CI runners — make it deterministic                                                            |
|  ⚪  | Ecosystem example repos        | Runnable `examples/<stack>` per ecosystem (Go/Rust/JVM/.NET/…) + golden tests. Recipes are unit-tested; runnable samples are the gap (Phase B3) |
|  ⚪  | `PackageManager` open taxonomy | Widened with `uv`, but still a closed enum — Phase B1 called for an open string + known-set                                                     |
|  ⚪  | Per-ecosystem entrypoints      | e.g. a JVM/.NET migrate-then-run analogue to the Django entrypoint — deferred until a recipe needs one                                          |
|  ⚪  | Plan-doc reconciliation        | `docs/universal-understanding-plan.md` status table lags the code (Phase F persistence, 19 recipes)                                             |
|  🔴  | Probing implementation         | Phase G execution behind the existing seam — deferred by design decision #2                                                                     |

**When you start on a red item, change its stub to your colour; when you finish, make it
green.**
