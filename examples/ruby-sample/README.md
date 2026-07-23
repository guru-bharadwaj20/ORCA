# ruby-sample

A minimal Sinatra app — the smallest repo that exercises ORCA's **Ruby (Sinatra) recipe**
(`ruby-sinatra`): detect the `Gemfile` + `sinatra` dependency → synthesize a Dockerfile →
`bundle install` → run.

```bash
orca run examples/ruby-sample --dry-run
```

ORCA installs gems and runs the app in a `ruby:3.3` image
(`bundle exec ruby app.rb -o 0.0.0.0 -p 4567`). The committed
[`.orca-golden/Dockerfile`](.orca-golden/Dockerfile) is the exact synthesizer output,
pinned by a golden test.
