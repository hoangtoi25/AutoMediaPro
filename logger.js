/**
 * logger.js — Colored console logger for AutoMediaPro.
 */

import chalk from 'chalk';

const timestamp = () => {
  const d = new Date();
  return chalk.gray(
    `[${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}]`
  );
};

export const log = {
  info:    (...args) => console.log(timestamp(), chalk.cyan('ℹ'), ...args),
  success: (...args) => console.log(timestamp(), chalk.green('✅'), ...args),
  warn:    (...args) => console.log(timestamp(), chalk.yellow('⚠️'), ...args),
  error:   (...args) => console.log(timestamp(), chalk.red('❌'), ...args),
  prompt:  (idx, text) => console.log(timestamp(), chalk.magenta(`🎨 [${idx}]`), chalk.white(text.substring(0, 80) + (text.length > 80 ? '...' : ''))),
  download: (...args) => console.log(timestamp(), chalk.blue('📥'), ...args),
  step:    (...args) => console.log(timestamp(), chalk.gray('  →'), ...args),
};
