/**
 * Structured JSON logger with log levels.
 * Set LOG_LEVEL env var to: debug | info | warn | error (default: info)
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 1;

function log(level, message, meta) {
  if (LOG_LEVELS[level] < currentLevel) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    msg: message
  };
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    Object.assign(entry, meta);
  }
  const output = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

module.exports = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
