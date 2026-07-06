# ORCA Example Repos

> STAGE 0 — sample target repos used to develop and test ORCA end-to-end.

These are intentionally small, slightly-messy repos that mimic what a student or
hackathon team would push. Each one exercises a different supported stack and has a
documented, known-good containerized setup so we can assert ORCA reproduces it.

| Sample | Stack | Database | Known-good setup |
| --- | --- | --- | --- |
| [`mern-sample/`](./mern-sample/) | Node/React + Node/Express | MongoDB | frontend :3000, api :5000, mongo :27017 |
| [`django-postgres-sample/`](./django-postgres-sample/) | Python/Django | Postgres | web :8000, db :5432 |

> **Note:** these directories are placeholders in the scaffold. Populate them with a
> real (or minimal stub) app, or replace them with a submodule/link to an upstream
> sample repo.
