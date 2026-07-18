/**
 * Build a distributable .vsix from a staging copy OUTSIDE the npm workspace.
 *
 * Why: inside the workspace, `orca-agent-cli@^0.1.0` is satisfied by the local
 * workspace symlink (node_modules/orca-agent-cli -> ..), which vsce follows and
 * then tries to pack the entire repo. Staging in a temp dir forces npm to install
 * the real published package from the registry, so the .vsix ships exactly what
 * users get.
 *
 * Usage: node scripts/package-vsix.mjs   (from vscode-extension/, or via npm run package)
 * Output: vscode-extension/orca-vscode.vsix
 */
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = resolve(fileURLToPath(import.meta.url), '..', '..');
const stage = mkdtempSync(join(tmpdir(), 'orca-vsix-'));
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

try {
  // Stage everything vsce needs except artifacts npm/esbuild will recreate.
  const skip = new Set(['node_modules', 'dist', 'orca-vscode.vsix']);
  for (const entry of readdirSync(extDir)) {
    if (skip.has(entry)) continue;
    cpSync(join(extDir, entry), join(stage, entry), { recursive: true });
  }

  run('npm install', stage); // real orca-agent-cli from the registry
  run('npm run build', stage); // fresh dist/extension.js + media
  run('npx vsce package -o orca-vscode.vsix', stage);

  cpSync(join(stage, 'orca-vscode.vsix'), join(extDir, 'orca-vscode.vsix'));
  console.log(`\nPackaged: ${join(extDir, 'orca-vscode.vsix')}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
