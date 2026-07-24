/**
 * Build recovery: fold every source that DECLARES how a repo is built into one ranked,
 * provenance-carrying answer (docs/universal-understanding-plan.md §3, §5 Phase C).
 *
 * Four sources declare build/run commands today, and until now all four were dead ends —
 * they populated `insights` and were printed by `logInsights`, but nothing downstream
 * read them, so a repo's own declared commands never reached the plan:
 *
 *   - `insights.ciCommands`     — GitHub Actions `run:` steps
 *   - `insights.ciProviders`    — GitLab CI / Azure Pipelines / CircleCI jobs
 *   - `insights.taskCommands`   — Makefile / Taskfile / justfile / package scripts
 *   - `insights.scriptSources`  — README fenced-shell blocks and shipped `*.sh`
 *
 * This module is the missing consumer. It normalizes all four into `RecoveredCommand`s
 * that keep their ORIGIN, ranks them by the weight their source family already carries
 * in the confidence model, and emits an ordinary evidence-backed `Claim` — the same
 * shape every other detector produces, so recovery explains itself like everything else.
 *
 * PROVIDERS ARE UNIFORM. `ciProviders` is walked as data: the `provider` field is a
 * label inside the provenance string, never a branch. Adding a fifth CI provider means
 * the parser writes into `ciProviders` and this module needs no edit at all.
 *
 * STAGE: 2 (detect) — REAL code. Pure functions over `RepoInsights`. No AI, no IO.
 */

import { claim, type Claim, type Evidence } from '../model/claim.js';
import type { BuildRecipe } from '../model/recipe.js';
import type { RepoInsights } from './types.js';

/** The families a recovered command can come from, ordered most-authoritative-first. */
export type RecoverySource = 'ci' | 'task' | 'script';

/**
 * Confidence weight per source family. These are the SAME numbers `confidenceEvidence`
 * already uses, exported here so there is one definition rather than two that drift:
 * CI is the maintainer's executable build (it runs on every push), a task runner is
 * their declared entrypoint, and a README is the weakest — prose that merely describes.
 */
export const RECOVERY_WEIGHTS: Record<RecoverySource, number> = {
  ci: 0.2,
  task: 0.2,
  script: 0.15,
};

/** Ranking order between families when two of them declare the same kind of command. */
const SOURCE_PRIORITY: RecoverySource[] = ['ci', 'task', 'script'];

/** One command a repo declares about itself, with enough provenance to cite the file. */
export interface RecoveredCommand {
  command: string;
  /** Intent, as classified by `ci.ts`'s shared `classifyCommand`. */
  kind: string;
  /** Which family declared it, used for ranking and weighting. */
  source: RecoverySource;
  /**
   * Human-readable provenance, e.g. `gitlab:.gitlab-ci.yml#build_app`,
   * `github-actions`, `makefile:build`, `README.md`. Surfaced on the plan node so a
   * command can be traced back to the file that declared it.
   */
  origin: string;
  /** Container image the declaring job named, when it named one (CI jobs usually do). */
  image?: string;
}

/** The build/run shape recovered from a repo's own declarations. */
export interface RecoveredBuild {
  installCommands: string[];
  buildCommands: string[];
  /** The single best start command, or null when nothing declared one. */
  startCommand: string | null;
  /** The first image any declaring source named, or null. */
  image: string | null;
  /** Every recovered command, ranked, with provenance retained. */
  commands: RecoveredCommand[];
  /** Distinct origins that contributed, for the plan node's provenance trail. */
  origins: string[];
}

/** Strip a directory prefix so provenance cites `.gitlab-ci.yml`, not an absolute path. */
function fileLabel(file: string): string {
  const posix = file.replace(/\\/g, '/');
  return posix.slice(posix.lastIndexOf('/') + 1);
}

/**
 * Every CI-declared command across BOTH CI shapes, uniformly. GitHub Actions arrives
 * pre-flattened in `ciCommands`; the other providers keep their job structure in
 * `ciProviders`. Neither is special-cased beyond that difference in shape — the provider
 * name is data that lands in the provenance string.
 */
function fromCi(insights: RepoInsights): RecoveredCommand[] {
  const out: RecoveredCommand[] = [];

  for (const c of insights.ciCommands) {
    out.push({ command: c.command, kind: c.kind, source: 'ci', origin: 'github-actions' });
  }

  for (const config of insights.ciProviders) {
    const label = fileLabel(config.file);
    for (const job of config.jobs) {
      const image = job.image ?? config.image ?? undefined;
      for (const c of job.commands) {
        out.push({
          command: c.command,
          kind: c.kind,
          source: 'ci',
          origin: `${config.provider}:${label}#${job.name}`,
          ...(image !== undefined && image !== null ? { image } : {}),
        });
      }
    }
  }

  return out;
}

/** Maintainer-declared tasks (Makefile / Taskfile / justfile / package scripts). */
function fromTasks(insights: RepoInsights): RecoveredCommand[] {
  return insights.taskCommands
    .filter((t) => t.command.trim() !== '')
    .map((t) => ({
      command: t.command,
      kind: t.kind,
      source: 'task' as const,
      origin: `${t.source}:${t.name}`,
    }));
}

