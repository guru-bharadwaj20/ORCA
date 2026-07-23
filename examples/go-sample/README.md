# go-sample

A minimal Go (`net/http`) service — the smallest repo that exercises ORCA's **Go
ecosystem recipe** (`go-mod`) end to end: detect → synthesize a multi-stage Dockerfile →
build → run.

```bash
orca run examples/go-sample --dry-run   # see the synthesized plan + Dockerfile
```

ORCA builds it in a `golang:1.23` stage (`go mod download`, `go build`) and copies the
static binary into a distroless runtime image. The committed
[`.orca-golden/Dockerfile`](.orca-golden/Dockerfile) is the exact output the synthesizer
produces, pinned by a golden test.
