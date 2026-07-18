/**
 * ORCA VS Code extension.
 *
 * "ORCA: Preview Repo (Dry Run)" runs the pipeline in dry-run mode; "ORCA: Run Repo"
 * runs it for real (build + self-heal). Both pick a folder, build a RunContext (with
 * `orca.*` settings + SecretStorage keys applied), pause at a native plan-approval
 * webview, and stream logs + output into the ORCA output channel. The full run also
 * shows per-phase progress with a cancel button (wired to the pipeline's AbortSignal)
 * and, on success, a notification with service URLs.
 *
 * All the real work lives in `orca-agent-cli`; this file is only editor glue.
 */

import { Writable } from 'node:stream';

import type { Logger, RunContext } from 'orca-agent-cli';
import * as vscode from 'vscode';

import { approvePlanViaWebview } from './planWebview.js';
import { isAbortError, isPlanRejected, observeDiagnosis, serviceUrls, stopStack } from './run.js';
import {
  configuredProviderEnv,
  createSecretKeyResolver,
  readConfiguredOptions,
  setApiKey,
} from './settings.js';

// `orca-agent-cli` is ESM (and reads its `.hbs` templates relative to its own on-disk
// location), so it is kept external and loaded at runtime via dynamic import rather
// than bundled into this CommonJS extension.
type OrcaCli = typeof import('orca-agent-cli');
const loadOrca = (): Promise<OrcaCli> => import('orca-agent-cli');
const loadOrcaAi = (): Promise<typeof import('orca-agent-cli/ai')> => import('orca-agent-cli/ai');

/** Command ids, kept in sync with `contributes.commands` in package.json. */
const PREVIEW_COMMAND = 'orca.previewRepo';
const RUN_COMMAND = 'orca.runRepo';
const SET_API_KEY_COMMAND = 'orca.setApiKey';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('ORCA');
  context.subscriptions.push(
    channel,
    vscode.commands.registerCommand(PREVIEW_COMMAND, () => previewRepo(context, channel)),
    vscode.commands.registerCommand(RUN_COMMAND, () => runRepo(context, channel)),
    vscode.commands.registerCommand(SET_API_KEY_COMMAND, () => setApiKey(context))
  );
}

/**
 * Build a RunContext with all settings + secrets applied: RunOptions from explicitly-set
 * `orca.*` settings, keys resolved from SecretStorage, and a run-scoped AI facade whose
 * router honors the UI provider/model/cost settings (layered over env, so UI > env >
 * default). Shared by the preview command and (Phase 6) the full-run command.
 */
async function makeRunContext(
  context: vscode.ExtensionContext,
  params: { repoUrl: string; dryRun: boolean; logger: Logger; signal?: AbortSignal }
): Promise<RunContext> {
  const [core, ai] = await Promise.all([loadOrca(), loadOrcaAi()]);
  const resolveKey = await createSecretKeyResolver(context);
  const options = {
    dryRun: params.dryRun,
    ...readConfiguredOptions(),
    // The signal drives cancellation through clone/detect/docker/self-heal.
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  };

  const ctx = core.createRunContext({
    repoUrl: params.repoUrl,
    workspaceDir: '',
    logger: params.logger,
    options,
    resolveKey,
  });

  // Pre-build the run-scoped AI facade so UI provider/model/cost settings win. Provider
  // choices ride in on a synthetic env layered over process.env; model/cost/signal are
  // passed as explicit overrides.
  const env = { ...process.env, ...configuredProviderEnv() };
  const routerConfig = ai.routerConfigForRun(
    {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.costCapUsd !== undefined ? { costCapUsd: options.costCapUsd } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    },
    env
  );
  ctx.ai = ai.aiFor(new ai.AIRouter(routerConfig, ai.defaultProviderFactories(resolveKey)));
  return ctx;
}

export function deactivate(): void {
  /* nothing to tear down: the output channel is disposed via context.subscriptions */
}

