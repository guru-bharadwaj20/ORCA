/**
 * The concrete logger implementation behind the `Logger` interface in core/context.
 * Provides leveled, optionally-colored structured logging for the CLI.
 *
 * STAGE: utils (shared) — REAL code.
 * Inputs: log level + message + optional metadata.
 * Outputs: formatted lines to stderr (stdout is reserved for pipeline output such as
 * the plan and the --dry-run compose preview, so it stays cleanly pipeable).
 */

import chalk from 'chalk';

import type { Logger, LogLevel } from '../core/context.js';

/** Numeric ordering so a minimum level can gate emission. */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Per-level label colorizers (chalk self-disables on non-TTY streams). */
const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

/** One formatted line: padded level label, message, compact JSON meta when present. */
function formatLine(
  level: LogLevel,
  message: string,
  meta: Record<string, unknown> | undefined,
  useColor: boolean
): string {
  const label = level.padEnd(5);
  const colored = useColor ? LEVEL_COLOR[level](label) : label;
  const suffix =
    meta !== undefined && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `${colored} ${message}${suffix}\n`;
}

/**
 * Build a `Logger` that emits everything at or above `minLevel`. The output stream is
 * injectable for tests; it defaults to stderr.
 */
export function createLogger(
  minLevel: LogLevel,
  useColor: boolean = true,
  stream: NodeJS.WritableStream = process.stderr
): Logger {
  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    stream.write(formatLine(level, message, meta, useColor));
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}
