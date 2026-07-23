import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = resolve(fileURLToPath(import.meta.url), '..', '..');
const stage = mkdtempSync(join(tmpdir(), 'orca-vsix-'));
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

try {
  const skip = new Set(['node_modules', 'dist', 'orca-vscode.vsix']);
  for (const entry of readdirSync(extDir)) {
    if (skip.has(entry)) continue;
    cpSync(join(extDir, entry), join(stage, entry), { recursive: true });
  }

  run('npm install', stage);
  run('npm run build', stage);
  run('npx vsce package -o orca-vscode.vsix', stage);

  cpSync(join(stage, 'orca-vscode.vsix'), join(extDir, 'orca-vscode.vsix'));
  console.log(`\nPackaged: ${join(extDir, 'orca-vscode.vsix')}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
