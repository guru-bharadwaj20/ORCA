/**
 * The ORCA plan approval webview — the headline "approve-before-build" gate, done
 * natively. Renders the service-graph as a Mermaid diagram (from the bundled
 * media/mermaid.min.js, never a CDN) next to a service table, with Approve / Reject
 * buttons. Wired into the pipeline as the Phase 1 `approvePlan` hook.
 *
 * The returned promise ALWAYS settles: a button click resolves it, and a panel
 * disposed without a decision resolves a rejected `ReviewOutcome` — so the pipeline
 * takes its normal PLAN_REJECTED path instead of hanging on an open promise.
 */

import type { ReviewOutcome, ServiceNode, ServicePlan } from 'orca-agent-cli/plan';
import * as vscode from 'vscode';

// `orca-agent-cli` is ESM and kept external (see extension.ts); load the diagram renderer
// at runtime rather than bundling it.
const loadDiagram = async (): Promise<(plan: ServicePlan) => string> =>
  (await import('orca-agent-cli/plan')).renderDiagram;

/** Messages the webview posts back to the extension. */
interface DecisionMessage {
  type: 'approve' | 'reject';
}

/**
 * Show the plan approval panel and resolve with the user's decision. Resolves a
 * rejected outcome if the panel is closed without deciding (never leaves the pipeline
 * waiting).
 */
export async function approvePlanViaWebview(
  context: vscode.ExtensionContext,
  plan: ServicePlan
): Promise<ReviewOutcome> {
  const renderDiagram = await loadDiagram();
  const panel = vscode.window.createWebviewPanel(
    'orcaPlan',
    `ORCA plan — ${plan.projectName}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    }
  );

  return await new Promise<ReviewOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ReviewOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
      panel.dispose();
    };

    panel.webview.onDidReceiveMessage((message: DecisionMessage) => {
      if (message.type === 'approve') {
        settle({ approved: true, plan });
      } else if (message.type === 'reject') {
        settle({ approved: false, plan, reason: 'rejected in the ORCA plan view' });
      }
    });

    panel.onDidDispose(() => {
      // Closed without a decision → reject so the pipeline doesn't hang.
      if (!settled) {
        settled = true;
        resolve({ approved: false, plan, reason: 'plan view closed without a decision' });
      }
    });

    panel.webview.html = renderPlanHtml(
      panel.webview,
      context.extensionUri,
      plan,
      renderDiagram(plan)
    );
  });
}

/** Build the full webview HTML: CSP, bundled mermaid, the diagram, the table, buttons. */
function renderPlanHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  plan: ServicePlan,
  diagramSource: string
): string {
  const nonce = makeNonce();
  const mermaidUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'mermaid.min.js')
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  // The diagram source is handed to mermaid via JS (not HTML) to avoid any markup
  // injection; `<` is escaped so it can't break out of the <script> element.
  const diagramJson = JSON.stringify(diagramSource).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ORCA plan</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 1rem 6rem; }
    h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.5rem; }
    .sub { color: var(--vscode-descriptionForeground); margin-top: -0.4rem; }
    .grid { display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: flex-start; }
    .diagram { flex: 1 1 320px; min-width: 300px; overflow: auto; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 1rem; }
    .diagram svg { max-width: 100%; height: auto; }
    table { border-collapse: collapse; flex: 1 1 320px; }
    th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.85rem; vertical-align: top; }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    code { color: var(--vscode-textPreformat-foreground); }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 0.75rem; justify-content: flex-end; padding: 0.75rem 1.25rem; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
    button { font-family: inherit; font-size: 0.9rem; padding: 0.45rem 1.1rem; border: none; border-radius: 4px; cursor: pointer; }
    .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .reject { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:disabled { opacity: 0.5; cursor: default; }
    .err { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h1>ORCA plan — ${escapeHtml(plan.projectName)}</h1>
  <p class="sub">Source: ${escapeHtml(plan.source)} · nothing is built or written until you approve.</p>
  <div class="grid">
    <div class="diagram"><div id="diagram">Rendering diagram…</div></div>
    <table>
      <thead><tr><th>Service</th><th>Kind</th><th>Source</th><th>Ports</th><th>Depends on</th></tr></thead>
      <tbody>${plan.services.map(serviceRow).join('')}</tbody>
    </table>
  </div>
  <div class="bar">
    <button class="reject" id="reject">Reject</button>
    <button class="approve" id="approve">Approve &amp; continue</button>
  </div>

  <script nonce="${nonce}" src="${mermaidUri.toString()}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', flowchart: { useMaxWidth: true } });
    mermaid.render('orcaGraph', ${diagramJson})
      .then(({ svg }) => { document.getElementById('diagram').innerHTML = svg; })
      .catch((e) => { const d = document.getElementById('diagram'); d.className = 'err'; d.textContent = 'Diagram failed to render: ' + (e && e.message ? e.message : e); });

    let decided = false;
    const decide = (type) => {
      if (decided) return;
      decided = true;
      document.getElementById('approve').disabled = true;
      document.getElementById('reject').disabled = true;
      vscode.postMessage({ type });
    };
    document.getElementById('approve').addEventListener('click', () => decide('approve'));
    document.getElementById('reject').addEventListener('click', () => decide('reject'));
  </script>
</body>
</html>`;
}

/** One <tr> for a service, mirroring the CLI's plan table columns. */
function serviceRow(node: ServiceNode): string {
  const source =
    node.source.type === 'image'
      ? `<code>${escapeHtml(node.source.image)}</code>`
      : `build ${escapeHtml(node.source.context)}`;
  const ports = node.ports.map((p) => `${p.host}:${p.container}`).join(', ') || '—';
  const deps =
    node.dependsOn
      .map((d) => `${escapeHtml(d.serviceId)} (${escapeHtml(d.condition)})`)
      .join(', ') || '—';
  return `<tr><td>${escapeHtml(node.name)}</td><td>${escapeHtml(node.kind)}</td><td>${source}</td><td>${escapeHtml(ports)}</td><td>${deps}</td></tr>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
