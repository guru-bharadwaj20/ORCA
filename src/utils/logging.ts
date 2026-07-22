import chalk from 'chalk';

import type { Logger, LogLevel } from '../core/context.js';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

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
