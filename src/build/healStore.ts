/**
 * Persistent store for learned self-heal overrides (Phase F). When a build is repaired by
 * the self-heal loop, the healed generated-file contents are saved here keyed by the
 * repo's signature, so the NEXT run of the same repo starts from the healed config
 * instead of re-discovering the fix (and re-paying for the AI heal). This is the missing
 * Phase F exit criterion: "learned recipe overrides keyed by repo signature."
 *
 * STORAGE (reviewed): a single JSON file under ORCA's home dir (default `~/.orca`,
 * overridable via `ORCA_HOME`), written atomically (temp file + rename). Chosen over a
 * database because the project ships no DB, the data is one small record per repo, and a
 * plain file keeps the store trivially inspectable and testable against a temp dir.
 *
 * The persisted unit is the WHOLE healed file contents (mirroring how `selfHeal` applies
 * patches and `writeConfigs` writes files); the recipe-fingerprint guard on the record is
 * what protects against re-applying a fix captured against a since-changed recipe.
 *
 * SECURITY: applying an override reuses `selfHeal`'s exact allowlist/path-safety, so a
 * stored override can only ever overwrite files ORCA itself generated — never repo source.
 *
 * PHASE: F (recipe-aware self-heal) — REAL code. STAGE: 5 (build).
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { packageVersion } from '../cli/version.js';
import type { GeneratedFile, RunContext } from '../core/context.js';
import { readFileIfExists } from '../utils/fs.js';
import { containsDangerousDirective, resolveAllowedRealPath } from './selfHeal.js';
import type { RepoShape } from './repoSignature.js';

/** Current on-disk schema version. Bumped only on a breaking record-shape change. */
const STORE_VERSION = 1;
const STORE_FILE = 'heal-overrides.json';

/** One generated file the heal changed: its failing content and the healed content. */
export interface OverrideFile {
  path: string;
  /** The `GeneratedFile['kind']` of this file (dockerfile/compose/env/…). */
  kind: string;
  /** The freshly-generated (failing) content, captured before any heal. */
  original: string;
  /** The healed content that produced a working build. */
  healed: string;
}

/** A learned override for one repo signature. */
export interface HealOverrideRecord {
  version: typeof STORE_VERSION;
  /** The repo signature (store key). */
  signature: string;
  /** Normalized repo identity, for readability. */
  repoId: string;
  /** Shape descriptors, copied from the run that learned the fix. */
  languages: string[];
  frameworks: string[];
  /** The invalidation guard: a mismatch on retrieval means the repo changed shape. */
  recipeFingerprint: string[];
  /** The healed files (original + healed contents). */
  files: OverrideFile[];
  /** Which generated files/steps the heal changed. */
  changedSteps: string[];
  /** Plain-English summary of the fix(es), for the audit trail. */
  explanation: string;
  createdAt: string;
  /** ORCA version that learned the fix, for future migration/expiry decisions. */
  orcaVersion: string;
}

interface StoreFile {
  version: number;
  records: Record<string, HealOverrideRecord>;
}

/** Every element of `value` is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** One `OverrideFile` entry, shaped as `applyLearnedOverride` needs to consume it. */
function isOverrideFile(value: unknown): value is OverrideFile {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Partial<OverrideFile>;
  return (
    typeof f.path === 'string' &&
    f.path !== '' &&
    typeof f.kind === 'string' &&
    typeof f.original === 'string' &&
    typeof f.healed === 'string'
  );
}

/**
 * A stored record, validated field by field before anything reads it.
 *
 * This exists because the store is a file on the user's disk that ORCA later trusts
 * enough to write into a Dockerfile it then builds. Parsing it with `as
 * HealOverrideRecord` asserted a shape that nothing had checked, so a hand-edited,
 * partially-written, or version-skewed file became a crash (a missing array read for
 * `.length`) rather than a miss. Only the fields ORCA actually consumes are required —
 * this is a load-bearing guard, not a schema for its own sake.
 */
function isHealOverrideRecord(value: unknown): value is HealOverrideRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<HealOverrideRecord>;
  return (
    r.version === STORE_VERSION &&
    typeof r.signature === 'string' &&
    typeof r.repoId === 'string' &&
    isStringArray(r.languages) &&
    isStringArray(r.frameworks) &&
    isStringArray(r.recipeFingerprint) &&
    isStringArray(r.changedSteps) &&
    typeof r.explanation === 'string' &&
    Array.isArray(r.files) &&
    r.files.every(isOverrideFile)
  );
}

/** Resolve ORCA's home dir: `$ORCA_HOME` when set, else `~/.orca`. */
export function resolveOrcaHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['ORCA_HOME'];
  return explicit !== undefined && explicit.trim() !== '' ? explicit : join(homedir(), '.orca');
}

/**
 * A JSON-file-backed store of learned overrides. Every method reads the file fresh so a
 * store constructed in a later run (or process) sees writes from an earlier one — that
 * cross-run persistence IS the feature.
 */
export class HealOverrideStore {
  private readonly filePath: string;

