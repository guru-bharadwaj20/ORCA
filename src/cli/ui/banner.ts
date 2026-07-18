/**
 * The ORCA splash banner: the ASCII wordmark + tagline shown atop the interactive
 * menu. Pure string building — no I/O, no side effects.
 *
 * STAGE: 7 (cli) — REAL code (presentation only).
 * Inputs: an optional version string.
 * Outputs: a ready-to-print, coloured banner block.
 */

import { theme } from './theme.js';

/** The ORCA wordmark (figlet "ANSI Shadow"). */
const WORDMARK = [
  ' ██████╗ ██████╗  ██████╗ █████╗ ',
  '██╔═══██╗██╔══██╗██╔════╝██╔══██╗',
  '██║   ██║██████╔╝██║     ███████║',
  '██║   ██║██╔══██╗██║     ██╔══██║',
  '╚██████╔╝██║  ██║╚██████╗██║  ██║',
  ' ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝',
];

/**
 * Build the coloured banner: orange wordmark, version + tagline beneath it in soft
 * neutrals. The caller prints it on the already-black screen panel.
 */
export function renderBanner(version: string): string {
  const art = WORDMARK.map((line) => `  ${theme.orange(line)}`).join('\n');
  return [
    '',
    art,
    '',
    `  ${theme.orange.bold('ORCA')} ${theme.soft(`v${version}`)}  ${theme.soft('·')}  ${theme.white('Orchestrated Repository Comprehension Agent')}`,
    `  ${theme.soft('Clone a messy repo → detect the stack → approve the plan → containerize & self-heal.')}`,
    '',
  ].join('\n');
}
