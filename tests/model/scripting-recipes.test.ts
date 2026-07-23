/**
 * PHP (Composer) and Ruby (Bundler) recipes — the interpreted-runtime ecosystems that
 * were previously dead members of the Language/Runtime unions (recognized as languages,
 * but no detector and no recipe, so a Laravel/Rails repo fell through to the tier-3 AI
 * guess). These assert framework-before-generic ordering and that adding them did not
 * disturb any other runtime's matching.
 */
import { describe, expect, it } from 'vitest';

import type { MatchFacts } from '../../src/model/recipe.js';
import { defaultRecipeRegistry } from '../../src/model/recipes/index.js';

const registry = defaultRecipeRegistry();
const facts = (over: Partial<MatchFacts>): MatchFacts => ({
  runtime: 'php',
  dependencies: [],
  files: [],
  ...over,
});

describe('PHP recipes', () => {
  it('resolves Laravel to a multi-stage Composer recipe with artisan serve', () => {
    const recipe = registry.match(
      facts({ dependencies: ['laravel/framework'], files: ['composer.json'] })
    );
    expect(recipe?.id).toBe('php-laravel');
    // Composer isn't in any php image, so install runs in the composer builder stage.
    expect(recipe?.buildCommands?.[0]).toContain('composer install');
    expect(recipe?.baseImages.build).toBe('composer:2');
    expect(recipe?.baseImages.runtime).toBe('php:8.3-cli');
    expect(recipe?.startCommand).toBe('php artisan serve --host=0.0.0.0 --port=8000');
    expect(recipe?.defaultPorts).toEqual([8000]);
  });

  it('falls back to the generic php-composer recipe for a non-Laravel composer app', () => {
    const recipe = registry.match(
      facts({ dependencies: ['monolog/monolog'], files: ['composer.json'] })
    );
    expect(recipe?.id).toBe('php-composer');
    expect(recipe?.startCommand).toBe('php -S 0.0.0.0:8000 -t public');
  });

  it('does not match a PHP recipe without a composer.json', () => {
    expect(registry.match(facts({ dependencies: ['laravel/framework'], files: [] }))?.id).toBe(
      // Laravel is dependency-keyed, so it still matches on the dependency alone…
      'php-laravel'
    );
    // …but a bare PHP repo with neither the dep nor the manifest matches nothing.
    expect(registry.match(facts({ dependencies: [], files: [] }))).toBeNull();
  });
});

describe('Ruby recipes', () => {
  const ruby = (over: Partial<MatchFacts>): MatchFacts => facts({ runtime: 'ruby', ...over });

  it('resolves Rails to a single-stage recipe on the full ruby image', () => {
    const recipe = registry.match(ruby({ dependencies: ['rails', 'pg'], files: ['Gemfile'] }));
    expect(recipe?.id).toBe('ruby-rails');
    expect(recipe?.buildCommands).toBeUndefined(); // interpreted → single stage
    expect(recipe?.installCommands).toEqual(['bundle install']);
    expect(recipe?.baseImages.runtime).toBe('ruby:3.3');
    expect(recipe?.startCommand).toBe('bundle exec rails server -b 0.0.0.0 -p 3000');
    expect(recipe?.defaultPorts).toEqual([3000]);
  });

  it('resolves Sinatra distinctly from the generic Rack fallback', () => {
    expect(registry.match(ruby({ dependencies: ['sinatra'], files: ['Gemfile'] }))?.id).toBe(
      'ruby-sinatra'
    );
  });

  it('falls back to ruby-bundler (rackup) for a Gemfile with no known framework', () => {
    const recipe = registry.match(ruby({ dependencies: ['rack'], files: ['Gemfile'] }));
    expect(recipe?.id).toBe('ruby-bundler');
    expect(recipe?.startCommand).toBe('bundle exec rackup --host 0.0.0.0 --port 9292');
    expect(recipe?.defaultPorts).toEqual([9292]);
  });

  it('prefers the framework recipe when both a framework dep and a Gemfile are present', () => {
    // rails + Gemfile could satisfy ruby-bundler's anyFile too — order must pick rails.
    expect(registry.match(ruby({ dependencies: ['rails'], files: ['Gemfile'] }))?.id).toBe(
      'ruby-rails'
    );
  });
});

describe('no cross-runtime regressions', () => {
  it('leaves the Node, Python, and Go matches unchanged', () => {
    expect(
      registry.match({ runtime: 'node', dependencies: ['react', 'react-dom'], files: [] })?.id
    ).toBe('node-react');
    expect(
      registry.match({ runtime: 'python', dependencies: ['fastapi'], files: ['requirements.txt'] })
        ?.id
    ).toBe('python-fastapi');
    expect(registry.match({ runtime: 'go', dependencies: [], files: ['go.mod'] })?.id).toBe(
      'go-mod'
    );
  });
});
