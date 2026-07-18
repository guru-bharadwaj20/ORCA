/**
 * ORCA VS Code extension.
 *
 * The "ORCA: Preview Repo (Dry Run)" command picks a folder → builds a keyless
 * RunContext → runs the real `orca-cli` pipeline in dry-run mode → streams its logs
 * and generated-config preview into an ORCA output channel. The approval gate (Phase
 * 4) is a native webview: the pipeline pauses at the plan, shows the service diagram +
 * table, and only proceeds once the user approves. Dry run needs no API keys and no
 * Docker, so this runs anywhere the Extension Development Host does.
 *
 * All the real work lives in `orca-cli`; this file is only editor glue.
 */

import { Writable } from 'node:stream';

import type { Logger } from 'orca-cli';
import * as vscode from 'vscode';

import { approvePlanViaWebview } from './planWebview.js';

// `orca-cli` is ESM (and reads its `.hbs` templates relative to its own on-disk
// location), so it is kept external and loaded at runtime via dynamic import rather
// than bundled into this CommonJS extension.
type OrcaCli = typeof import('orca-cli');
const loadOrca = (): Promise<OrcaCli> => import('orca-cli');

/** Command id, kept in sync with `contributes.commands` in package.json. */
const PREVIEW_COMMAND = 'orca.previewRepo';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('ORCA');
  context.subscriptions.push(
    channel,
    vscode.commands.registerCommand(PREVIEW_COMMAND, () => previewRepo(context, channel))
  );
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
    const { createRunContext, runPipeline } = await loadOrca();
    const ctx = createRunContext({
      repoUrl: folder,
      workspaceDir: '',
      logger: outputChannelLogger(channel),
      options: { dryRun: true },
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

/** True for the pipeline's typed "plan rejected at the gate" error. */
function isPlanRejected(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'PLAN_REJECTED'
  );
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

/** Adapt ORCA's structured Logger onto the output channel. */
function outputChannelLogger(channel: vscode.OutputChannel): Logger {
  const line =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      const suffix =
        meta !== undefined && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      channel.appendLine(`[${level}] ${message}${suffix}`);
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
