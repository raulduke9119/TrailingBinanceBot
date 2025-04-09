export class Logger {
  constructor(level = 'info') {
    this.level = level;
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };
  }

  shouldLog(messageLevel) {
    return this.levels[messageLevel] <= this.levels[this.level];
  }

  error(...args) {
    if (this.shouldLog('error')) {
      console.error(new Date().toISOString(), '[ERROR]', ...args);
    }
  }

  warn(...args) {
    if (this.shouldLog('warn')) {
      console.warn(new Date().toISOString(), '[WARN]', ...args);
    }
  }

  info(...args) {
    if (this.shouldLog('info')) {
      console.info(new Date().toISOString(), '[INFO]', ...args);
    }
  }

  debug(...args) {
    if (this.shouldLog('debug')) {
      console.debug(new Date().toISOString(), '[DEBUG]', ...args);
    }
  }
}