/** README fenced-shell blocks and shipped shell scripts. */
function fromScripts(insights: RepoInsights): RecoveredCommand[] {
  const out: RecoveredCommand[] = [];
  for (const s of insights.scriptSources) {
    for (const c of s.commands) {
      out.push({ command: c.command, kind: c.kind, source: 'script', origin: s.file });
    }
  }
  return out;
}

/**
 * Commands that describe CI/CD INFRASTRUCTURE rather than how the application is built.
 *
 * This filter is not optional polish — without it the feature is actively harmful. A CI
 * file's most common "build" step is `docker build -t app .`, which `classifyCommand`
 * quite correctly labels `build`: it just isn't a build of the *app*, it is a build of
 * the container ORCA is already building. Copying it into the generated Dockerfile emits
 * `RUN docker build …` inside the image, which cannot work — there is no Docker CLI or
 * daemon in there. The same goes for deployment tooling: `kubectl`, `helm`, `terraform`,
 * and cloud CLIs act on infrastructure, never on the artifact.
 */
const INFRA_COMMAND =
  /^(?:sudo\s+)?(?:docker|docker-compose|kubectl|helm|terraform|aws|gcloud|az|heroku|flyctl|vercel|netlify|serverless|gh|git)\b/i;

/**
 * References to variables only the CI runner defines — GitLab `$CI_*`, GitHub
 * `${{ … }}`, Azure `$(Build.*)`/`$(System.*)`. A command carrying one is meaningless
 * outside its runner: copied into a Dockerfile the token either expands to empty or is
 * taken literally, so the command silently does the wrong thing.
 */