  /**
   * Serializes mutations (`save`/`evict`) issued against THIS store instance. Each
   * mutation is an independent read-modify-write of the whole file; without this, two
   * overlapping calls on the same instance (e.g. concurrent heal loops in one process)
   * could both read the pre-mutation file, and whichever writes last would silently
   * discard the other's change. This only serializes within one process/instance — it
   * is not a cross-process file lock — but that is the concurrency this class can
   * actually see and control.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string = resolveOrcaHome()) {
    this.filePath = join(dir, STORE_FILE);
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // A failed mutation must not wedge the queue for whatever comes after it.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async read(): Promise<StoreFile> {
    const empty: StoreFile = { version: STORE_VERSION, records: {} };
    const raw = await readFileIfExists(this.filePath);
    if (raw === null) return empty;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return empty;
      const store = parsed as Partial<StoreFile>;
      // A version bump or a corrupt file resets rather than throwing — a stale cache must
      // never break a build.
      if (store.version !== STORE_VERSION) return empty;
      const records = store.records;
      if (typeof records !== 'object' || records === null || Array.isArray(records)) return empty;

      // EVERY RECORD IS VALIDATED, not just the file envelope. The envelope check alone
      // was the bug: a syntactically valid file holding a record missing
      // `recipeFingerprint` sailed through here, and `overrideMatchesShape` then read
      // `.length` off undefined and threw — killing a run whose stack had ALREADY built.
      // "A stale cache must never break a build" has to mean the records too.
      const valid: Record<string, HealOverrideRecord> = {};
      for (const [signature, record] of Object.entries(records)) {
        if (isHealOverrideRecord(record)) valid[signature] = record;
      }
      return { version: STORE_VERSION, records: valid };
    } catch {
      return empty;
    }
  }

  private async write(store: StoreFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Atomic replace: never leave a half-written store behind.
    const tmp = join(this.dir, `${STORE_FILE}.${process.pid}.tmp`);
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
  }

  /** The override stored for `signature`, or null if none. */
  async lookup(signature: string): Promise<HealOverrideRecord | null> {
    return (await this.read()).records[signature] ?? null;
  }

  /** Persist (or replace) the override for its signature. */
  async save(record: HealOverrideRecord): Promise<void> {
    return this.mutate(async () => {
      const store = await this.read();
      store.records[record.signature] = record;
      await this.write(store);
    });
  }

  /** Remove the override for `signature` if present (a no-op otherwise). */
  async evict(signature: string): Promise<void> {
    return this.mutate(async () => {
      const store = await this.read();
      if (store.records[signature] === undefined) return;
      delete store.records[signature];
      await this.write(store);
    });
  }
}

/** True when a stored override still matches the current run's recipe shape. */
export function overrideMatchesShape(record: HealOverrideRecord, shape: RepoShape): boolean {
  return sameStrings(record.recipeFingerprint, shape.recipeFingerprint);
}

/** Snapshot the current on-disk contents of every generated file (the "original"). */
export async function snapshotGeneratedFiles(ctx: RunContext): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const file of ctx.generatedFiles) {
    const contents = await readFileIfExists(join(ctx.workspaceDir, file.path));
    if (contents !== null) snapshot.set(file.path, contents);
  }
  return snapshot;
}

/**
 * Overwrite the generated files with a stored override's healed contents. Reuses
 * `resolveAllowedRealPath` so an override can only ever touch ORCA-generated files, and
 * `containsDangerousDirective` so its CONTENTS are held to the same bar as a live patch.
 * Returns the paths actually applied.
 *
 * The content check is the half that was missing. A live heal patch is scanned for
 * privilege-escalating directives before it is written, but a stored override replayed
 * the same kind of model-generated text straight onto a Dockerfile ORCA then builds —
 * with the scan skipped, purely because the text arrived from disk rather than from the
 * model this run. Time-of-storage is not a trust upgrade: the file is editable, and the
 * content is untrusted either way.
 */
export async function applyLearnedOverride(
  ctx: RunContext,
  record: HealOverrideRecord
): Promise<string[]> {
  const allowlist = new Set(ctx.generatedFiles.map((f) => f.path));
  const applied: string[] = [];
  for (const file of record.files) {
    const abs = await resolveAllowedRealPath(ctx.workspaceDir, file.path, allowlist);
    if (abs === null) continue; // silently skip anything not on the generated allowlist
    if (containsDangerousDirective(file.healed)) {
      ctx.logger.warn(
        `Skipped a stored heal override for '${file.path}' — it contains a ` +
          `privilege-escalating directive. The override is discarded rather than replayed.`
      );
      continue;
    }
    await writeFile(abs, file.healed, 'utf8');
    applied.push(file.path);
  }
  return applied;
}

/**
 * Build the record to persist after a successful heal: the union of files the heal
 * touched, each with its snapshotted original and its final healed content.
 */
export async function buildOverrideRecord(
  ctx: RunContext,
  signature: string,
  shape: RepoShape,
  snapshot: Map<string, string>
): Promise<HealOverrideRecord> {
  const changedSteps = [...new Set(ctx.diagnosis.flatMap((d) => d.changedFiles))];
  const byPath = new Map<string, GeneratedFile>(ctx.generatedFiles.map((f) => [f.path, f]));
  const files: OverrideFile[] = [];
  for (const path of changedSteps) {
    const healed = await readFileIfExists(join(ctx.workspaceDir, path));
    if (healed === null) continue;
    files.push({
      path,
      kind: byPath.get(path)?.kind ?? 'unknown',
      original: snapshot.get(path) ?? '',
      healed,
    });
  }
  return {
    version: STORE_VERSION,
    signature,
    repoId: shape.repoId,
    languages: shape.languages,
    frameworks: shape.frameworks,
    recipeFingerprint: shape.recipeFingerprint,
    files,
    changedSteps,
    explanation: ctx.diagnosis
      .map((d) => d.fix)
      .filter((s) => s !== '')
      .join(' '),
    createdAt: new Date().toISOString(),
    orcaVersion: packageVersion(),
  };
}

/** Order-independent string-set equality (both inputs are already sorted in practice). */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
