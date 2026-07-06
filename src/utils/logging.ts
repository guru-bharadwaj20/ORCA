/**
 * The concrete logger implementation behind the `Logger` interface in core/context.
 * Provides leveled, optionally-colored structured logging for the CLI.
 *
 * STAGE: utils (shared)
 * Inputs: log level + message + optional metadata.
 * Outputs: formatted lines to stdout/stderr.
 */

import type { Logger, LogLevel } from '../core/context.js';

// TODO(stage-utils): build a Logger that respects the min level and optional colors.
export function createLogger(_minLevel: LogLevel, _useColor?: boolean): Logger {
  throw new Error('not implemented');
}
