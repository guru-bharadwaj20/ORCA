/**
 * The self-healing retry loop. On a failed attempt it asks the LLM to diagnose the
 * error and propose a patch, applies the patch, records a plain-English diagnosis
 * entry, and retries — up to `maxHealAttempts` (default 3). Headline feature.
 *
 * STAGE: 5 (build) — self-heal. REAL code.
 * Inputs: a `RunContext` (project dir, options, cost ledger, diagnosis log).
 * Outputs: the final `AttemptResult`; appends a `DiagnosisEntry` per heal attempt.
 *
 * SECURITY INVARIANT (code-enforced, not prompt-enforced): a heal patch may only
 * touch files ORCA itself generated (`ctx.generatedFiles`). Every patch path is
 * canonicalized against the workspace root; traversal attempts and application
 * source files are rejected here regardless of what the model claims. Patch
 * *contents* are additionally scanned for privilege-escalating directives
 * (privileged mode, host networking/PID/IPC namespaces, cap_add, host root bind
 * mounts) and rejected outright — see `containsDangerousDirective` below.
 */

import { lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ai } from '../ai/client.js';
import { buildHealPrompt, type HealRecipeContext } from '../ai/prompts/heal.js';
import { HealSuggestionSchema, type HealSuggestion } from '../ai/schema.js';
import type { DiagnosisEntry, RunContext } from '../core/context.js';
import { HealExhaustedError } from '../utils/errors.js';
import { readFileIfExists } from '../utils/fs.js';
import { toDiagnosisEntry } from './diagnosisLog.js';
import { runOnce, type AttemptResult } from './runner.js';

const ERROR_EXCERPT_CHARS = 600;

function excerpt(errorOutput: string): string {
  const trimmed = errorOutput.trim();
  return trimmed.length > ERROR_EXCERPT_CHARS
    ? `...${trimmed.slice(-ERROR_EXCERPT_CHARS)}`
    : trimmed;
}

/**
 * A heal patch's target *path* is allowlisted, but its *contents* are otherwise an
 * unconstrained model-generated string (unlike the initial-fill schema, which validates
 * every field). Since a patch can rewrite `docker-compose.yml`/Dockerfiles that ORCA
 * then `docker compose up`s with no further human review, reject any patch whose
 * contents would grant container-escape-adjacent privileges — these directives have no
 * legitimate role in fixing a build/run failure.
 */
