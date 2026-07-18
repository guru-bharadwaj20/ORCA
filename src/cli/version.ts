/**
 * The single source of ORCA's own version: read live from package.json so the CLI
 * can never drift from what was published.
 *
 * STAGE: 7 (cli) — REAL code.
 * Inputs: none.
 * Outputs: the version string ('0.0.0' when package.json is unreadable).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The version from package.json (two levels up from src/cli and dist/cli alike). */
export function packageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
