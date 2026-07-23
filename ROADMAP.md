# ORCA Roadmap

A quick, at-a-glance map of what's built, what's underway, and what's left — so any
dev can orient without reading the full design doc. For the full architecture and
rationale, see [`docs/universal-understanding-plan.md`](docs/universal-understanding-plan.md).

## Legend

Each item has **one** stub. A completed item is green; a not-started item is red; an
item someone is **actively working on** shows **that person's** colour instead.

| Stub | Meaning                   |
| ---- | ------------------------- |
| 🟢   | Completed                 |
| 🔴   | Yet to be done            |
| 🟠   | In progress — Diya        |
| 🟣   | In progress — Guru        |
| 🔵   | In progress — Harsha      |
| ⚪   | In progress — Vivian (me) |

## Universal Repository Understanding — phases

| Stub | Phase                          | What it delivers                                                                                                                   |
| :--: | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
|  🟢  | **A — Foundation**             | Evidence model (`Claim`/`Evidence`/`Detector`), confidence combination, `BuildRecipe` as data, seed stacks re-expressed as recipes |
|  🟢  | **B — Widen detection**        | Runtime detectors + recipes per ecosystem (19 recipes), framework signature table (23), open runtime taxonomy                      |
|  🟢  | **C — Repo & CI analysis**     | GitHub Actions / task-runner recovery, existing-Dockerfile detection, cross-tier confidence                                        |
|  🟢  | **D — AI inference**           | LLM gap-filler when the deterministic ladder is thin, confidence-capped, reasoning trail                                           |
|  🟢  | **E — Docker synthesis**       | Multi-stage Dockerfiles synthesized from any recipe (compiled → slim runtime; interpreted → single stage)                          |
|  🟢  | **F — Recipe-aware self-heal** | Heal loop gets recipe context; learned overrides persisted per repo signature (`~/.orca`) and replayed next run                    |
|  🟢  | **G — Dynamic probing**        | Tier-4 `Prober` seam + security contract (execution deferred by design)                                                            |

## Ecosystem recipe coverage

Adding a stack is **adding data, not editing an enum**. Shipped recipes:

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

## Remaining work

| Stub | Item                           | Notes                                                                                                                                           |
| :--: | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
|  🔴  | Ecosystem example repos        | Runnable `examples/<stack>` per ecosystem (Go/Rust/JVM/.NET/…) + golden tests. Recipes are unit-tested; runnable samples are the gap (Phase B3) |
|  🔴  | `PackageManager` open taxonomy | Widened with `uv`, but still a closed enum — Phase B1 called for an open string + known-set                                                     |
|  🔴  | Probing implementation         | Phase G execution behind the existing seam — deferred by design decision #2                                                                     |
|  🔴  | Per-ecosystem entrypoints      | e.g. a JVM/.NET migrate-then-run analogue to the Django entrypoint — deferred until a recipe needs one                                          |
|  🔴  | Plan-doc reconciliation        | `docs/universal-understanding-plan.md` status table lags the code (Phase F persistence, 19 recipes)                                             |

## Health

`main` is green: **327 tests · 50 files**, typecheck ✓, lint ✓, prettier ✓, CI green on Node 20 + 22.

---

_When you start on a red item, change its stub to your colour; when you finish, make it green._
