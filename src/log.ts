export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

/** Structured JSON lines on stdout, which is what Railway collects. */
export function createLogger(
  level: LogLevel = 'info',
  bound: LogFields = {},
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (order[lvl] < order[level]) return;
    const merged: LogFields = { ...bound, ...fields };
    if ('err' in merged) merged.err = serializeError(merged.err);
    write(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg, ...merged }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger(level, { ...bound, ...fields }, write),
  };
}

export const silentLogger: Logger = createLogger('error', {}, () => {});
