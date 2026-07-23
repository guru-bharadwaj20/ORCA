import { join } from 'node:path';

import { ai, aiFor } from '../ai/client.js';
import { fillTemplate } from '../ai/fillTemplate.js';
import { inferEnv } from '../ai/inferEnv.js';
import {
  AIRouter,
  defaultProviderFactories,
  routerConfigForRun,
  unroutableModelWarning,
} from '../ai/router.js';
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

export interface PipelineIO extends ReviewIO {
  approvePlan?: (plan: ServicePlan) => Promise<ReviewOutcome>;
}

const COMPONENT_ROLES = ['backend', 'frontend'] as const;
type ComponentRole = (typeof COMPONENT_ROLES)[number];

function componentFor(detection: DetectionResult, role: ComponentRole): DetectedComponent | null {
  return role === 'backend' ? detection.backend : detection.frontend;
}

function aiKeyPresent(resolveKey: KeyResolver): boolean {
  return Boolean(resolveKey(ENV_KEYS.qwenApiKey) || resolveKey(ENV_KEYS.apiKey));
}

async function readReadme(repoDir: string): Promise<string> {
  for (const name of ['README.md', 'readme.md', 'README']) {
    const text = await readFileIfExists(join(repoDir, name));
    if (text !== null) return text;
  }
  return '';
}

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

function logCost(cost: RunContext['cost'], logger: Logger): void {
  if (cost.estimatedUsd === 0) return;
  const byProvider = Object.entries(cost.byProvider ?? {})
    .map(([name, usage]) => `${name} $${usage.estimatedUsd.toFixed(4)}`)
    .join(', ');
  logger.info(`LLM spend: $${cost.estimatedUsd.toFixed(4)}`, {
    ...(byProvider !== '' ? { byProvider } : {}),
  });
}

export async function runPipeline(ctx: RunContext, io: PipelineIO = {}): Promise<RunContext> {
  const output = io.output ?? process.stdout;
  const signal = ctx.options.signal;
  let workspace: Workspace | null = null;
  let keepWorkspace = false;

  const modelWarning = unroutableModelWarning(ctx.options.model);
  if (modelWarning !== null) ctx.logger.warn(modelWarning);

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
    if (ctx.workspaceDir === '') {
      workspace = await createWorkspace();
      ctx.logger.info(`Fetching ${ctx.repoUrl} ...`);
      ctx.workspaceDir = await cloneRepo(ctx.repoUrl, workspace, signal);
    }

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
    if (!detection.isSupported) {
      throw new UnsupportedStackError(
        detection.warnings.map((w) => w.message).join(' ') ||
          'No supported stack detected in this repo.'
      );
    }

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

    signal?.throwIfAborted();
    ctx.plan = buildServicePlan(detection, filled, inferred);
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
      await composeDown(ctx.workspaceDir);
      throw err;
    }

    keepWorkspace = true;
    output.write(renderSuccess(ctx));
    logCost(ctx.cost, ctx.logger);
    return ctx;
  } finally {
    if (workspace !== null && !keepWorkspace) await cleanupWorkspace(workspace);
  }
}
