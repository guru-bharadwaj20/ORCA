/**
 * PHASE B tests — the data-driven framework signature table. Verifies the open
 * taxonomy: meta-frameworks outrank their base library, Go module-path prefixes
 * match, and each runtime resolves its frameworks without any bespoke code.
 */
import { describe, expect, it } from 'vitest';

import { matchFrameworks, type FrameworkFacts } from '../../src/detect/frameworkSignatures.js';

const facts = (over: Partial<FrameworkFacts>): FrameworkFacts => ({
  runtime: 'node',
  dependencies: [],
  files: [],
  ...over,
});

describe('matchFrameworks', () => {
  it('prefers Next.js over React when both are present (meta-framework wins)', () => {
    const matches = matchFrameworks(
      facts({ runtime: 'node', dependencies: ['next', 'react', 'react-dom'] })
    );
    expect(matches[0]?.id).toBe('nextjs');
    // React still matches — the aggregator sees both — but ranks lower.
    expect(matches.map((m) => m.id)).toContain('react');
  });

  it('records the concrete markers that justified a match', () => {
    const [match] = matchFrameworks(facts({ runtime: 'node', dependencies: ['@nestjs/core'] }));
    expect(match?.id).toBe('nestjs');
    expect(match?.markers).toContain('@nestjs/core');
  });

  it('matches Go frameworks by module-path prefix', () => {
    const matches = matchFrameworks(
      facts({ runtime: 'go', dependencies: ['github.com/gin-gonic/gin', 'github.com/spf13/viper'] })
    );
    expect(matches.map((m) => m.id)).toEqual(['gin']);
  });

  it('detects Python web frameworks distinctly', () => {
    expect(matchFrameworks(facts({ runtime: 'python', dependencies: ['fastapi'] }))[0]?.id).toBe(
      'fastapi'
    );
    expect(matchFrameworks(facts({ runtime: 'python', dependencies: ['flask'] }))[0]?.id).toBe(
      'flask'
    );
    expect(
      matchFrameworks(facts({ runtime: 'python', dependencies: ['streamlit'] }))[0]?.role
    ).toBe('data-app');
  });

  it('detects Spring Boot on the JVM', () => {
    expect(
      matchFrameworks(facts({ runtime: 'jvm', dependencies: ['spring-boot-starter-web'] }))[0]?.id
    ).toBe('spring-boot');
  });

  it('respects the runtime boundary — a Node dep never matches a Python framework', () => {
    expect(matchFrameworks(facts({ runtime: 'node', dependencies: ['flask'] }))).toEqual([]);
  });

  it('returns empty when nothing matches', () => {
    expect(matchFrameworks(facts({ runtime: 'rust', dependencies: ['serde'] }))).toEqual([]);
  });

  it('does not false-positive on hyphenated look-alikes (flask-cors ≠ flask)', () => {
    expect(matchFrameworks(facts({ runtime: 'python', dependencies: ['flask-cors'] }))).toEqual([]);
    expect(matchFrameworks(facts({ runtime: 'node', dependencies: ['next-auth'] }))).toEqual([]);
  });

  it('matches Spring starter subtrees and Go module version suffixes', () => {
    expect(
      matchFrameworks(facts({ runtime: 'jvm', dependencies: ['spring-boot-starter-web'] }))[0]?.id
    ).toBe('spring-boot');
    expect(
      matchFrameworks(facts({ runtime: 'go', dependencies: ['github.com/gin-gonic/gin/v2'] }))[0]
        ?.id
    ).toBe('gin');
  });

  it('matches .NET namespace prefixes (Microsoft.AspNetCore.Mvc → aspnet)', () => {
    expect(
      matchFrameworks(facts({ runtime: 'dotnet', dependencies: ['Microsoft.AspNetCore.Mvc'] }))[0]
        ?.id
    ).toBe('aspnet');
  });

  it('matches the other Go frameworks by module path, including versioned suffixes', () => {
    expect(
      matchFrameworks(facts({ runtime: 'go', dependencies: ['github.com/labstack/echo/v4'] }))[0]
        ?.id
    ).toBe('echo');
    expect(
      matchFrameworks(facts({ runtime: 'go', dependencies: ['github.com/gofiber/fiber/v2'] }))[0]
        ?.id
    ).toBe('fiber');
  });

  it('does not false-match a Go package that merely contains a framework name', () => {
    // `echo` must match the labstack module path, not any package with "echo" in it.
    expect(
      matchFrameworks(facts({ runtime: 'go', dependencies: ['github.com/acme/echoproxy'] }))
    ).toEqual([]);
  });

  it('resolves the Ruby frameworks by gem name', () => {
    expect(matchFrameworks(facts({ runtime: 'ruby', dependencies: ['rails'] }))[0]?.id).toBe(
      'rails'
    );
    expect(matchFrameworks(facts({ runtime: 'ruby', dependencies: ['sinatra'] }))[0]?.id).toBe(
      'sinatra'
    );
  });

  it('resolves the PHP frameworks by composer package', () => {
    expect(
      matchFrameworks(facts({ runtime: 'php', dependencies: ['laravel/framework'] }))[0]?.id
    ).toBe('laravel');
    expect(
      matchFrameworks(facts({ runtime: 'php', dependencies: ['symfony/framework-bundle'] }))[0]?.id
    ).toBe('symfony');
  });

  it('resolves the remaining Node meta-frameworks (nuxt, sveltekit)', () => {
    expect(matchFrameworks(facts({ runtime: 'node', dependencies: ['nuxt'] }))[0]?.id).toBe('nuxt');
    expect(
      matchFrameworks(facts({ runtime: 'node', dependencies: ['@sveltejs/kit'] }))[0]?.id
    ).toBe('sveltekit');
  });
});
