/**
 * Copy Mermaid's standalone browser build into the extension's media/ folder so the
 * plan webview can load it locally. Webview CSP + offline use rule out a CDN, so the
 * asset ships inside the extension (and the .vsix). Run as part of the build.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Resolve mermaid's on-disk location (works whether hoisted to the root node_modules
// or nested), then grab its minified standalone (UMD) bundle next to the entry.
const mermaidDir = dirname(require.resolve('mermaid'));
const src = join(mermaidDir, 'mermaid.min.js');

const extRoot = dirname(dirname(fileURLToPath(import.meta.url))); // vscode-extension/
const dest = join(extRoot, 'media', 'mermaid.min.js');

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`copied mermaid → ${dest}`);
