# mern-sample

> STAGE 1 fixture — a small but genuinely runnable MERN app used to develop and verify
> ORCA's manual container foundation.

**Stack:** Node/React (Vite) frontend + Node/Express backend + MongoDB.

## Layout

```
mern-sample/
├── client/                 # React + Vite single-page app (fetches from the server)
│   ├── src/App.jsx         # one page; calls GET /api/hello
│   ├── Dockerfile          # runnable Node dev image (mirrors .orca-golden/client.Dockerfile)
│   └── ...
├── server/                 # Express API + mongoose connection
│   ├── index.js            # one route (/api/hello) + a Visit model
│   ├── Dockerfile          # runnable Node dev image (mirrors .orca-golden/server.Dockerfile)
│   └── ...
├── docker-compose.yml      # runnable stack (mirrors .orca-golden/docker-compose.yml)
└── .orca-golden/           # the golden reference ORCA is expected to regenerate
    ├── client.Dockerfile
    ├── server.Dockerfile
    └── docker-compose.yml
```

> The Dockerfiles/compose in the service dirs and root are **byte-identical** to the ones
> in `.orca-golden/`. The golden copies are the snapshot-test target; the in-place copies
> make `docker compose up` work with no extra steps.

## Run it

```bash
cd examples/mern-sample
docker compose up --build
```

**Expected working state:**

- `http://localhost:5173` — the React page renders **"API says: hello from the ORCA express server"**
  and a visit counter that increments on refresh (proves client → server → MongoDB).
- `http://localhost:5000/api/hello` — returns
  `{"message":"hello from the ORCA express server","visits":<n>}`.
- MongoDB is reachable on `localhost:27017`.
