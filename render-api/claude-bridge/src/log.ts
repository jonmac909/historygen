// Structured, metadata-only logging. Never logs prompt bodies or image data
// (gap #29). Every line is prefixed so operators can filter Railway logs.

type LogFields = Record<string, string | number | boolean | null | undefined>;

function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields) {
  const out: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    svc: 'bridge',
    msg,
  };
  if (fields) Object.assign(out, fields);
  console[level === 'error' ? 'error' : 'log'](`[bridge] ${JSON.stringify(out)}`);
}

export const log = {
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};
