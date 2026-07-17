// Copies the Handlebars templates into dist/ after tsc. render.ts resolves .hbs files
// relative to its own compiled location (dist/templates/render.js), so the templates
// must live alongside the compiled output or the published package cannot render.
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await cp(`${root}src/templates`, `${root}dist/templates`, {
  recursive: true,
  // Keep directories and .hbs assets; the compiled .js/.d.ts are already in dist.
  filter: (src) => !/\.(ts|js|map)$/.test(src),
});
