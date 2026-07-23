import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mermaidDir = dirname(require.resolve('mermaid'));
const src = join(mermaidDir, 'mermaid.min.js');

const extRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(extRoot, 'media', 'mermaid.min.js');

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`copied mermaid → ${dest}`);
