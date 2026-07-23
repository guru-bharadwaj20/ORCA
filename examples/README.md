# ORCA Example Repos

> STAGE 1 — small, real, **runnable** sample apps used to develop and verify ORCA's
> manual container foundation (hand-written golden Docker/compose configs → Handlebars
> templates → snapshot verification).

Each sample is intentionally tiny but genuinely starts, and ships a `.orca-golden/` folder
containing the concrete, hand-written configs ORCA is expected to (re)generate. The
Stage 1 snapshot tests assert that rendering the templates reproduces these golden files
exactly.

| Sample | Stack | Database | How to run | Expected working state |
| --- | --- | --- | --- | --- |
| [`mern-sample/`](./mern-sample/) | Node/React (Vite) + Node/Express | MongoDB | `cd examples/mern-sample && docker compose up --build` | client `:5173` renders "hello from the ORCA express server" + a Mongo-backed visit count; API `:5000/api/hello` returns JSON |
| [`django-postgres-sample/`](./django-postgres-sample/) | Python/Django | Postgres | `cd examples/django-postgres-sample && docker compose up --build` | `:8000/` returns `{"message":"hello from the ORCA django app","widgets":0}` after auto-migrate |

### Ecosystem samples (synthesizer path)

Beyond the seed stacks, these tiny repos exercise the **generic Dockerfile synthesizer**
(Go/Rust/JVM/.NET recipes, not Handlebars templates). Each ships a `.orca-golden/Dockerfile`
that is the exact synthesizer output, pinned by `tests/examples/ecosystem-golden.test.ts`.

| Sample | Stack | Recipe | Expected working state |
| --- | --- | --- | --- |
| [`go-sample/`](./go-sample/) | Go (`net/http`) | `go-mod` | `:8080/` returns `{"status":"ok","service":"orca-go-sample"}` |
| [`rust-sample/`](./rust-sample/) | Rust (std TCP) | `rust-cargo` | `:8080/` returns `{"status":"ok","service":"orca-rust-sample"}` |

Each sample's own `README.md` documents its layout and the gotchas it handles.

## About `.orca-golden/`

The Dockerfiles and `docker-compose.yml` committed at each sample's build locations
(e.g. `mern-sample/server/Dockerfile`, `mern-sample/docker-compose.yml`) are
**byte-identical** to the copies in that sample's `.orca-golden/` folder. The golden copies
are the canonical reference the snapshot tests compare against; the in-place copies make
`docker compose up` work without any copy step.

---

## Manual verification

This stage is verified by hand on your machine (this environment has no Docker). Requires
Docker Desktop / Docker Engine with the Compose v2 plugin.

### MERN sample

```bash
cd examples/mern-sample
docker compose up --build
```

Then check:

1. Open **http://localhost:5173** → the page shows
   **"API says: hello from the ORCA express server"** and **"Recorded visits (via MongoDB): N"**.
   Refresh a few times — `N` increases (client → Express → MongoDB round-trip works).
2. `curl http://localhost:5000/api/hello` →
   `{"message":"hello from the ORCA express server","visits":<n>}`.
3. Tear down: `docker compose down -v`.

### Django + Postgres sample

```bash
cd examples/django-postgres-sample
docker compose up --build
```

Then check:

1. Watch the logs — the `web` service prints `waiting for postgres...`, then
   `running migrations...`, then `starting server...` (the migrate-before-run entrypoint).
2. `curl http://localhost:8000/` →
   `{"message":"hello from the ORCA django app","widgets":0}`.
3. Tear down: `docker compose down -v`.

> A "success" for Stage 1 means both stacks come up with `docker compose up --build` and
> return the responses above — and that `npm test` shows the rendered templates match each
> `.orca-golden/` file exactly.