const DANGEROUS_PATCH_PATTERNS: readonly RegExp[] = [
  /privileged\s*:\s*true/i,
  /network_mode\s*:\s*["']?host/i,
  /pid\s*:\s*["']?host/i,
  /ipc\s*:\s*["']?host/i,
  /cap_add\s*:/i,
  /security_opt\s*:/i,
  /devices\s*:/i,
  /^\s*-\s*["']?\/(?::|$)/m, // bind-mounting the host root filesystem
];

/**
 * Compose keys that grant container-escape-adjacent privileges. Checked STRUCTURALLY
 * (after YAML parsing) rather than by matching source text, so the spelling of the
 * document cannot hide them.
 */
const DANGEROUS_KEYS = new Set([
  'privileged',
  'cap_add',
  'security_opt',
  'devices',
  'network_mode',
  'pid',
  'ipc',
  'userns_mode',
  'cgroup_parent',
]);

/** Values of `network_mode`/`pid`/`ipc` that share a host namespace. */
const HOST_NAMESPACE = /^(?:host|container:)/i;

/** A volume entry that bind-mounts the host root (or the Docker socket) into the image. */
function isDangerousVolume(value: unknown): boolean {
  if (typeof value === 'string') {
    const source = value.split(':')[0]?.trim() ?? '';
    return (
      source === '/' || source === '/var/run/docker.sock' || source === '//var/run/docker.sock'
    );
  }
  if (typeof value === 'object' && value !== null) {
    const source = (value as { source?: unknown }).source;
    return typeof source === 'string' && (source === '/' || source.endsWith('docker.sock'));
  }
  return false;
}

/** True when this key/value pair grants a privilege self-heal may never introduce. */
function isDangerousEntry(key: string, value: unknown): boolean {
  const name = key.toLowerCase();
  if (name === 'volumes' && Array.isArray(value)) return value.some(isDangerousVolume);
  if (!DANGEROUS_KEYS.has(name)) return false;
  if (name === 'privileged') return value === true || value === 'true';
  if (name === 'network_mode' || name === 'pid' || name === 'ipc') {
    return typeof value === 'string' && HOST_NAMESPACE.test(value.trim());
  }
  // cap_add / security_opt / devices / userns_mode / cgroup_parent: presence with any
  // content is enough — none of them has a legitimate role in fixing a build failure.
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}

/** Walk a parsed YAML document looking for a dangerous key anywhere in it. */
function hasDangerousNode(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasDangerousNode);
  if (typeof node !== 'object' || node === null) return false;
  for (const [key, value] of Object.entries(node)) {
    if (isDangerousEntry(key, value)) return true;
    if (hasDangerousNode(value)) return true;
  }
  return false;
}

/**
 * Reject patch contents that would grant container-escape-adjacent privileges.
 *
 * TWO PASSES, because one is not sound on its own. The regex list catches Dockerfiles and
 * anything that does not parse as YAML. The STRUCTURAL pass parses compose documents and
 * inspects the resulting object, which is what closes the spellings a text scan cannot
 * see: YAML resolves anchors and aliases before this runs, so the classic bypass
 * (`x-evil: &a true` … `privileged: *a`) arrives here as a plain `privileged: true`, and
 * flow style (`{privileged: true}`), quoting, and odd indentation all normalize away too.
 *
 * A document that fails to parse is NOT treated as safe — the regex pass still applies,
 * which is the honest fallback for a Dockerfile (never valid YAML in the useful sense).
 *
 * Exported so the Phase-F learned-override applier holds REPLAYED patch contents to this
 * same bar. An override is model-generated text that ORCA writes into a Dockerfile and
 * builds; that it arrived from disk rather than from this run's model is not a reason to
 * trust it more.
 */
export function containsDangerousDirective(contents: string): boolean {
  if (DANGEROUS_PATCH_PATTERNS.some((pattern) => pattern.test(contents))) return true;
  try {
    return hasDangerousNode(parseYaml(contents));
  } catch {
    // Not YAML (a Dockerfile, most likely). The regex pass above was the check.
    return false;
  }
}

/**
 * Canonicalize a patch path against the workspace root and check it against the
 * allowlist. Returns the absolute path to write, or null when the patch must be
 * rejected (escapes the workspace, or targets a file ORCA did not generate).
 *
 * Exported so the Phase-F learned-override applier reuses this exact path-safety when it
 * writes stored healed contents back — an override is held to the same "generated files
 * only" invariant as a live heal patch.
 */
export function resolveAllowedPath(
  workspaceDir: string,
  file: string,
  allowlist: ReadonlySet<string>
): string | null {
  const abs = resolve(workspaceDir, file);
  const rel = relative(workspaceDir, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return allowlist.has(rel.split(sep).join('/')) ? abs : null;
}

/**
 * `resolveAllowedPath` plus symlink checks on the real filesystem — for the leaf AND for
 * every directory above it.
 *
 * `resolve()` is purely LEXICAL — it cannot see that an allowed path is a symlink whose
 * target sits outside the workspace. Since this function guards where LLM-proposed
 * patches may be written, a repo that ships a symlink at a name ORCA later generates
 * would otherwise redirect a write out of the workspace. Rejecting symlinked targets
 * outright is safe here: every allowlisted path is a file ORCA itself generated, so a
 * symlink at that name is never legitimate.
 *
 * THE LEAF CHECK ALONE WAS NOT ENOUGH. `lstat` on the full path resolves every DIRECTORY
 * component before it looks at the last one, so a repo shipping `sub/` as a symlink to
 * somewhere outside the workspace passed cleanly whenever the generated file was
 * `sub/Dockerfile` — the exact escape the leaf check was written to stop, one level up.
 * The parent is therefore canonicalized with `realpath` and re-checked for containment
 * against the canonicalized workspace, which also handles a workspace that is itself
 * reached through a symlink (a macOS `/tmp` -> `/private/tmp` checkout).
 */
export async function resolveAllowedRealPath(
  workspaceDir: string,
  file: string,
  allowlist: ReadonlySet<string>
): Promise<string | null> {
  const abs = resolveAllowedPath(workspaceDir, file, allowlist);
  if (abs === null) return null;

  // Canonicalize the PARENT (the leaf may legitimately not exist yet) and confirm the
  // real location still sits inside the real workspace.
  try {
    const realRoot = await realpath(workspaceDir);
    const realParent = await realpath(dirname(abs));
    const rel = relative(realRoot, realParent);
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return null;
  } catch {
    // The parent directory does not exist. Nothing can be written through it either, so
    // let the write itself fail rather than inventing a verdict here.
    return null;
  }

  try {
    const stats = await lstat(abs);
    if (stats.isSymbolicLink()) return null;
  } catch {
    // Missing is fine — the patch is creating a file ORCA declared but has not written.
  }
  return abs;
}

/**
 * Recipe context for any synthesized ecosystem/inferred services in the plan, so the
 * healer keeps a Go/Rust/inferred Dockerfile fix faithful to its runtime and commands.
 * Empty for pure seed-stack runs (whose Dockerfiles come from templates, not recipes).
 */
function healRecipeContext(ctx: RunContext): HealRecipeContext[] {
  const recipes: HealRecipeContext[] = [];
  for (const node of ctx.plan?.services ?? []) {
    if (node.source.type !== 'build' || node.source.recipe === undefined) continue;
    const { recipe } = node.source;
    recipes.push({
      serviceId: node.id,
      runtime: recipe.runtime,
      recipeId: recipe.id,
      installCommands: recipe.installCommands,
      buildCommands: recipe.buildCommands ?? [],
      startCommand: recipe.startCommand,
    });
  }
  return recipes;
}

/** Current contents of every generated file, for the heal prompt's grounding. */
async function readGeneratedFiles(ctx: RunContext): Promise<{ path: string; contents: string }[]> {
  const files: { path: string; contents: string }[] = [];
  for (const generated of ctx.generatedFiles) {
    const contents = await readFileIfExists(join(ctx.workspaceDir, generated.path));
    if (contents !== null) files.push({ path: generated.path, contents });
  }
  return files;
}

/** Apply the allowed subset of a suggestion's patches; returns what was written. */
async function applyPatches(
  ctx: RunContext,
  suggestion: HealSuggestion,
  allowlist: ReadonlySet<string>
): Promise<{ applied: string[]; rejected: string[] }> {
  const applied: string[] = [];
  const rejected: string[] = [];
  for (const patch of suggestion.patches) {
    const abs = await resolveAllowedRealPath(ctx.workspaceDir, patch.file, allowlist);
    if (abs === null) {
      rejected.push(patch.file);
      ctx.logger.warn(
        `Rejected heal patch for '${patch.file}' — only ORCA-generated files may be patched.`
      );
      continue;
    }
    if (containsDangerousDirective(patch.contents)) {
      rejected.push(patch.file);
      ctx.logger.warn(
        `Rejected heal patch for '${patch.file}' — proposed contents include a ` +
          `privilege-escalating directive (e.g. privileged/host-network/cap_add/host ` +
          `bind mount), which self-heal is never allowed to introduce.`
      );
      continue;
    }
    await writeFile(abs, patch.contents, 'utf8');
    applied.push(patch.file);
  }
  return { applied, rejected };
}

/**
 * Loop: runOnce -> on failure ask the AI to heal -> apply allowed patches -> retry.
 * `maxHealAttempts` bounds the number of HEALS, so the stack is attempted at most
 * `maxHealAttempts + 1` times. Throws `HealExhaustedError` when out of options.
 */
export async function runSelfHealLoop(ctx: RunContext): Promise<AttemptResult> {
  const allowlist: ReadonlySet<string> = new Set(ctx.generatedFiles.map((f) => f.path));
  const maxHeals = ctx.options.maxHealAttempts;
  let lastEntry: DiagnosisEntry | null = null;

  const signal = ctx.options.signal;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    ctx.logger.info(`Build/run attempt ${attempt} ...`);
    const result = await runOnce(ctx.workspaceDir, signal);
    if (result.ok) {
      // The previous heal is what made this attempt pass — mark it resolved.
      if (lastEntry !== null) lastEntry.resolved = true;
      return result;
    }

    const errorOutput = result.errorOutput ?? '';
    ctx.logger.warn(`Attempt ${attempt} failed during ${result.phase}.`);
    if (attempt > maxHeals) {
      throw new HealExhaustedError(
        `Self-heal gave up after ${maxHeals} fix attempt(s). ` +
          `Last failure (${result.phase}): ${excerpt(errorOutput)}`
      );
    }

    // Don't spend an AI heal call on a run that was cancelled mid-build.
    signal?.throwIfAborted();

    let suggestion: HealSuggestion;
    try {
      // Run-scoped facade when the pipeline provided one (--model / --cost-cap).
      const client = ctx.ai ?? ai;
      suggestion = await client.complete(
        buildHealPrompt(
          errorOutput,
          await readGeneratedFiles(ctx),
          attempt,
          healRecipeContext(ctx)
        ),
        HealSuggestionSchema,
        ctx.cost,
        { schemaName: 'HealSuggestion' }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HealExhaustedError(
        `Build failed and self-heal is unavailable (${message}). ` +
          `Failure (${result.phase}): ${excerpt(errorOutput)}`
      );
    }

    if (suggestion.patches.length === 0) {
      ctx.diagnosis.push(toDiagnosisEntry(attempt, errorOutput, suggestion, false));
      throw new HealExhaustedError(
        `Self-heal judged this failure unfixable by config changes: ${suggestion.explanation}`
      );
    }

    const { applied, rejected } = await applyPatches(ctx, suggestion, allowlist);
    // The diagnosis records only what was actually written, not what was proposed.
    lastEntry = toDiagnosisEntry(
      attempt,
      errorOutput,
      { ...suggestion, patches: suggestion.patches.filter((p) => applied.includes(p.file)) },
      false
    );
    ctx.diagnosis.push(lastEntry);

    if (applied.length === 0) {
      throw new HealExhaustedError(
        `Self-heal only proposed patches outside ORCA-generated files ` +
          `(${rejected.join(', ')}); refusing to modify application source.`
      );
    }
    ctx.logger.info(`Heal #${attempt}: ${suggestion.explanation}`);
    ctx.logger.info(`Fix applied: ${suggestion.fix}`, { changed: applied.join(', ') });
  }
}
