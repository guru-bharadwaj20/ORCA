# php-sample

A minimal PHP app served by the built-in server over `public/` — the smallest repo that
exercises ORCA's **PHP (Composer) recipe** (`php-composer`): detect `composer.json` →
synthesize a multi-stage Dockerfile → `composer install` → run.

```bash
orca run examples/php-sample --dry-run
```

ORCA builds `vendor/` in a `composer:2` stage and serves it from a slim `php:8.3-cli`
image (`php -S 0.0.0.0:8000 -t public`). The committed
[`.orca-golden/Dockerfile`](.orca-golden/Dockerfile) is the exact synthesizer output,
pinned by a golden test.