/** Drive one dry-run preview of the chosen repo folder into the output channel. */
async function previewRepo(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel
): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) return; // user cancelled

  channel.clear();
  channel.show(true);
  channel.appendLine(`ORCA — preview (dry run)`);
  channel.appendLine(`Repo: ${folder}`);
  channel.appendLine('');

  try {
    const { runPipeline } = await loadOrca();
    const ctx = await makeRunContext(context, {
      repoUrl: folder,
      dryRun: true,
      logger: outputChannelLogger(channel),
    });
    // The real approval gate: pause at the plan and show the diagram/table webview.
    // The pipeline writes the plan summary + config preview to `io.output`, so point
    // that at the channel to show exactly what a real run would build.
    await runPipeline(ctx, {
      output: outputChannelWritable(channel),
      approvePlan: (plan) => approvePlanViaWebview(context, plan),
    });
    void vscode.window.showInformationMessage(
      'ORCA preview complete — see the ORCA output channel.'
    );
  } catch (err) {
    if (isPlanRejected(err)) {
      channel.appendLine('\nPlan rejected — nothing was previewed.');
      void vscode.window.showInformationMessage('ORCA plan rejected.');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n[error] ${message}`);
    void vscode.window.showErrorMessage(`ORCA preview failed: ${message}`);
  }
}

/**
 * The full run: build + start the stack with the explainable self-heal loop, shown as
 * per-phase progress with a cancel button. On success, offer the service URLs.
 */
async function runRepo(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel
): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) return; // user cancelled

  channel.clear();
  channel.show(true);
  channel.appendLine(`ORCA — run`);
  channel.appendLine(`Repo: ${folder}`);
  channel.appendLine('');

  const controller = new AbortController();
  try {
    const { runPipeline } = await loadOrca();
    const ctx = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ORCA: running…',
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        const runCtx = await makeRunContext(context, {
          repoUrl: folder,
          dryRun: false,
          logger: outputChannelLogger(channel, (message) => progress.report({ message })),
          signal: controller.signal,
        });
        // Render each self-heal attempt to the channel as the pipeline appends it.
        observeDiagnosis(runCtx, (linetext) => channel.appendLine(linetext));
        await runPipeline(runCtx, {
          output: outputChannelWritable(channel),
          approvePlan: (plan) => approvePlanViaWebview(context, plan),
        });
        return runCtx;
      }
    );
    await notifyStackUp(ctx, channel);
  } catch (err) {
    if (isAbortError(err)) {
      channel.appendLine('\nRun cancelled — the stack was torn down.');
      void vscode.window.showInformationMessage('ORCA run cancelled.');
      return;
    }
    if (isPlanRejected(err)) {
      channel.appendLine('\nPlan rejected — nothing was built.');
      void vscode.window.showInformationMessage('ORCA plan rejected.');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    channel.appendLine(`\n[error] ${message}`);
    void vscode.window.showErrorMessage(`ORCA run failed: ${message}`);
  }
}

/** Success notification: service URLs with Open-in-browser / Stop-stack actions. */
async function notifyStackUp(ctx: RunContext, channel: vscode.OutputChannel): Promise<void> {
  const urls = serviceUrls(ctx.plan);
  const OPEN = 'Open in browser';
  const STOP = 'Stop stack';
  const actions = urls.length > 0 ? [OPEN, STOP] : [STOP];
  const summary =
    urls.length > 0
      ? `ORCA: stack is up — ${urls.map((u) => u.url).join(', ')}`
      : 'ORCA: stack is up.';

  const choice = await vscode.window.showInformationMessage(summary, ...actions);
  if (choice === OPEN) {
    const target =
      urls.length === 1
        ? urls[0]
        : await vscode.window.showQuickPick(
            urls.map((u) => ({ label: u.name, description: u.url, url: u.url })),
            { placeHolder: 'Open which service?' }
          );
    if (target !== undefined) await vscode.env.openExternal(vscode.Uri.parse(target.url));
  } else if (choice === STOP) {
    channel.appendLine('\nStopping the stack (docker compose down)…');
    try {
      await stopStack(ctx.workspaceDir);
      channel.appendLine('Stack stopped.');
      void vscode.window.showInformationMessage('ORCA: stack stopped.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      channel.appendLine(`Failed to stop the stack: ${message}`);
      void vscode.window.showErrorMessage(
        'ORCA: failed to stop the stack — see the output channel.'
      );
    }
  }
}

/**
 * Choose the folder to preview: the workspace folder when there is exactly one, a
 * quick-pick when there are several, or an open dialog when no workspace is open.
 * Returns undefined when the user cancels.
 */
async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders !== undefined && folders.length === 1) {
    return folders[0]!.uri.fsPath;
  }
  if (folders !== undefined && folders.length > 1) {
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select a workspace folder to preview with ORCA',
    });
    return picked?.uri.fsPath;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Preview with ORCA',
    title: 'Select a repo folder to preview',
  });
  return picked?.[0]?.fsPath;
}

/**
 * Adapt ORCA's structured Logger onto the output channel. When `report` is given
 * (the full run), info/warn messages also drive the progress notification, so its
 * label tracks the current phase.
 */
function outputChannelLogger(
  channel: vscode.OutputChannel,
  report?: (message: string) => void
): Logger {
  const line =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix =
        meta !== undefined && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      channel.appendLine(`[${level}] ${message}${suffix}`);
      if (report !== undefined && (level === 'info' || level === 'warn')) report(message);
    };
  return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
}

/** A Writable that appends the pipeline's stdout-style output to the channel. */
function outputChannelWritable(channel: vscode.OutputChannel): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      channel.append(chunk.toString());
      callback();
    },
  });
}
