/**
 * Orchestrates every stage end-to-end: clone -> detect -> fill templates (AI) ->
 * build plan -> review/approve -> generate configs -> build/run with self-heal.
 *
 * STAGE: core (drives all stages) — REAL code.
 * Inputs: a `RunContext` (repo URL + options + logger) and optional injectable IO
 * streams for the review gate / previews (tests drive the gate through these).
 * Outputs: a resolved `RunContext` with detection, plan, generated files, and the
 * self-heal diagnosis populated; throws `OrcaError`s on unsupported stacks,
 * rejection, and unrecoverable failure.
 *
 * `--dry-run` renders the docker-compose.yml + Dockerfiles in memory and prints them
 * WITHOUT writing anything. A full run writes the configs into the temp workspace,
 * then builds/starts the stack with the explainable self-heal loop; on success the
 * workspace is kept alive (the running stack lives there), on any failure the stack
 * is torn down and the workspace removed.
 *
 * AI is optional by design: with no API key (or if every fill attempt fails) the plan
 * falls back to the deterministic registry defaults — ORCA stays useful keyless
 * (though a failed build cannot self-heal without a key).
 */

import { join } from 'node:path';

import { ai, aiFor } from '../ai/client.js';
import { fillTemplate } from '../ai/fillTemplate.js';
import { inferEnv } from '../ai/inferEnv.js';
import { AIRouter, defaultProviderFactories, routerConfigForRun } from '../ai/router.js';
import type { FilledTemplateVars, InferredEnv } from '../ai/schema.js';
import { assertDockerAvailable, composeDown } from '../build/docker.js';
import { formatDiagnosisLog } from '../build/diagnosisLog.js';
import { runSelfHealLoop } from '../build/selfHeal.js';
import {
  cleanupWorkspace,
  cloneRepo,
  createWorkspace,
  type Workspace,
} from '../clone/workspace.js';
import { ENV_KEYS, type KeyResolver } from '../config/settings.js';
import { detectStack } from '../detect/index.js';
import type { DetectedComponent, DetectionResult } from '../detect/types.js';
import { planToComposeVars } from '../generate/composeVars.js';
import { writeConfigs } from '../generate/writeConfigs.js';
import { buildEnvFile } from '../orchestrate/envFiles.js';
import { reviewPlan, type ReviewIO, type ReviewOutcome } from '../plan/review.js';
import { buildServicePlan, refinedComponentVars } from '../plan/servicePlan.js';
import type { ServicePlan } from '../plan/types.js';
import { describeComponent } from '../templates/registry.js';
import { renderCompose, renderDockerfile } from '../templates/render.js';
import { OrcaError, PlanRejectedError, UnsupportedStackError } from '../utils/errors.js';
import { readFileIfExists } from '../utils/fs.js';
import type { Logger, RunContext } from './context.js';

/** Injectable IO for the review gate and the --dry-run preview (defaults to the TTY). */
export interface PipelineIO extends ReviewIO {
  /**
   * Optional approval hook. When provided it fully owns the approval decision,
   * replacing the default `reviewPlan` gate — an embedder (the VS Code webview)
   * wires its Approve/Reject panel here. A disposed panel must reject/return a
   * rejected `ReviewOutcome` so the pipeline takes its normal rejection path.
   */
  approvePlan?: (plan: ServicePlan) => Promise<ReviewOutcome>;
}

/** The component roles the pipeline fills and renders, in plan order. */
const COMPONENT_ROLES = ['backend', 'frontend'] as const;
type ComponentRole = (typeof COMPONENT_ROLES)[number];

function componentFor(detection: DetectionResult, role: ComponentRole): DetectedComponent | null {
  return role === 'backend' ? detection.backend : detection.frontend;
}

/** True when at least one configured provider has a key — AI refinement is possible. */
function aiKeyPresent(resolveKey: KeyResolver): boolean {
  return Boolean(resolveKey(ENV_KEYS.qwenApiKey) || resolveKey(ENV_KEYS.apiKey));
}

/** The repo README text used to ground the AI fill ('' when there is none). */
async function readReadme(repoDir: string): Promise<string> {
  for (const name of ['README.md', 'readme.md', 'README']) {
    const text = await readFileIfExists(join(repoDir, name));
    if (text !== null) return text;
  }
  return '';
}

/**
 * STAGE 3: fill template vars per component via the AI router. Every failure mode
 * (no key, provider errors, cost cap) degrades to the registry defaults with a
 * warning — the AI refines the plan, it is never required to produce one.
 */
async function fillComponents(
  detection: DetectionResult,
  ctx: RunContext,
  readme: string
): Promise<Record<string, FilledTemplateVars>> {
  const filled: Record<string, FilledTemplateVars> = {};
  const client = ctx.ai ?? ai;
  for (const role of COMPONENT_ROLES) {
    const component = componentFor(detection, role);
    if (component === null) continue;
    try {
      filled[role] = await fillTemplate(
        detection,
        describeComponent(component),
        readme,
        ctx.cost,
        client
      );
      ctx.logger.info(`AI refined the ${role} template vars.`);
    } catch (err) {
      const code = err instanceof OrcaError ? err.code : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`AI fill for ${role} failed — falling back to template defaults.`, {
        code,
        message,
      });
    }
  }
  return filled;
}

