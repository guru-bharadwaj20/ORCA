# Test Fixtures

> Fake repo trees used by the detection tests (STAGE 2). These are NOT runnable apps —
> just the minimal files (manifests, lockfiles, entrypoints) a detector needs to see.

Add subdirectories per scenario, e.g.:

```
fixtures/
├── mern-repo/                # package.json (react), server/package.json (express, mongoose)
├── django-postgres-repo/     # requirements.txt (django, psycopg2), manage.py
└── unsupported-repo/         # e.g. a Rust project ORCA should decline
```

Each fixture should be the smallest tree that makes the relevant detector assertions meaningful.
