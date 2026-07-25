/**
 * The registry of sources that DECLARE how a repo is built (§3, §5 Phase C).
 *
 * `RepoInsights` grew one parallel array per signal source, and every consumer had to
 * learn each new field — `buildRecovery.ts` exists precisely because four of them were
 * dead ends nothing read. This module is the extension point that stops the growth: a
 * source is a DESCRIPTOR, and recovery is a fold over the registry. Adding one means
 * appending a `SignalSource` here, not editing `recoverBuild`, not editing any consumer.
 *
 * WHY A DESCRIPTOR AND NOT THREE PARALLEL TABLES. Until now a source family was spelled
 * out three times — a `RecoverySource` union, a `RECOVERY_WEIGHTS` record, and a
 * `SOURCE_PRIORITY` array. TypeScript checks the first two (a `Record<Union, number>` is
 * exhaustive) but NOT the third: `SOURCE_PRIORITY` is an ordinary array, so forgetting a
 * family there compiles cleanly and silently drops it from ranking — its commands are
 * collected, weighted, and then never selected. One descriptor carrying its own `weight`
 * and `rank` makes that failure unrepresentable.
 *
 * FAMILIES ARE EXCLUSIVE, WHICH IS WHY `rank` EXISTS. CI, a Makefile, and a README are
 * alternative expressions of the same intent, not stages of one pipeline, so `ofKind`
 * takes commands from the best-ranked family that declares any (see `buildRecovery.ts`).
 * `rank` is that order; `weight` is separately how much the family's agreement is worth
 * to confidence. They are different questions and deliberately different fields.
 *
 * STAGE: 2 (detect) — REAL code. Pure functions over `RepoInsights`. No AI, no IO.
 */

import type { RepoInsights } from './types.js';

/**
 * One command a repo declares about itself, normalized across sources and carrying
 * enough provenance to cite the file it came from.
 */
export interface DeclaredCommand {
  command: string;
  /** Intent, as classified by `ci.ts`'s shared `classifyCommand`. */
  kind: string;
  /**
   * Human-readable provenance, e.g. `gitlab:.gitlab-ci.yml#build_app`,
   * `github-actions`, `makefile:build`, `README.md`. Surfaced on the plan node so a
   * command can be traced back to the file that declared it.
   */
  origin: string;
  /** Container image the declaring job named, when it named one (CI jobs usually do). */
  image?: string;
}

/** A family of declarations, and how to pull it out of the assembled insights. */
export interface SignalSource {
  /**
   * Stable family id. Appears in evidence (`build-recovery:<id>`) and on every
   * `RecoveredCommand` this source produces, so it is part of the output contract.
   */
  id: string;
  /**
   * Confidence weight for "this family declared the build". Independent families
   * agreeing raises confidence through the ordinary probabilistic-OR combination (§4),
   * not through a bespoke rule.
   */
  weight: number;
  /** Ranking order between families; LOWER wins when two declare the same kind. */
  rank: number;
  /**
   * Pull this family's declarations out of the assembled insights. Pure: no IO, no
   * mutation of the argument. Return `[]` when the family declared nothing.
   */
  extract(insights: RepoInsights): DeclaredCommand[];
}

/**
 * The registered signal sources for a run.
 *
 * Keyed by `id`, so re-registering the same id REPLACES rather than duplicates — a test
 * (or a future caller) can swap one family's extractor without rebuilding the set.
 */
export class SignalSourceRegistry {
  private readonly sources = new Map<string, SignalSource>();

  /** Add or replace a source. Returns `this` so registration chains. */
  register(source: SignalSource): this {
    this.sources.set(source.id, source);
    return this;
  }

  /**
   * Every source, most-authoritative first. Ties break on `id` so the order is total and
   * stable — two sources sharing a rank must still fold in a deterministic order, or the
   * recovered commands (and the golden output downstream) would depend on registration
   * order.
   */
  all(): readonly SignalSource[] {
    return [...this.sources.values()].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  }

  /** The source registered under `id`, or undefined. */
  get(id: string): SignalSource | undefined {
    return this.sources.get(id);
  }

