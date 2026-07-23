/**
 * PHASE B tests — dependency readers for Go/Rust/JVM/.NET manifests. Each reads real
 * files from a temp dir and returns bare dependency names/paths for the framework
 * signature table. Malformed/absent manifests yield [] (a detection signal, not a crash).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readDotnetDependencies,
  readGoDependencies,
  readJvmDependencies,
  readRustDependencies,
} from '../../src/detect/manifestExt.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-mext-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readGoDependencies', () => {
  it('parses the require block and strips versions', async () => {
    await writeFile(
      join(dir, 'go.mod'),
      [
        'module example.com/app',
        '',
        'go 1.23',
        '',
        'require (',
        '\tgithub.com/gin-gonic/gin v1.9.1',
        '\tgithub.com/spf13/viper v1.18.0',
        ')',
      ].join('\n')
    );
    const deps = await readGoDependencies(dir);
    expect(deps).toContain('github.com/gin-gonic/gin');
    expect(deps).toContain('github.com/spf13/viper');
    expect(deps.every((d) => !d.includes('v1.'))).toBe(true);
  });

  it('parses the single-line require form', async () => {
    await writeFile(join(dir, 'go.mod'), 'module m\nrequire github.com/labstack/echo/v4 v4.11.0\n');
    expect(await readGoDependencies(dir)).toEqual(['github.com/labstack/echo/v4']);
  });

  it('returns [] when absent', async () => {
    expect(await readGoDependencies(dir)).toEqual([]);
  });
});

describe('readRustDependencies', () => {
  it('reads [dependencies] and [dev-dependencies] tables', async () => {
    await writeFile(
      join(dir, 'Cargo.toml'),
      [
        '[package]',
        'name = "app"',
        '',
        '[dependencies]',
        'serde = "1.0"',
        'tokio = { version = "1", features = ["full"] }',
        '',
        '[dev-dependencies]',
        'criterion = "0.5"',
      ].join('\n')
    );
    const deps = await readRustDependencies(dir);
    expect(deps).toEqual(expect.arrayContaining(['serde', 'tokio', 'criterion']));
    expect(deps).not.toContain('name'); // package-table key must not leak in
  });
});

describe('readJvmDependencies', () => {
  it('extracts Maven artifactIds including spring-boot starters', async () => {
    await writeFile(
      join(dir, 'pom.xml'),
      '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>'
    );
    expect(await readJvmDependencies(dir)).toContain('spring-boot-starter-web');
  });

  it('extracts Gradle coordinates', async () => {
    await writeFile(
      join(dir, 'build.gradle'),
      "dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web:3.2.0'\n}"
    );
    const deps = await readJvmDependencies(dir);
    expect(deps).toContain('spring-boot-starter-web');
    expect(deps).toContain('org.springframework.boot');
  });
});

describe('readDotnetDependencies', () => {
  it('reads PackageReference includes from a .csproj', async () => {
    await writeFile(
      join(dir, 'App.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="8.0.0" /></ItemGroup></Project>'
    );
    expect(await readDotnetDependencies(dir)).toContain(
      'Microsoft.AspNetCore.Components.WebAssembly'
    );
  });

  it('returns [] when no csproj exists', async () => {
    expect(await readDotnetDependencies(dir)).toEqual([]);
  });
});
