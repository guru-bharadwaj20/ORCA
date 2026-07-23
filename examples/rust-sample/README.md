# rust-sample

A minimal Rust (std-only TCP) service — the smallest repo that exercises ORCA's **Rust
ecosystem recipe** (`rust-cargo`) end to end: detect → synthesize a multi-stage
Dockerfile → build → run.

```bash
orca run examples/rust-sample --dry-run   # see the synthesized plan + Dockerfile
```

ORCA builds it in a `rust:1-slim` stage (`cargo build --release`) and copies the release
binary into a slim Debian runtime. The `{{binary}}` placeholder resolves to the crate
name (`orca-rust-sample`). The committed
[`.orca-golden/Dockerfile`](.orca-golden/Dockerfile) is the exact synthesizer output,
pinned by a golden test.
