/**
 * core/log.ts — stderr-only structured logger.
 *
 * stdout is reserved for the CLI's machine-readable output (NDJSON events /
 * `--json`). Diagnostics go to stderr so `orchestrator run ... --json | jq`
 * always works on Windows too, where stdout/stderr are separate handles.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let current: LogLevel = 'warn';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function emit(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[current] < ORDER[level]) return;
  const tag = level.toUpperCase().padEnd(5);
  let line = `[${tag}] ${msg}`;
  if (fields && Object.keys(fields).length) {
    line += ' ' + JSON.stringify(fields);
  }
  process.stderr.write(line + '\n');
}

export const log = {
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
};
