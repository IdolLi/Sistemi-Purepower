/** Minimal structured logger (no dependency, level controlled by LOG_LEVEL). */
import { format } from 'node:util';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const current = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;

function emit(level, args) {
  if (LEVELS[level] < current) return;
  const ts = new Date().toISOString();
  const decorated = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (a !== null && typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    return a;
  });
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${format(...decorated)}`;
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

export default logger;
