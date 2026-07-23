const path = require('node:path');
const Module = require('node:module');

const extDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extDir, '..');
const bundlePath = path.join(extDir, 'dist', 'extension.js');
const mernPath = path.join(repoRoot, 'examples', 'mern-sample');

let buf = '';
const messages = { info: [], error: [] };
let panels = [];

const channel = {
  append: (s) => (buf += s),
  appendLine: (s) => (buf += s + '\n'),
  clear: () => (buf = ''),
  show: () => {},
  dispose: () => {},
};
const fakeUri = (fsPath) => ({ fsPath, path: fsPath, toString: () => `file://${fsPath}` });
const registered = {};

const fakeVscode = {
  ViewColumn: { Active: -1 },
  Uri: { joinPath: (base, ...parts) => fakeUri([base.fsPath, ...parts].join('/')) },
  window: {
    createOutputChannel: () => channel,
    showInformationMessage: (m) => (messages.info.push(m), Promise.resolve(undefined)),
    showErrorMessage: (m) => (messages.error.push(m), Promise.resolve(undefined)),
    showWorkspaceFolderPick: () => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    createWebviewPanel: () => {
      const msg = [];
      const disp = [];
      let disposed = false;
      const panel = {
        webview: {
          cspSource: 'vscode-resource:',
          _html: '',
          get html() {
            return this._html;
          },
          set html(v) {
            this._html = v;
          },
          asWebviewUri: (uri) => ({ toString: () => `vscode-resource://${uri.fsPath}` }),
          onDidReceiveMessage: (cb) => (msg.push(cb), { dispose() {} }),
          postMessage: () => Promise.resolve(true),
        },
        onDidDispose: (cb) => (disp.push(cb), { dispose() {} }),
        reveal: () => {},
        dispose: () => {
          if (disposed) return;
          disposed = true;
          disp.forEach((h) => h());
        },
        _emit: (m) => msg.forEach((h) => h(m)),
        _ready: () => msg.length > 0 && disp.length > 0,
      };
      panels.push(panel);
      return panel;
    },
  },
  commands: { registerCommand: (id, cb) => ((registered[id] = cb), { dispose() {} }) },
  workspace: {
    workspaceFolders: [{ uri: fakeUri(mernPath), name: 'mern-sample', index: 0 }],
    getConfiguration: () => ({ inspect: () => undefined, get: () => undefined }),
  },
};

const orig = Module._load;
Module._load = (r, p, m) => (r === 'vscode' ? fakeVscode : orig.call(Module, r, p, m));

const waitFor = async (pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
};

(async () => {
  const ext = require(bundlePath);
  const secrets = {
    get: () => Promise.resolve(undefined),
    store: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
  ext.activate({ subscriptions: [], extensionUri: fakeUri(extDir), secrets });

  const done = registered['orca.previewRepo']();
  await waitFor(() => panels.length > 0 && panels[panels.length - 1]._ready());
  panels[panels.length - 1]._emit({ type: 'approve' });
  await done;

  const checks = {
    'plan webview rendered (diagram source)': /flowchart LR/.test(panels[0].webview.html),
    'compose preview in channel': buf.includes('# --- docker-compose.yml (preview) ---'),
    'dry-run completed': buf.includes('Dry run complete'),
    'success toast': messages.info.some((m) => /preview complete/i.test(m)),
    'no error toast': messages.error.length === 0,
  };

  let ok = true;
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    ok = ok && pass;
  }
  console.log(ok ? '\nPREVIEW SMOKE: PASS' : '\nPREVIEW SMOKE: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE ERROR:', e);
  process.exit(1);
});