/**
 * STAGE 3: infer the app's own env vars (secrets, tuning) for the generated .env.
 * Purely additive — any failure just means no .env, never a failed run.
 */
async function inferAppEnv(
  detection: DetectionResult,
  ctx: RunContext,
  readme: string
): Promise<InferredEnv | null> {
  const client = ctx.ai ?? ai;
  try {
    const inferred = await inferEnv(detection, readme, ctx.cost, client);
    ctx.logger.info(`AI inferred ${inferred.variables.length} app env var(s).`);
    return inferred;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.warn('Env inference failed — continuing without a generated .env.', { message });
    return null;
  }
}

/** Render the compose file + every to-be-built Dockerfile in memory (no writes). */
function renderPreview(
  detection: DetectionResult,
  plan: ServicePlan,
  filled: Record<string, FilledTemplateVars>,
  inferred: InferredEnv | null
): string {
  const sections = [
    `# --- docker-compose.yml (preview) ---`,
    renderCompose(planToComposeVars(plan)).trimEnd(),
  ];

  if (inferred !== null) {
    const envText = buildEnvFile(inferred, plan);
    if (envText !== '') sections.push(`# --- .env (preview) ---`, envText.trimEnd());
  }

  for (const role of COMPONENT_ROLES) {
    const component = componentFor(detection, role);
    const node = plan.services.find((s) => s.id === role);
    if (component === null || node === undefined || node.source.type !== 'build') continue;
    sections.push(
      `# --- ${node.source.context}/${node.source.dockerfile} (${role}, preview) ---`,
      renderDockerfile(refinedComponentVars(component, role, filled)).trimEnd()
    );
  }

  return `${sections.join('\n\n')}\n`;
}

/** The end-of-run success summary: URLs, heal log, and how to stop the stack. */
function renderSuccess(ctx: RunContext): string {
  const plan = ctx.plan;
  const lines = ['', 'Stack is up ✔', ''];
  for (const node of plan?.services ?? []) {
    for (const port of node.ports) {
      if (node.kind === 'frontend' || node.kind === 'backend') {
        lines.push(`  ${node.name} → http://localhost:${port.host}`);
      }
    }
  }
  const healLog = formatDiagnosisLog(ctx.diagnosis);
  if (healLog !== '') lines.push('', healLog.trimEnd());
  lines.push(
    '',
    `Workspace: ${ctx.workspaceDir}`,
    'Stop the stack with: docker compose down   (run inside the workspace)',
    ''
  );
  return lines.join('\n');
}

/** Log the run's LLM spend (with the per-provider breakdown when there was any). */
function logCost(cost: RunContext['cost'], logger: Logger): void {
  if (cost.estimatedUsd === 0) return;
  const byProvider = Object.entries(cost.byProvider ?? {})
    .map(([name, usage]) => `${name} $${usage.estimatedUsd.toFixed(4)}`)
    .join(', ');
  logger.info(`LLM spend: $${cost.estimatedUsd.toFixed(4)}`, {
    ...(byProvider !== '' ? { byProvider } : {}),
  });
}

/**
 * Log the forward-looking Phase-B/C detection signals when present. Advisory context:
 * it never changes the run, but it makes ORCA's understanding of a repo visible —
 * frameworks and runtimes beyond the seed set, monorepo tooling, and what CI revealed.
 */
function logInsights(insights: DetectionResult['insights'], logger: Logger): void {
  if (insights.frameworks.length > 0 || insights.runtimes.length > 0) {
    logger.info('Detected stack signals.', {
      runtimes: insights.runtimes.join(', ') || 'none',
      frameworks: insights.frameworks.join(', ') || 'none',
    });
  }
  if (insights.monorepoTools.length > 0) {
    logger.info(`Monorepo detected: ${insights.monorepoTools.join(', ')}.`);
  }
  const ciBuild = insights.ciCommands.filter((c) => c.kind === 'build' || c.kind === 'start');
  if (ciBuild.length > 0) {
    logger.info(`CI reveals build commands: ${ciBuild.map((c) => c.command).join(' | ')}.`);
  }
  if (insights.ciRuntimeVersions.length > 0) {
    const versions = insights.ciRuntimeVersions.map((v) => `${v.runtime} ${v.version}`).join(', ');
    logger.info(`CI pins runtime versions: ${versions}.`);
  }
  const buildTasks = insights.taskCommands.filter((t) => t.kind === 'build' || t.kind === 'start');
  if (buildTasks.length > 0) {
    const shown = buildTasks.map((t) => `${t.source}:${t.name}`).join(', ');
    logger.info(`Maintainer tasks available: ${shown}.`);
  }
}

/**
 * Run the pipeline against `ctx.repoUrl`. When `ctx.workspaceDir` is already set
 * (tests, embedders) the clone step is skipped and that directory is used as-is;
 * otherwise the repo is cloned into a temp workspace the pipeline owns.
 */
