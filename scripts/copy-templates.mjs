import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await cp(`${root}src/templates`, `${root}dist/templates`, {
  recursive: true,
  filter: (src) => !/\.(ts|js|map)$/.test(src),
});
