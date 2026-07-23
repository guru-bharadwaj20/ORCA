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
