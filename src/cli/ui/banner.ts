import { theme } from './theme.js';

const WORDMARK = [
  ' ██████╗ ██████╗  ██████╗ █████╗ ',
  '██╔═══██╗██╔══██╗██╔════╝██╔══██╗',
  '██║   ██║██████╔╝██║     ███████║',
  '██║   ██║██╔══██╗██║     ██╔══██║',
  '╚██████╔╝██║  ██║╚██████╗██║  ██║',
  ' ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝',
];

export function renderBanner(version: string): string {
  const art = WORDMARK.map((line) => `  ${theme.pink(line)}`).join('\n');
  return [
    '',
    art,
    '',
    `  ${theme.pink.bold('ORCA')} ${theme.soft(`v${version}`)}  ${theme.soft('·')}  ${theme.white('Orchestrated Repository Comprehension Agent')}`,
    `  ${theme.soft('Clone a messy repo → detect the stack → approve the plan → containerize & self-heal.')}`,
    '',
  ].join('\n');
}