  /** The confidence weight for a family, or 0 when nothing is registered under `id`. */
  weightOf(id: string): number {
    return this.sources.get(id)?.weight ?? 0;
  }
}

/** Strip a directory prefix so provenance cites `.gitlab-ci.yml`, not an absolute path. */
function fileLabel(file: string): string {
  const posix = file.replace(/\\/g, '/');
  return posix.slice(posix.lastIndexOf('/') + 1);
}

/**
 * CI is the maintainer's EXECUTABLE build — it runs on every push, so it is the most
 * authoritative statement of how the repo is built.
 *
 * Both CI shapes fold in here as ONE family, deliberately. GitHub Actions arrives
 * pre-flattened in `ciCommands` while the other providers keep their job structure in
 * `ciProviders`, but that is a difference in shape, not in authority: a repo's GitLab
 * pipeline and its Actions workflow are not two corroborating opinions to be scored
 * separately, they are the same claim. Splitting them would both double-count confidence
 * and make the two shapes compete for exclusivity.
 *
 * PROVIDERS ARE DATA. `config.provider` is a label inside the provenance string, never a
 * branch — adding a fifth provider means the parser writes into `ciProviders` and this
 * function needs no edit at all.
 */
const ciSource: SignalSource = {
  id: 'ci',
  weight: 0.2,
  rank: 0,
  extract(insights) {
    const out: DeclaredCommand[] = [];

    for (const c of insights.ciCommands) {
      out.push({ command: c.command, kind: c.kind, origin: 'github-actions' });
    }

    for (const config of insights.ciProviders) {
      const label = fileLabel(config.file);
      for (const job of config.jobs) {
        const image = job.image ?? config.image ?? undefined;
        for (const c of job.commands) {
          out.push({
            command: c.command,
            kind: c.kind,
            origin: `${config.provider}:${label}#${job.name}`,
            ...(image !== undefined && image !== null ? { image } : {}),
          });
        }
      }
    }

    return out;
  },
};

/**
 * Maintainer-declared tasks (Makefile / Taskfile / justfile / package scripts) — their
 * own entrypoints, declared but not necessarily executed by CI.
 *
 * RUNNERS ARE DATA, the same line `ciProviders` holds for providers: `task.source` is a
 * label in the provenance string, so adding a runner means `taskRunners.ts` recognizes
 * one more file and nothing here changes.
 */
const taskSource: SignalSource = {
  id: 'task',
  weight: 0.2,
  rank: 1,
  extract(insights) {
    return insights.taskCommands
      .filter((t) => t.command.trim() !== '')
      .map((t) => ({ command: t.command, kind: t.kind, origin: `${t.source}:${t.name}` }));
  },
};

/**
 * README fenced-shell blocks and shipped shell scripts — the weakest family, because
 * prose merely DESCRIBES a build where the other two declare one that runs.
 */
const scriptSource: SignalSource = {
  id: 'script',
  weight: 0.15,
  rank: 2,
  extract(insights) {
    const out: DeclaredCommand[] = [];
    for (const s of insights.scriptSources) {
      for (const c of s.commands) {
        out.push({ command: c.command, kind: c.kind, origin: s.file });
      }
    }
    return out;
  },
};

/** The sources shipped by default, in authority order: CI, then tasks, then prose. */
export function defaultSignalSources(): SignalSourceRegistry {
  return new SignalSourceRegistry().register(ciSource).register(taskSource).register(scriptSource);
}

/**
 * Confidence weights for the default families, exported so `confidenceEvidence` scores
 * CI and README corroboration with the SAME numbers recovery uses rather than repeating
 * the literals — they were duplicated before, which is exactly how two tables drift.
 *
 * Read off the descriptors rather than re-declared, so the two can no longer disagree.
 * Typed with the concrete keys (not `Record<string, number>`) so callers get a plain
 * `number` under `noUncheckedIndexedAccess` instead of `number | undefined`.
 */
export const DEFAULT_SOURCE_WEIGHTS: Readonly<{ ci: number; task: number; script: number }> =
  Object.freeze({
    ci: ciSource.weight,
    task: taskSource.weight,
    script: scriptSource.weight,
  });
