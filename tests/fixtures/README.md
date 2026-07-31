# Test Fixtures

> Fake repo trees used by the detection tests (STAGE 2). These are NOT runnable apps —
> just the minimal files (manifests, lockfiles, entrypoints) a detector needs to see.

Add subdirectories per scenario, e.g.:

```
fixtures/
├── mern-repo/                # package.json (react), server/package.json (express, mongoose)
├── django-postgres-repo/     # requirements.txt (django, psycopg2), manage.py
├── react-express-nodb-repo/  # supported stack with NO database — no named volumes
├── express-dbconfig-repo/    # a `port:` in a driver config that is not the app's port
└── unsupported-repo/         # e.g. a Rust project ORCA should decline
```

`react-express-nodb-repo` and `express-dbconfig-repo` exist to keep specific bugs
fixed: a compose file whose `volumes:` key rendered empty (which Docker rejects), and
a database port being detected as the service port. Both shapes are ordinary hackathon
repos, so they belong in the regular sweep rather than in one-off tests.

Each fixture should be the smallest tree that makes the relevant detector assertions meaningful.

## README / shell-script fixtures

These back `tests/detect/repo-scripts.test.ts`. Unlike most fixtures they are
deliberately *wordy* — the thing under test is what the parser refuses to extract from
prose and non-shell code blocks, so a minimal tree would not exercise it.

| Fixture                 | What it pins                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `readme-only-repo`      | clear run instructions, NO manifest — parses cleanly yet must stay unsupported |
| `shell-script-repo`     | `start.sh` + `scripts/build.sh`, incl. a backslash-continued command     |
| `readme-and-script-repo`| both sources on one (Express) repo — both must surface independently     |
| `readme-ambiguous-repo` | prose + TOML/YAML blocks + a clone/cd/export block — must find NOTHING   |

`readme-ambiguous-repo` is the important one: it is the false-positive guard. Its TOML
and YAML blocks both declare `port = 7777`, and its only shell block holds nothing but
`git clone` / `cd` / `export` / `source` / `curl`. A change that makes this fixture
report any command or port has widened the parser too far — that repo is meant to fall
through to tier-3 AI inference, not be guessed at.

## Component-role fixtures (§2.3)

These back `tests/detect/component-role.test.ts` and the CLI case in
`tests/core/pipeline.test.ts`. Each one is a repo that is **not web-shaped** — the roles
the model could not represent before `ComponentRole` widened.

| Fixture              | Resolves to  | Why it exists                                                       |
| -------------------- | ------------ | ------------------------------------------------------------------- |
| `go-worker-repo`     | `worker`     | `go.mod` + `asynq`, no web framework, no port — the end-to-end case  |
| `celery-worker-repo` | `worker`     | `Procfile` with `worker:` and no `web:` — the explicit-intent rule   |
| `node-cli-repo`      | `cli`        | `package.json` `bin`, no server script, Dockerfile with no `EXPOSE`  |
| `mixed-roles-repo`   | all four     | a worker, a cli and a library BESIDE a listening service, under one workspace root |

`mixed-roles-repo` backs `tests/detect/parent-role.test.ts` and exists for the parent
case the three single-role fixtures above cannot express. Every role path gates on
`declaredPorts`, so while `portsFromCode` walked recursively a parent inherited its
children's ports and could never resolve to anything but a service. That test reads its
facts from disk for exactly this reason — hand-passing `declaredPorts: []` would have
passed throughout the period the bug was live. Its root must stay free of a `bin`, a
start script and an entry module, or the root assertion stops testing anything.

`go-worker-repo` carries the load: it proves a worker reaches the plan as a `'service'`
node with **no published port**, even though its `go-mod` recipe declares
`defaultPorts: [8080]`. If that assertion ever flips to publishing 8080, role-aware port
suppression has regressed.

The rule these fixtures exist to protect is the inverse one: a component that declares a
port is NEVER reclassified. `component-role.test.ts` pins that directly (same worker
dependency + a declared port → no reclassification), which is what stops a web app that
merely enqueues background jobs from being demoted to a worker.

## Recipe fixtures (`.orca-golden/`)

The framework fixtures below back `tests/generate/framework-golden.test.ts`. Each holds
its manifest plus a `.orca-golden/Dockerfile` — the exact output `synthesizeDockerfile`
must produce for the recipe that fixture resolves to. `.orca-golden` is in
`DEFAULT_WALK_IGNORE`, so goldens never leak into detection.

| Fixture               | Resolves to             | Why it exists                                       |
| --------------------- | ----------------------- | --------------------------------------------------- |
| `nextjs-repo`         | `node-next`             | declares `react` too — must NOT match `node-react`  |
| `nestjs-repo`         | `node-nest`             | declares `express` too — must NOT match `node-express` |
| `angular-repo`        | `node-angular`          | dev-server recipe, no build stage                   |
| `vite-vue-repo`       | `node-vite`             | non-React Vite app that previously matched nothing  |
| `fastapi-repo`        | `python-fastapi`        | pip flavour, uvicorn                                |
| `flask-repo`          | `python-flask`          | pip flavour, gunicorn                               |
| `fastapi-poetry-repo` | `python-fastapi-poetry` | `poetry.lock` selects the Poetry install commands   |
| `flask-uv-repo`       | `python-flask-uv`       | `uv.lock` selects the uv install commands           |
| `php-laravel-repo`    | `php-laravel`           | `laravel/framework` dep → framework recipe          |
| `php-plain-repo`      | `php-composer`          | composer.json, no framework → generic PHP recipe    |
| `rails-repo`          | `ruby-rails`            | `rails` gem → Rails server recipe                   |
| `sinatra-repo`        | `ruby-sinatra`          | `sinatra` gem → distinct from the Rack fallback     |
| `rack-repo`           | `ruby-bundler`          | Gemfile, no framework → generic `rackup` recipe     |

The Node/Python fixtures back `tests/generate/framework-golden.test.ts`; the PHP/Ruby
ones back `tests/generate/scripting-golden.test.ts`, which additionally runs the real
`detectStack` to prove the new PHP/Ruby detectors surface an ecosystem component.

The two Python lockfiles (`poetry.lock`, `uv.lock`) are stubs: only their **presence**
matters, since that is what the recipe matcher keys off.

Regenerating a golden is a deliberate act — read the diff before accepting it.
