/**
 * The ORCA terminal theme: one place for the palette and the low-level ANSI used
 * by the interactive menu (black panel, orange heading, soft accents in white).
 *
 * STAGE: 7 (cli) — REAL code (presentation only).
 * Inputs: none.
 * Outputs: chalk styling helpers + raw ANSI screen-control strings.
 */

import chalk from 'chalk';

/** ORCA palette — pink headline, teal pointer, soft neutrals on black. */
export const theme = {
  /** The headline colour: the ORCA banner + primary accents. */
  pink: chalk.hex('#FF6FB5'),
  /** A muted pink for section dividers so they recede behind the items. */
  pinkDim: chalk.hex('#B5527F'),
  /** The selection colour: pointer + highlighted item. */
  teal: chalk.hex('#57C7B8'),
  /** Primary body text. */
  white: chalk.hex('#F2F2F2'),
  /** Secondary text: hints, descriptions, the created-by line. */
  soft: chalk.hex('#9AA6B2'),
  /** Success / go states. */
  green: chalk.hex('#8FD694'),
  /** Warning / attention states. */
  yellow: chalk.hex('#E8C979'),
} as const;

/**
 * Screen-control sequences. We set a black background once (`\x1b[40m`) and clear
 * the whole display so the empty cells are black too, giving the solid panel look
 * without measuring every line's visible width. chalk's colour closers only reset
 * the foreground, so the black background persists across styled text.
 */
export const screen = {
  /** Set bg black, erase display + scrollback, move cursor home. */
  reset: '\x1b[40m\x1b[2J\x1b[3J\x1b[H',
  /** Hide / show the cursor while a menu is drawing. */
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  /** Fully clear all styling — call once when leaving the interactive UI. */
  clearStyle: '\x1b[0m',
} as const;