export async function runPipeline(ctx: RunContext, io: PipelineIO = {}): Promise<RunContext> {
  const output = io.output ?? process.stdout;
  const signal = ctx.options.signal;
  let workspace: Workspace | null = null;
  let keepWorkspace = false;

  // Run-scoped AI: this run's --model / --cost-cap / cancel / BYOK-key resolution
  // apply to every AI call it makes.
  ctx.ai ??= aiFor(
    new AIRouter(
      routerConfigForRun({
        costCapUsd: ctx.options.costCapUsd,
        model: ctx.options.model,
        ...(signal !== undefined ? { signal } : {}),
      }),
      defaultProviderFactories(ctx.resolveKey)
    )
  );

  try {
    signal?.throwIfAborted();
    // STAGE 0/1: clone into an owned temp workspace (skipped when pre-materialized).
    if (ctx.workspaceDir === '') {
      workspace = await createWorkspace();
      ctx.logger.info(`Fetching ${ctx.repoUrl} ...`);
      ctx.workspaceDir = await cloneRepo(ctx.repoUrl, workspace, signal);
    }

    // STAGE 2: static detection.
    signal?.throwIfAborted();
    const detection = await detectStack(ctx.workspaceDir);
    ctx.detection = detection;
    for (const warning of detection.warnings) {
      ctx.logger.warn(warning.message, { detector: warning.detector });
    }
    ctx.logger.info('Detection complete.', {
      frontend: detection.frontend?.framework ?? null,
      backend: detection.backend?.framework ?? null,
      databases: detection.databases.map((db) => db.engine).join(', ') || 'none',
      confidence: detection.confidence,
    });
    // Surface the evidence model to the user: why this confidence, and what the
    // richer Phase-B/C detectors saw (frameworks, monorepo tooling, CI signals).
    if (detection.reasoning.length > 0) {
      ctx.logger.info(`Detection reasoning: ${detection.reasoning.join('; ')}.`);
    }
    logInsights(detection.insights, ctx.logger);
    if (!detection.isSupported) {
      throw new UnsupportedStackError(
        detection.warnings.map((w) => w.message).join(' ') ||
          'No supported stack detected in this repo.'
      );
    }

    // STAGE 3: AI fill + env inference (both degrade gracefully when keyless).
    signal?.throwIfAborted();
    let filled: Record<string, FilledTemplateVars> = {};
    let inferred: InferredEnv | null = null;
    if (aiKeyPresent(ctx.resolveKey)) {
      const readme = await readReadme(ctx.workspaceDir);
      filled = await fillComponents(detection, ctx, readme);
      inferred = await inferAppEnv(detection, ctx, readme);
    } else {
      ctx.logger.info(
        'No AI API key found (QWEN_API_KEY / ANTHROPIC_API_KEY) — using template defaults.'
      );
    }
    ctx.filled = filled;
    if (inferred !== null) ctx.inferredEnv = inferred;

    // STAGE 4: plan + approval gate. Nothing is built or written before approval.
    signal?.throwIfAborted();
    ctx.plan = buildServicePlan(detection, filled, inferred);
    // An embedder's approvePlan hook (e.g. the VS Code webview) owns the decision
    // when provided; otherwise the default reviewPlan gate runs.
    const outcome = io.approvePlan
      ? await io.approvePlan(ctx.plan)
      : await reviewPlan(ctx.plan, ctx.options, io);
    ctx.approved = outcome.approved;
    if (!outcome.approved) {
      throw new PlanRejectedError(outcome.reason ?? 'Plan rejected at the approval gate.');
    }

    if (ctx.options.dryRun) {
      output.write(renderPreview(detection, ctx.plan, filled, inferred));
      output.write('\nDry run complete — nothing was built, run, or written to disk.\n');
      logCost(ctx.cost, ctx.logger);
      return ctx;
    }

    // STAGE 5: generate configs into the workspace, then build/run with self-heal.
    signal?.throwIfAborted();
    await assertDockerAvailable(signal);
    const files = await writeConfigs(ctx);
    ctx.logger.info(`Generated ${files.length} file(s).`, {
      files: files.map((f) => f.path).join(', '),
    });

    try {
      const result = await runSelfHealLoop(ctx);
      ctx.logger.debug(`Stack came up (final phase: ${result.phase}).`);
    } catch (err) {
      // Best-effort teardown of any half-started stack before the workspace goes.
      // An abort tears down exactly like any other failure; the down itself is not
      // gated on the (already-aborted) signal so cleanup always runs.
      await composeDown(ctx.workspaceDir);
      throw err;
    }

    keepWorkspace = true; // the running stack lives here — don't delete it
    output.write(renderSuccess(ctx));
    logCost(ctx.cost, ctx.logger);
    return ctx;
  } finally {
    // A clone the pipeline made is disposable unless it now hosts a running stack.
    if (workspace !== null && !keepWorkspace) await cleanupWorkspace(workspace);
  }
}
