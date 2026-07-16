# django-postgres-sample

> STAGE 1 fixture — a small but genuinely runnable Django + Postgres app used to develop
> and verify ORCA's manual container foundation.

**Stack:** Python/Django backend + Postgres database.

## Layout

```
django-postgres-sample/
├── config/                 # Django project (settings, urls, wsgi)
├── core/                   # one app: one model (Widget), one view (/), one migration
├── manage.py
├── requirements.txt        # Django + psycopg2 (needs libpq-dev + gcc to build)
├── entrypoint.sh           # waits for Postgres, runs migrate, then runserver
├── Dockerfile              # runnable Python dev image (mirrors .orca-golden/Dockerfile)
├── docker-compose.yml      # runnable stack (mirrors .orca-golden/docker-compose.yml)
└── .orca-golden/           # the golden reference ORCA is expected to regenerate
    ├── Dockerfile
    ├── entrypoint.sh
    └── docker-compose.yml
```

## Classic gotchas handled

- **libpq / build deps:** the image installs `libpq-dev` and `gcc` (apt) so `psycopg2`
  compiles.
- **migrate before runserver + DB readiness:** `depends_on` only waits for the db
  *container* to start, not for Postgres to accept connections. `entrypoint.sh` waits for
  the Postgres socket, runs `python manage.py migrate`, then hands off to the server.

## Run it

```bash
cd examples/django-postgres-sample
docker compose up --build
```

**Expected working state:**

- `http://localhost:8000/` — returns
  `{"message":"hello from the ORCA django app","widgets":0}`
  (a JSON response proving Django is up and talking to Postgres after migrations).
- Postgres is reachable on `localhost:5432` (db `orca`, user `orca`, password `orca`).
