/**
 * Scripting-language ecosystem recipes — PHP (Composer) and Ruby (Bundler) — expressed
 * as DATA on the Phase-A `BuildRecipe` model, the interpreted-runtime counterpart to
 * `ecosystems.ts` (Go/Rust/JVM/.NET). Before these, PHP and Ruby were dead members of
 * the `Language`/`Runtime` unions: recognized as languages but with no detector and no
 * recipe, so a Laravel or Rails repo fell straight through to the tier-3 AI guess. Each
 * recipe is a row here — no new control flow, exactly as Phase A promised.
 *
 * PHASE: B (widen deterministic detection) — REAL code, pure data.
 *
 * DESIGN NOTES
 * - PHP recipes are multi-stage: no official `php` image ships Composer, so the builder
 *   stage is the `composer` image (php-cli + Composer) which produces `vendor/`, and the
 *   slim `php:8.3-cli` runtime stage runs the result. The synthesizer emits a builder
 *   stage only when `buildCommands` is non-empty, so `composer install` lives there.
 * - Ruby recipes are single-stage on the full `ruby:3.3` image, which bundles Bundler and
 *   the C toolchain many gems (`pg`, `nokogiri`) compile against — so `bundle install`
 *   works without a separate build image.
 * - Both keep dependency manifests to the single required file (`composer.json` /
 *   `Gemfile`), not the lockfile: messy student repos routinely omit the lock, and a
 *   `COPY` of a missing file fails the build. The lock, when present, still arrives via
 *   `COPY . .` and is honored by the installer.
 */

import type { RecipeEntry } from '../recipe.js';

/** PHP: Composer image builds `vendor/`, slim php-cli runs it. */
const PHP_IMAGES = { build: 'composer:2', runtime: 'php:8.3-cli' } as const;

/** Ruby: one full image for install + run (bundler and the C toolchain are included). */
const RUBY_IMAGES = { build: 'ruby:3.3', runtime: 'ruby:3.3' } as const;

/**
 * PHP recipes, most-specific-first: Laravel (framework-aware `artisan serve`) before the
 * generic Composer app (PHP's built-in server over `public/`). `composer install` is a
 * build command so the synthesizer routes it through the Composer builder stage.
 */
export const PHP_RECIPES: readonly RecipeEntry[] = [
  {
    matcher: { runtime: 'php', anyDependency: ['laravel/framework'] },
    recipe: {
      id: 'php-laravel',
      runtime: 'php',
      dependencyFiles: ['composer.json'],
      installCommands: [],
      buildCommands: [
        'composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader',
      ],
      startCommand: 'php artisan serve --host=0.0.0.0 --port=8000',
      defaultPorts: [8000],
      baseImages: PHP_IMAGES,
    },
  },
  {
    matcher: { runtime: 'php', anyFile: ['composer.json'] },
    recipe: {
      id: 'php-composer',
      runtime: 'php',
      dependencyFiles: ['composer.json'],
      installCommands: [],
      buildCommands: ['composer install --no-dev --no-interaction --prefer-dist'],
      // The conventional web root for a modern Composer app (Laravel/Symfony/Slim).
      startCommand: 'php -S 0.0.0.0:8000 -t public',
      defaultPorts: [8000],
      baseImages: PHP_IMAGES,
    },
  },
];

/**
 * Ruby recipes, most-specific-first: Rails, then Sinatra, then a generic Bundler/Rack
 * fallback. Each drives the framework's documented dev server bound to 0.0.0.0 so the
 * container is reachable from the host.
 */
export const RUBY_RECIPES: readonly RecipeEntry[] = [
  {
    matcher: { runtime: 'ruby', anyDependency: ['rails'] },
    recipe: {
      id: 'ruby-rails',
      runtime: 'ruby',
      dependencyFiles: ['Gemfile'],
      installCommands: ['bundle install'],
      startCommand: 'bundle exec rails server -b 0.0.0.0 -p 3000',
      defaultPorts: [3000],
      baseImages: RUBY_IMAGES,
    },
  },
  {
    matcher: { runtime: 'ruby', anyDependency: ['sinatra'] },
    recipe: {
      id: 'ruby-sinatra',
      runtime: 'ruby',
      dependencyFiles: ['Gemfile'],
      installCommands: ['bundle install'],
      startCommand: 'bundle exec ruby app.rb -o 0.0.0.0 -p 4567',
      defaultPorts: [4567],
      baseImages: RUBY_IMAGES,
    },
  },
  {
    matcher: { runtime: 'ruby', anyFile: ['Gemfile'] },
    recipe: {
      id: 'ruby-bundler',
      runtime: 'ruby',
      dependencyFiles: ['Gemfile'],
      installCommands: ['bundle install'],
      // Rack is the common denominator for a Ruby web app without a named framework.
      startCommand: 'bundle exec rackup --host 0.0.0.0 --port 9292',
      defaultPorts: [9292],
      baseImages: RUBY_IMAGES,
    },
  },
];

/** PHP + Ruby recipes in registration order (PHP first, then Ruby). */
export const SCRIPTING_RECIPES: readonly RecipeEntry[] = [...PHP_RECIPES, ...RUBY_RECIPES];
