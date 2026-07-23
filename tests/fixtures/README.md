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
