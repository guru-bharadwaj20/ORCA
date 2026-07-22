import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = ['dist', 'coverage', '.orca', 'tmp', 'vscode-extension/dist'];

await Promise.all(targets.map((t) => rm(`${root}${t}`, { recursive: true, force: true })));

console.log(`Cleaned: ${targets.join(', ')}`);
