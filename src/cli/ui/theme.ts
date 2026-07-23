import chalk from 'chalk';

export const theme = {
  pink: chalk.hex('#FF6FB5'),
  pinkDim: chalk.hex('#B5527F'),
  teal: chalk.hex('#57C7B8'),
  white: chalk.hex('#F2F2F2'),
  soft: chalk.hex('#9AA6B2'),
  green: chalk.hex('#8FD694'),
  yellow: chalk.hex('#E8C979'),
} as const;

export const screen = {
  reset: '\x1b[40m\x1b[2J\x1b[3J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  clearStyle: '\x1b[0m',
} as const;
