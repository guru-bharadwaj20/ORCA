/**
 * Phase-B ecosystem recipes: Go, Rust, JVM (Maven/Gradle), and .NET expressed as
 * DATA on the Phase-A `BuildRecipe` model. Adding a language here is the entire cost
 * of supporting it deterministically — no new control flow, no template files. These
 * are appended to the seed set via `RecipeRegistry.register`.
 *
 * PHASE: B (widen deterministic detection) — REAL code. Multi-stage `baseImages`
 * (compiler → slim runtime) are chosen so the synthesizer (Phase E) emits small
 * production images by default.
 */

import type { RecipeEntry } from '../recipe.js';

/**
 * Compiled and managed-runtime ecosystems as recipes. `{{binary}}` / `{{jar}}` /
 * `{{dll}}` are placeholders the synthesizer fills from detection (crate name, the
 * built artifact path). Ordered most-specific-first is unnecessary here — each
 * matches a distinct runtime — but they follow the seed set in registration order.
 *
 * Python web frameworks (FastAPI/Flask) live in `./python.ts`, matched per lockfile
 * (uv/Poetry/pip); they are deliberately NOT duplicated here.
 */
export const ECOSYSTEM_RECIPES: readonly RecipeEntry[] = [
  {
    matcher: { runtime: 'go', anyFile: ['go.mod'] },
    recipe: {
      id: 'go-mod',
      runtime: 'go',
      dependencyFiles: ['go.mod', 'go.sum'],
      installCommands: ['go mod download'],
      buildCommands: ['go build -o /app/server ./...'],
      startCommand: '/app/server',
      defaultPorts: [8080],
      baseImages: { build: 'golang:1.23', runtime: 'gcr.io/distroless/base-debian12' },
    },
  },
  {
    matcher: { runtime: 'rust', anyFile: ['Cargo.toml'] },
    recipe: {
      id: 'rust-cargo',
      runtime: 'rust',
      dependencyFiles: ['Cargo.toml', 'Cargo.lock'],
      installCommands: ['cargo fetch'],
      buildCommands: ['cargo build --release'],
      startCommand: './target/release/{{binary}}',
      defaultPorts: [8080],
      baseImages: { build: 'rust:1-slim', runtime: 'debian:bookworm-slim' },
    },
  },
  {
    matcher: { runtime: 'jvm', anyFile: ['pom.xml'] },
    recipe: {
      id: 'jvm-maven',
      runtime: 'jvm',
      dependencyFiles: ['pom.xml'],
      installCommands: ['mvn -B dependency:go-offline'],
      buildCommands: ['mvn -B package -DskipTests'],
      startCommand: 'java -jar target/{{jar}}',
      defaultPorts: [8080],
      baseImages: { build: 'maven:3.9-eclipse-temurin-21', runtime: 'eclipse-temurin:21-jre' },
    },
  },
  {
    matcher: { runtime: 'jvm', anyFile: ['build.gradle', 'build.gradle.kts'] },
    recipe: {
      id: 'jvm-gradle',
      runtime: 'jvm',
      dependencyFiles: ['build.gradle', 'build.gradle.kts', 'settings.gradle'],
      installCommands: ['gradle dependencies --no-daemon'],
      buildCommands: ['gradle bootJar --no-daemon -x test'],
      startCommand: 'java -jar build/libs/{{jar}}',
      defaultPorts: [8080],
      baseImages: { build: 'gradle:8-jdk21', runtime: 'eclipse-temurin:21-jre' },
    },
  },
  {
    // A project or solution file is the universal .NET signal; `global.json` is optional
    // (SDK pinning) and only sometimes present, so match by extension.
    matcher: { runtime: 'dotnet', anySuffix: ['.csproj', '.sln'] },
    recipe: {
      id: 'dotnet-sdk',
      runtime: 'dotnet',
      dependencyFiles: ['*.csproj', '*.sln'],
      installCommands: ['dotnet restore'],
      buildCommands: ['dotnet publish -c Release -o /app/out'],
      startCommand: 'dotnet /app/out/{{dll}}',
      defaultPorts: [8080],
      baseImages: {
        build: 'mcr.microsoft.com/dotnet/sdk:8.0',
        runtime: 'mcr.microsoft.com/dotnet/aspnet:8.0',
      },
    },
  },
];
