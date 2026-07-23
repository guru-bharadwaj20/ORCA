# dotnet-sample

A minimal .NET service on `HttpListener` — the smallest repo that exercises ORCA's
**.NET recipe** (`dotnet-sdk`): detect the project → synthesize a multi-stage Dockerfile
→ `dotnet publish` → run the dll under the ASP.NET runtime image.

```bash
orca run examples/dotnet-sample --dry-run
```

ORCA builds in a `mcr.microsoft.com/dotnet/sdk:8.0` stage (`dotnet restore` + `publish`)
and runs the published dll in `mcr.microsoft.com/dotnet/aspnet:8.0`. The recipe's
`{{dll}}` resolves to `orca-dotnet-sample.dll`. A `global.json` pins the SDK (and is the
signal the recipe matches on). The committed
[`.orca-golden/Dockerfile`](.orca-golden/Dockerfile) is the exact synthesizer output,
pinned by a golden test.