const CI_ONLY_VARIABLE = /\$\{\{|\$CI_|\$\{CI_|\$GITHUB_|\$\{GITHUB_|\$\(Build\.|\$\(System\./;

/** True when a command is about the app itself, not the pipeline that ships it. */
function isAppCommand(command: string): boolean {
  return !INFRA_COMMAND.test(command.trim()) && !CI_ONLY_VARIABLE.test(command);
}

/**
 * Commands of one kind from the HIGHEST-PRIORITY family that declares any, deduplicated.
 *
 * Exclusive by family on purpose. CI, a Makefile, and a README are alternative
 * expressions of the same intent, not stages of one pipeline — a repo whose CI runs
 * `go build ./cmd/api` and whose Makefile runs `make build` needs one of them, not both
 * concatenated into the image.
 */
function ofKind(commands: readonly RecoveredCommand[], kind: string): RecoveredCommand[] {
  for (const source of SOURCE_PRIORITY) {
    const picked: RecoveredCommand[] = [];
    const seen = new Set<string>();
    for (const c of commands) {
      if (c.source !== source || c.kind !== kind || seen.has(c.command)) continue;
      seen.add(c.command);
      picked.push(c);
    }
    if (picked.length > 0) return picked;
  }
  return [];
}

/**
 * Recover the build/run shape a repo declares about itself, as a `Claim`.
 *
 * Returns null when nothing declared anything actionable — a repo with no CI, no task
 * runner, and no parseable README leaves the matched recipe entirely alone rather than
 * producing an empty recovery that callers must special-case.
 */
export function recoverBuild(insights: RepoInsights): Claim<RecoveredBuild> | null {
  const commands = [...fromCi(insights), ...fromTasks(insights), ...fromScripts(insights)].filter(
    (c) => isAppCommand(c.command)
  );
  if (commands.length === 0) return null;

  const installs = ofKind(commands, 'install');
  const builds = ofKind(commands, 'build');
  const starts = ofKind(commands, 'start');

  // Nothing that changes how the repo is built — `test`/`other` alone is not a recovery.
  if (installs.length === 0 && builds.length === 0 && starts.length === 0) return null;

  // Two different sets, and the distinction matters:
  //   `selected`  — the commands actually used, exclusive by family (§ `ofKind`).
  //   `declaring` — every family that declared an actionable command at all.
  // Provenance comes from `selected` (cite what we run), but CONFIDENCE comes from
  // `declaring`: a repo whose CI, Makefile, and README all describe the same build is
  // better understood than one with only a README, and §4 makes cross-source agreement
  // the strongest signal there is. Scoring only the winner would throw that away.
  const selected = [...installs, ...builds, ...starts];
  const declaring = commands.filter(
    (c) => c.kind === 'install' || c.kind === 'build' || c.kind === 'start'
  );
  const origins = [...new Set(selected.map((c) => c.origin))];

  // One evidence entry per contributing family, weighted as that family already is, so
  // independent sources agreeing raises confidence exactly like any other cross-tier
  // agreement (§4) rather than through a bespoke rule.
  const evidence: Evidence[] = [];
  for (const source of SOURCE_PRIORITY) {
    const mine = declaring.filter((c) => c.source === source);
    if (mine.length === 0) continue;
    const cited = [...new Set(mine.map((c) => c.origin))].join(', ');
    evidence.push({
      detector: `build-recovery:${source}`,
      signal: `${source} declares the build (${mine.length} command(s) from ${cited})`,
      weight: RECOVERY_WEIGHTS[source],
    });
  }

  const value: RecoveredBuild = {
    installCommands: installs.map((c) => c.command),
    buildCommands: builds.map((c) => c.command),
    startCommand: starts[0]?.command ?? null,
    image: selected.find((c) => c.image !== undefined)?.image ?? null,
    commands: selected,
    origins,
  };

  // `'ci'` whenever CI contributed — it is the strongest family and the one the
  // `ClaimSource` taxonomy already names; otherwise this is ordinary static analysis.
  const source = declaring.some((c) => c.source === 'ci') ? 'ci' : 'deterministic';
  return claim(value, evidence, source);
}

/** A recipe with recovered commands applied, plus the origins that supplied them. */
export interface RecipeWithProvenance {
  recipe: BuildRecipe;
  /** Distinct origins that actually changed something; empty when nothing was applied. */
  origins: string[];
}

/**
 * Overlay a repo's recovered commands onto a matched recipe.
 *
 * PRECEDENCE — the whole point of this function, so it is spelled out:
 *
 *   1. A **Dockerfile-derived** recipe is never touched. That recipe already *is* the
 *      repo's own declared build, read from a tier-1 source; CI is tier 2 and must not
 *      second-guess it. Callers signal this with `fromDockerfile`.
 *   2. `buildCommands` and `startCommand` move as an ATOMIC PAIR, or not at all. They
 *      are coupled: the build produces the artifact the start command runs. Taking CI's
 *      `go build ./...` while keeping the recipe's `CMD /app/server` yields an image that
 *      builds fine and then dies at runtime, because `go build ./...` writes no binary to
 *      that path. So the pair is replaced only when recovery supplies BOTH halves;
 *      when it supplies one, that half is used only to fill a gap the recipe left empty.
 *      Within that rule, recovered commands still win over recipe defaults (§5 Phase C) —
 *      a registry recipe's commands are a sensible guess, a command the maintainer
 *      actually runs is a fact.
 *   3. `installCommands` are only FILLED IN, never replaced. A recipe's install step is
 *      tied to its base image and lockfile handling (`npm ci` needs a lockfile in the
 *      image, `uv sync` needs uv installed); a CI runner's install assumes a prepared
 *      environment ORCA's image may not have. Replacing it breaks more than it fixes.
 *   4. A recovered `image` fills a BLANK base image only. CI images (`cimg/node:20.10`)
 *      are runner images, not runtime bases — using one to replace a working base image
 *      would be a regression, but it is strictly better than the empty string an
 *      AI-inferred recipe can carry.
 *
 * Returns the recipe unchanged with empty `origins` when there is nothing to apply, so
 * the caller can tell "recovered" from "left alone" without comparing objects.
 */
export function applyRecoveredBuild(
  recipe: BuildRecipe,
  recovered: RepoInsights['recoveredBuild'],
  options: { fromDockerfile?: boolean } = {}
): RecipeWithProvenance {
  if (recovered === null || options.fromDockerfile === true) return { recipe, origins: [] };

  const originOf = (command: string): string | undefined =>
    recovered.commands.find((c) => c.command === command)?.origin;
  const origins = new Set<string>();
  const next: BuildRecipe = { ...recipe };

  const take = (command: string): void => {
    const origin = originOf(command);
    if (origin !== undefined) origins.add(origin);
  };

  // The coupled pair. Both halves recovered → replace both, so build and start stay
  // consistent with each other. Only one half → fill the recipe's gap if it has one,
  // otherwise leave its coherent pair alone (see rule 2 above).
  const hasBuild = recovered.buildCommands.length > 0;
  const hasStart = recovered.startCommand !== null;

  if (hasBuild && hasStart) {
    next.buildCommands = [...recovered.buildCommands];
    next.startCommand = recovered.startCommand as string;
    for (const c of recovered.buildCommands) take(c);
    take(recovered.startCommand as string);
  } else if (hasBuild && (recipe.buildCommands?.length ?? 0) === 0) {
    next.buildCommands = [...recovered.buildCommands];
    for (const c of recovered.buildCommands) take(c);
  } else if (hasStart && recipe.startCommand.trim() === '') {
    next.startCommand = recovered.startCommand as string;
    take(recovered.startCommand as string);
  }

  if (recipe.installCommands.length === 0 && recovered.installCommands.length > 0) {
    next.installCommands = [...recovered.installCommands];
    for (const c of recovered.installCommands) {
      const origin = originOf(c);
      if (origin !== undefined) origins.add(origin);
    }
  }

  if (recovered.image !== null && recipe.baseImages.build.trim() === '') {
    next.baseImages = { ...recipe.baseImages, build: recovered.image };
    origins.add(`image:${recovered.image}`);
  }

  return origins.size === 0 ? { recipe, origins: [] } : { recipe: next, origins: [...origins] };
}
